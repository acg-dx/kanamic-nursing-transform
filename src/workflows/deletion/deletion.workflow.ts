/**
 * 削除ワークフロー — 削除Sheetのレコードを HAM から削除する
 *
 * フロー:
 *   1. 削除Sheet から未処理レコードを取得
 *   2. 各レコードについて:
 *      a. HAM にログイン
 *      b. 業務ガイド → 利用者検索 (k2_1)
 *      c. 年月設定 → 患者検索 → 患者特定 → k2_2 へ遷移
 *      d. k2_2 で対象日付 + 開始時刻の行を特定
 *      e. 削除ボタン (confirmDelete) をクリック → 上書き保存
 *      f. 削除Sheet N列を「削除済み」に更新
 *
 * 削除Sheetの列構成:
 *   A: ID, B: タイムスタンプ, C: 更新日時, D: 従業員番号, E: 記録者,
 *   F: あおぞらID, G: 利用者, H: 日付, I: 開始時刻, J: 終了時刻,
 *   K: 支援区分1, L: 支援区分2, M: 完了ステータス, N: 削除ステータス（書き込み先）
 */
import { BaseWorkflow } from '../base-workflow';
import { logger } from '../../core/logger';
import { withRetry } from '../../core/retry-manager';
import { CJK_VARIANT_MAP_SERIALIZABLE } from '../../core/cjk-normalize';
import { toHamDate, toHamMonthStart } from '../../services/time-utils';
import type { HamNavigator } from '../../core/ham-navigator';
import type { WorkflowContext, WorkflowResult, WorkflowError } from '../../types/workflow.types';
import type { DeletionRecord } from '../../types/spreadsheet.types';
import type { SheetLocation } from '../../types/config.types';

const WORKFLOW_NAME = 'deletion';

export class DeletionWorkflow extends BaseWorkflow {
  async run(context: WorkflowContext): Promise<WorkflowResult[]> {
    const locations = context.locations || [];
    const results: WorkflowResult[] = [];

    for (const location of locations) {
      const result = await this.executeWithTiming(() =>
        this.processLocation(location, context.dryRun)
      );
      results.push(result);
    }

    return results;
  }

  private async processLocation(location: SheetLocation, dryRun: boolean): Promise<WorkflowResult> {
    logger.info(`削除処理開始: ${location.name}`);
    const errors: WorkflowError[] = [];
    let processedRecords = 0;

    const records = await this.sheets.getDeletionRecords(location.sheetId);
    // N列が「削除済み」または「削除不要」以外のレコードを対象とする
    const targets = records.filter(r =>
      r.recordId &&
      !r.completionStatus.includes('削除済み') &&
      !r.completionStatus.includes('削除不要')
    );

    logger.info(`${location.name}: 削除対象 ${targets.length}/${records.length}件`);

    if (targets.length === 0) {
      return {
        workflowName: WORKFLOW_NAME,
        locationName: location.name,
        success: true,
        totalRecords: records.length,
        processedRecords: 0,
        errorRecords: 0,
        errors: [],
        duration: 0,
      };
    }

    // HAM にログイン
    const nav = await this.auth.ensureLoggedIn();

    for (const record of targets) {
      if (dryRun) {
        logger.info(`[DRY RUN] 削除スキップ: ${record.recordId} - ${record.patientName} (${record.visitDate} ${record.startTime})`);
        processedRecords++;
        continue;
      }

      try {
        await withRetry(
          () => this.processRecord(record, nav, location.sheetId),
          `削除[${record.recordId}]`,
          { maxAttempts: 3, baseDelay: 2000, maxDelay: 10000, backoffMultiplier: 2 }
        );
        processedRecords++;
      } catch (error) {
        const err = error as Error;
        await this.sheets.updateDeletionStatus(
          location.sheetId,
          record.rowIndex,
          'エラー：システム'
        ).catch(e => logger.error(`削除ステータス更新失敗: ${(e as Error).message}`));

        errors.push({
          recordId: record.recordId,
          message: err.message,
          category: 'system',
          recoverable: true,
          timestamp: new Date().toISOString(),
        });
        logger.error(`削除エラー [${record.recordId}]: ${err.message}`);

        // エラー後にメインメニューへ復帰を試みる
        await this.tryRecoverToMainMenu(nav);
      }
    }

    return {
      workflowName: WORKFLOW_NAME,
      locationName: location.name,
      success: errors.length === 0,
      totalRecords: records.length,
      processedRecords,
      errorRecords: errors.length,
      errors,
      duration: 0,
    };
  }

  /**
   * 1レコード分の削除処理
   *
   * Step 1: メインメニュー → 業務ガイド → 利用者検索 (k2_1)
   * Step 2: 年月設定 → 全患者検索
   * Step 3: 患者特定 → k2_2 へ遷移
   * Step 4: k2_2 で対象スケジュール行を特定して削除ボタンクリック
   * Step 5: 上書き保存
   * Step 6: 削除Sheet N列を「削除済み」に更新
   */
  private async processRecord(
    record: DeletionRecord,
    nav: HamNavigator,
    sheetId: string,
  ): Promise<void> {
    logger.info(`削除開始: ${record.recordId} - ${record.patientName} (${record.visitDate} ${record.startTime})`);

    // === Step 1: メインメニュー → 業務ガイド → 利用者検索 ===
    await this.auth.navigateToBusinessGuide();
    await this.auth.navigateToUserSearch();
    logger.debug('Step 1: 利用者検索に遷移');

    // === Step 2: 年月設定 → 全患者検索 ===
    const monthStart = toHamMonthStart(record.visitDate);
    await nav.setSelectValue('searchdate', monthStart);
    await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_1' });
    await this.sleep(1000);
    logger.debug(`Step 2: 患者検索実行 (${monthStart})`);

    // === Step 3: 患者特定 → k2_2 へ遷移 ===
    const patientId = await this.findPatientId(nav, record.patientName);
    if (!patientId) {
      throw new Error(`患者が見つかりません: ${record.patientName}（マスタ不備の可能性）`);
    }
    logger.debug(`Step 3: 患者ID検出 → ${patientId}`);

    const k2_1Frame = await nav.getMainFrame('k2_1');
    await k2_1Frame.evaluate((pid) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      const form = document.forms[0];
      if (!form) throw new Error('k2_1 form not found');
      if (typeof win.submitTargetFormEx === 'function') {
        win.submitTargetFormEx(form, 'k2_2', form.careuserid, pid);
      } else {
        win.submited = 0;
        form.careuserid.value = pid;
        form.doAction.value = 'k2_2';
        form.target = 'mainFrame';
        form.submit();
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }, patientId);

    await nav.waitForMainFrame('k2_2', 15000);
    await this.sleep(1000);
    await this.checkForSyserror(nav);
    logger.debug(`Step 3: 月間スケジュールに遷移完了 (患者ID=${patientId})`);

    // === Step 4: k2_2 で対象スケジュール行を特定して削除ボタンクリック ===
    const visitDateHam = toHamDate(record.visitDate);
    const deleted = await this.deleteSchedule(nav, visitDateHam, record.startTime);

    if (!deleted) {
      // HAM に該当スケジュールが存在しない → 削除不要として完了扱い
      logger.warn(`削除対象スケジュールが見つかりません: ${record.patientName} ${record.visitDate} ${record.startTime} → 削除不要として完了`);
      await this.sheets.updateDeletionStatus(sheetId, record.rowIndex, '削除不要');
      await this.auth.navigateToMainMenu();
      return;
    }

    // === Step 5: 上書き保存 ===
    await nav.submitForm({
      action: 'act_update',
      setLockCheck: true,
      waitForPageId: 'k2_2',
    });
    await this.sleep(2000);
    logger.debug('Step 5: 上書き保存完了');

    // === Step 6: 削除Sheet N列を「削除済み」に更新 ===
    await this.sheets.updateDeletionStatus(sheetId, record.rowIndex, '削除済み');
    logger.info(`削除完了: ${record.recordId} - ${record.patientName} (${record.visitDate} ${record.startTime})`);

    // === Step 7: 月次シートから対象行を削除 ===
    const monthTab = this.visitDateToMonthTab(record.visitDate);
    if (monthTab) {
      const rowDeleted = await this.sheets.deleteRowByRecordId(sheetId, monthTab, record.recordId);
      if (rowDeleted) {
        logger.info(`月次シート行削除完了: ${record.recordId} (tab=${monthTab})`);
      } else {
        logger.warn(`月次シートに行が見つかりません: ${record.recordId} (tab=${monthTab})`);
      }
    } else {
      logger.warn(`月次シートタブ名を特定できません: visitDate=${record.visitDate}`);
    }

    // メインメニューに戻る（次のレコード用）
    await this.auth.navigateToMainMenu();
  }

  /**
   * k2_2 で指定日付 + 開始時刻のスケジュール行を特定して削除ボタンをクリック
   *
   * k2_2 HTML 構造:
   *   削除ボタン: <input name="act_delete" type="button" value="削除"
   *               onclick="confirmDelete('{assignid}', '{record2flag}');">
   *   行テキスト例: "25日  火  11:30 ～ 12:00  訪問看護..."
   *
   * record2flag = '1' の場合は記録書IIが存在するため削除不可（エラーとして扱う）
   *
   * @returns true: 削除ボタンをクリックした（上書き保存が必要）
   *          false: 対象行が見つからない（削除不要として扱う）
   */
  private async deleteSchedule(
    nav: HamNavigator,
    visitDateHam: string,
    startTime: string,
  ): Promise<boolean> {
    const frame = await nav.getMainFrame('k2_2');
    const dayNum = parseInt(visitDateHam.substring(6, 8));
    const dayDisplay = `${dayNum}日`;

    const deleteInfo = await frame.evaluate(({ dd, st }) => {
      // 部分一致を防止: "1日" が "11日","21日","31日" にマッチしないよう正規表現で判定
      const dayRegex = new RegExp(`(?:^|[^0-9])${parseInt(dd)}日`);
      const rows = Array.from(document.querySelectorAll('tr'));
      for (const row of rows) {
        const rowText = row.textContent || '';
        if (!dayRegex.test(rowText)) continue;
        if (!rowText.includes(st)) continue;

        const delBtn = row.querySelector('input[name="act_delete"][value="削除"]') as HTMLInputElement | null;
        if (!delBtn) continue;

        const onclick = delBtn.getAttribute('onclick') || '';
        const m = onclick.match(/confirmDelete\(\s*'(\d+)'\s*,\s*'(\d+)'\s*\)/);
        if (!m) continue;

        return {
          found: true,
          assignid: m[1],
          record2flag: m[2],
          rowText: rowText.replace(/\s+/g, ' ').trim().substring(0, 100),
        };
      }
      return { found: false };
    }, { dd: dayDisplay, st: startTime });

    if (!deleteInfo.found) {
      logger.debug(`削除対象なし: ${dayDisplay} ${startTime}`);
      return false;
    }

    logger.info(`削除対象スケジュール検出: ${deleteInfo.rowText} (assignid=${deleteInfo.assignid})`);

    if (deleteInfo.record2flag === '1') {
      throw new Error(`記録書IIが存在するため削除不可: ${dayDisplay} ${startTime} (assignid=${deleteInfo.assignid})`);
    }

    // confirmDelete を Playwright native click で実行（confirm ダイアログは自動承認）
    const delBtn = await frame.$(`input[name="act_delete"][onclick*="confirmDelete('${deleteInfo.assignid}'"]`);
    if (delBtn) {
      await frame.evaluate(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (window as any).submited = 0;
        /* eslint-enable @typescript-eslint/no-explicit-any */
      });
      await delBtn.click();
      await this.sleep(2000);
    } else {
      // フォールバック: evaluate で confirmDelete 直接呼び出し
      await frame.evaluate((aid) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const win = window as any;
        win.submited = 0;
        if (typeof win.confirmDelete === 'function') {
          win.confirmDelete(aid, '0');
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
      }, deleteInfo.assignid);
      await this.sleep(2000);
    }

    logger.debug(`削除ボタンクリック完了: assignid=${deleteInfo.assignid}`);
    return true;
  }

  /**
   * k2_1 の検索結果から患者 ID (careuserid) を取得（患者名による検索）
   */
  private async findPatientId(nav: HamNavigator, patientName: string): Promise<string | null> {
    const frame = await nav.getMainFrame('k2_1');

    const result = await frame.evaluate((args: { name: string; variantMap: [string, string][] }) => {
      const careUserIdRegex = /careuserid\s*,\s*'(\d+)'/;
      const careUserIdRegex2 = /careuserid\.value\s*=\s*['"](\d+)['"]/;

      function extractCareUserId(html: string): string | null {
        const m1 = html.match(careUserIdRegex);
        if (m1) return m1[1];
        const m2 = html.match(careUserIdRegex2);
        if (m2) return m2[1];
        return null;
      }

      // NFKC + 旧字体→新字体（眞→真 等）で正規化
      function normalize(s: string): string {
        let r = s.normalize('NFKC');
        for (const [old, rep] of args.variantMap) {
          if (r.includes(old)) r = r.replaceAll(old, rep);
        }
        return r.replace(/[\s\u3000\u00a0]+/g, '').trim();
      }

      const normalizedName = normalize(args.name);

      // 決定ボタンの onclick から患者名でマッチ
      const allButtons = Array.from(document.querySelectorAll('input[name="act_result"][value="決定"]'));
      for (const btn of allButtons) {
        const tr = btn.closest('tr');
        if (!tr) continue;
        const rowText = normalize(tr.textContent || '');
        if (rowText.includes(normalizedName)) {
          const onclick = btn.getAttribute('onclick') || '';
          const id = extractCareUserId(onclick);
          if (id) return id;
        }
      }

      // フォールバック: HTML 行分割
      const body = document.body?.innerHTML || '';
      const rows = body.split('<tr');
      for (const row of rows) {
        const rowTextNorm = normalize(row.replace(/<[^>]*>/g, ''));
        if (rowTextNorm.includes(normalizedName)) {
          const id = extractCareUserId(row);
          if (id) return id;
        }
      }

      return null;
    }, { name: patientName, variantMap: CJK_VARIANT_MAP_SERIALIZABLE });

    if (result) {
      logger.debug(`患者ID検出: ${patientName} → ${result}`);
    }
    return result;
  }

  /**
   * syserror.jsp が表示されていないかチェック
   */
  private async checkForSyserror(nav: HamNavigator): Promise<void> {
    try {
      const allFrames = nav.hamPage.frames();
      for (const frame of allFrames) {
        const url = frame.url();
        if (url.includes('syserror.jsp') || url.includes('error/syserror')) {
          const content = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
          throw new Error(
            `HAM システムエラー検出 (syserror.jsp): ${content.substring(0, 200)}`
          );
        }
      }
    } catch (e) {
      if ((e as Error).message.includes('syserror.jsp')) throw e;
    }
  }

  /**
   * エラー後にメインメニューへ復帰を試みる
   */
  private async tryRecoverToMainMenu(nav: HamNavigator): Promise<void> {
    try {
      const allFrames = nav.hamPage.frames();
      for (const frame of allFrames) {
        if (frame.url().includes('syserror')) {
          await frame.evaluate(() => {
            const btn = document.querySelector('input[type="button"], button');
            if (btn) (btn as HTMLElement).click();
          }).catch(() => {});
          await this.sleep(1000);
          break;
        }
      }

      for (let i = 0; i < 5; i++) {
        const pageId = await nav.getCurrentPageId();
        if (!pageId || pageId === 't1-2') break;
        await nav.submitForm({ action: 'act_back' }).catch(() => {});
        await this.sleep(1000);
      }
    } catch {
      logger.warn('メインメニューへの復帰に失敗。次のレコードで再ログインを試みます');
      try {
        await this.auth.ensureLoggedIn();
      } catch {
        logger.error('再ログインにも失敗');
      }
    }
  }

  /**
   * visitDate (YYYY-MM-DD or YYYY/MM/DD) から月次タブ名 (e.g. "2026年02月") を生成する
   */
  private visitDateToMonthTab(visitDate: string): string {
    const normalized = visitDate.replace(/\//g, '-');
    const parts = normalized.split('-');
    if (parts.length < 2 || !parts[0] || !parts[1]) return '';
    return `${parts[0]}年${parts[1].padStart(2, '0')}月`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
