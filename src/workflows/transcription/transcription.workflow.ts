/**
 * 転記ワークフロー — HAM 多段フォーム操作による実績転記
 *
 * 完全フロー (14ステップ):
 *   1. t1-2 → k1_1 (訪問看護業務ガイド)
 *   2. k1_1 → k2_1 (利用者検索)
 *   3. k2_1: 年月設定 → 検索 → 患者特定
 *   4. k2_1 → k2_2 (月間スケジュール) via 決定ボタン
 *   5. k2_2: 追加ボタン → k2_3 (スケジュール追加)
 *   6. k2_3: 時間設定 → 次へ → k2_3a
 *   7. k2_3a: 保険種別切替 → サービスコード選択 → 次へ → k2_3b
 *   8. k2_3b: 決定 → k2_2 に戻る
 *   9. k2_2: 新規行の 配置ボタン → k2_2f (スタッフ配置)
 *  10. k2_2f: スタッフ・勤務時間設定 → 配置 → k2_2 に戻る
 *  11. k2_2: 緊急時加算チェック (必要な場合)
 *  12. k2_2: 上書き保存
 *  13. 保存結果検証
 *  14. Google Sheets ステータス更新 → 転記済み
 *
 * 介護+リハビリ → k2_7_1 (訪看I5入力) は別フロー
 */
import { BaseWorkflow } from '../base-workflow';
import { logger } from '../../core/logger';
import { withRetry } from '../../core/retry-manager';
import { ServiceCodeResolver } from '../../services/service-code-resolver';
import type { ServiceCodeResult } from '../../services/service-code-resolver';
import { getTimetype, getTimePeriod, parseTime, toHamDate, toHamMonthStart } from '../../services/time-utils';
import type { HamNavigator } from '../../core/ham-navigator';
import type { WorkflowContext, WorkflowResult, WorkflowError } from '../../types/workflow.types';
import type { TranscriptionRecord } from '../../types/spreadsheet.types';
import type { SheetLocation } from '../../types/config.types';

const WORKFLOW_NAME = 'transcription';

export class TranscriptionWorkflow extends BaseWorkflow {
  private resolver = new ServiceCodeResolver();

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
    logger.info(`転記処理開始: ${location.name}`);
    const errors: WorkflowError[] = [];
    let processedRecords = 0;

    const records = await this.sheets.getTranscriptionRecords(location.sheetId);
    const targets = records.filter(r => this.isTranscriptionTarget(r));

    logger.info(`${location.name}: 対象レコード ${targets.length}/${records.length}件`);

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
        logger.info(`[DRY RUN] 転記スキップ: ${record.recordId} - ${record.patientName}`);
        processedRecords++;
        continue;
      }

      try {
        await withRetry(
          () => this.processRecord(record, nav, location.sheetId),
          `転記[${record.recordId}]`,
          { maxAttempts: 2, baseDelay: 3000, maxDelay: 15000, backoffMultiplier: 2 }
        );
        processedRecords++;
      } catch (error) {
        const err = error as Error;
        const isMasterError = err.message.includes('マスタ') || err.message.includes('見つかりません');
        const status = isMasterError ? 'エラー：マスタ不備' : 'エラー：システム';

        await this.sheets.updateTranscriptionStatus(
          location.sheetId,
          record.rowIndex,
          status,
          err.message
        ).catch(e => logger.error(`ステータス更新失敗: ${(e as Error).message}`));

        errors.push({
          recordId: record.recordId,
          message: err.message,
          category: isMasterError ? 'master' : 'system',
          recoverable: !isMasterError,
          timestamp: new Date().toISOString(),
        });
        logger.error(`転記エラー [${record.recordId}]: ${err.message}`);

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
   * 転記対象レコードかどうかを判定
   */
  isTranscriptionTarget(record: TranscriptionRecord): boolean {
    if (record.recordLocked) return false;
    if (record.transcriptionFlag === '転記済み') return false;
    if (record.transcriptionFlag === '') return true;
    if (record.transcriptionFlag === 'エラー：システム') return true;
    if (record.transcriptionFlag === 'エラー：マスタ不備' && record.masterCorrectionFlag) return true;
    if (record.transcriptionFlag === '修正あり') return true;
    return false;
  }

  /**
   * 1レコード分の転記処理（14ステップ）
   */
  private async processRecord(
    record: TranscriptionRecord,
    nav: HamNavigator,
    sheetId: string,
  ): Promise<void> {
    logger.info(`転記開始: ${record.recordId} - ${record.patientName} (${record.visitDate})`);

    // サービスコード決定
    const codeResult = this.resolver.resolve(record);
    logger.debug(`サービスコード: ${codeResult.description} (${codeResult.servicetype}#${codeResult.serviceitem})`);

    // 介護+リハビリ → k2_7_1 フロー
    if (codeResult.useI5Page) {
      await this.processI5Record(record, nav, sheetId, codeResult);
      return;
    }

    // === Step 1: メインメニュー → 業務ガイド (t1-2 → k1_1) ===
    await this.auth.navigateToBusinessGuide();
    logger.debug('Step 1: 業務ガイドに遷移');

    // === Step 2: 業務ガイド → 利用者検索 (k1_1 → k2_1) ===
    await this.auth.navigateToUserSearch();
    logger.debug('Step 2: 利用者検索に遷移');

    // === Step 3: k2_1 で患者検索 ===
    const monthStart = toHamMonthStart(record.visitDate);
    await nav.setSelectValue('searchdate', monthStart);
    // 全患者を検索
    await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_1' });
    await this.sleep(1000);
    logger.debug(`Step 3: 患者検索実行 (${monthStart})`);

    // === Step 4: 患者を特定し、決定ボタンで k2_2 へ遷移 ===
    const patientId = await this.findPatientId(nav, record.patientName);
    if (!patientId) {
      throw new Error(`患者が見つかりません: ${record.patientName}（マスタ不備の可能性）`);
    }
    await nav.submitForm({
      action: 'k2_2',
      hiddenFields: { careuserid: patientId },
      waitForPageId: 'k2_2',
    });
    await this.sleep(1000);
    logger.debug(`Step 4: 月間スケジュールに遷移 (患者ID=${patientId})`);

    // === Step 5: k2_2 で追加ボタン → k2_3 ===
    const visitDateHam = toHamDate(record.visitDate);
    await nav.submitForm({
      action: 'act_addnew',
      setLockCheck: true,
      hiddenFields: { editdate: visitDateHam },
      waitForPageId: 'k2_3',
    });
    await this.sleep(1000);
    logger.debug(`Step 5: スケジュール追加画面に遷移 (日付=${visitDateHam})`);

    // === Step 6: k2_3 で時間設定 ===
    const startParts = parseTime(record.startTime);
    const endParts = parseTime(record.endTime);
    const startPeriod = getTimePeriod(record.startTime);
    const endPeriod = getTimePeriod(record.endTime);
    const timetype = getTimetype(record.startTime, record.endTime);

    await nav.setSelectValue('starttype', startPeriod);
    await nav.setSelectValue('starttime0', startParts.hour);
    await nav.setSelectValue('starttime1', startParts.minute);
    await nav.setSelectValue('timetype', timetype);
    await nav.setSelectValue('endtype', endPeriod);
    await nav.setSelectValue('endtime0', endParts.hour);
    await nav.setSelectValue('endtime1', endParts.minute);

    // 次へ → k2_3a
    await nav.submitForm({ action: 'act_next', waitForPageId: 'k2_3a' });
    await this.sleep(1000);
    logger.debug(`Step 6: 時間設定完了 (${record.startTime}-${record.endTime}, timetype=${timetype})`);

    // === Step 7: k2_3a でサービスコード選択 ===
    await nav.switchInsuranceType(codeResult.showflag);
    await this.sleep(1500); // 保険種別切替後のリロード待ち
    await nav.selectServiceCode(codeResult.servicetype, codeResult.serviceitem);
    // 次へ → k2_3b
    await nav.submitForm({ action: 'act_next', waitForPageId: 'k2_3b' });
    await this.sleep(500);
    logger.debug(`Step 7: サービスコード選択完了 (${codeResult.servicetype}#${codeResult.serviceitem})`);

    // === Step 8: k2_3b で決定 → k2_2 に戻る ===
    await nav.submitForm({ action: 'act_do', waitForPageId: 'k2_2' });
    await this.sleep(1500);
    logger.debug('Step 8: スケジュール確定、月間スケジュールに戻る');

    // === Step 9: k2_2 で新規行の配置ボタン → k2_2f ===
    const assignId = await this.findNewAssignId(nav, visitDateHam);
    if (!assignId) {
      throw new Error(`新規スケジュール行が見つかりません (日付=${visitDateHam})`);
    }
    await nav.submitForm({
      action: 'act_modify',
      setLockCheck: true,
      hiddenFields: { assignid: assignId },
      waitForPageId: 'k2_2f',
    });
    await this.sleep(1000);
    logger.debug(`Step 9: スタッフ配置画面に遷移 (assignId=${assignId})`);

    // === Step 10: k2_2f でスタッフ配置 ===
    await nav.setSelectValue('newstarthour', startParts.hour);
    await nav.setSelectValue('newstartminute', startParts.minute);
    await nav.setSelectValue('newendhour', endParts.hour);
    await nav.setSelectValue('newendminute', endParts.minute);

    // スタッフ ID を検索して設定
    const staffId = await this.findStaffId(nav, record.staffName);
    if (staffId) {
      await nav.setInputValue('helperid', staffId);
    } else {
      logger.warn(`スタッフ ID が見つかりません: ${record.staffName}。配置画面で手動設定が必要です`);
    }

    // 配置ボタン → k2_2 に戻る
    await nav.submitForm({ action: 'act_select', waitForPageId: 'k2_2' });
    await this.sleep(1000);
    logger.debug(`Step 10: スタッフ配置完了 (staffId=${staffId || 'N/A'})`);

    // === Step 11: k2_2 で緊急時加算チェック (必要な場合) ===
    if (codeResult.setUrgentFlag) {
      await this.setUrgentFlag(nav, assignId);
      logger.debug('Step 11: 緊急時加算チェック ON');
    }

    // === Step 12: k2_2 で上書き保存 ===
    await nav.submitForm({
      action: 'act_update',
      setLockCheck: true,
      waitForPageId: 'k2_2',
    });
    await this.sleep(2000);
    logger.debug('Step 12: 上書き保存実行');

    // === Step 13: 保存結果検証 ===
    const content = await nav.getFrameContent('k2_2');
    if (content.includes('エラー') && !content.includes('エラー：')) {
      throw new Error(`HAM保存エラー: ${content.substring(0, 300)}`);
    }
    logger.debug('Step 13: 保存結果検証OK');

    // === Step 14: スプレッドシート更新 ===
    await this.sheets.updateTranscriptionStatus(sheetId, record.rowIndex, '転記済み');
    await this.sheets.writeDataFetchedAt(sheetId, record.rowIndex, new Date().toISOString());
    logger.info(`転記完了: ${record.recordId} - ${record.patientName} (${record.visitDate})`);

    // メインメニューに戻る（次のレコード用）
    await this.auth.navigateToMainMenu();
  }

  /**
   * 介護リハビリ (訪看I5) 専用フロー
   * k2_7_1 ページを使用する
   */
  private async processI5Record(
    record: TranscriptionRecord,
    nav: HamNavigator,
    sheetId: string,
    _codeResult: ServiceCodeResult,
  ): Promise<void> {
    // Step 1-4: 通常フローと同じ（メニュー → 検索 → 患者選択 → k2_2）
    await this.auth.navigateToBusinessGuide();
    await this.auth.navigateToUserSearch();

    const monthStart = toHamMonthStart(record.visitDate);
    await nav.setSelectValue('searchdate', monthStart);
    await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_1' });
    await this.sleep(1000);

    const patientId = await this.findPatientId(nav, record.patientName);
    if (!patientId) {
      throw new Error(`患者が見つかりません: ${record.patientName}（マスタ不備の可能性）`);
    }
    await nav.submitForm({
      action: 'k2_2',
      hiddenFields: { careuserid: patientId },
      waitForPageId: 'k2_2',
    });
    await this.sleep(1000);

    // Step 5: k2_2 で 訪看I5入力ボタン → k2_7_1
    await nav.submitForm({
      action: 'act_i5',
      setLockCheck: true,
      waitForPageId: 'k2_7_1',
    });
    await this.sleep(1000);
    logger.debug('I5フロー: k2_7_1に遷移');

    // Step 6: k2_7_1 で時間グループ設定
    const startParts = parseTime(record.startTime);
    const endParts = parseTime(record.endTime);
    const startPeriod = getTimePeriod(record.startTime);

    // k2_7_1 のフォーム要素名は配列形式
    // 最初のグループ (index 0) に設定
    const frame = await nav.getMainFrame('k2_7_1');
    await frame.evaluate(({ sp, sh, sm, eh, em }) => {
      const form = document.forms[0];
      // 時間帯区分
      const starttimetype = form['starttimetype'] as unknown as HTMLSelectElement | undefined;
      if (starttimetype) starttimetype.value = sp;
      // 開始時刻
      const starthour = form['starthour'] as unknown as HTMLSelectElement | undefined;
      if (starthour) starthour.value = sh;
      const startminute = form['startminute'] as unknown as HTMLSelectElement | undefined;
      if (startminute) startminute.value = sm;
      // 終了時刻
      const endhour = form['endhour'] as unknown as HTMLSelectElement | undefined;
      if (endhour) endhour.value = eh;
      const endminute = form['endminute'] as unknown as HTMLSelectElement | undefined;
      if (endminute) endminute.value = em;
    }, {
      sp: startPeriod,
      sh: startParts.hour,
      sm: startParts.minute,
      eh: endParts.hour,
      em: endParts.minute,
    });

    // サービス検索ボタン
    await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_7_1' });
    await this.sleep(1500);

    // 戻る → k2_2
    await nav.submitForm({ action: 'act_back', waitForPageId: 'k2_2' });
    await this.sleep(1000);

    // 上書き保存
    await nav.submitForm({
      action: 'act_update',
      setLockCheck: true,
      waitForPageId: 'k2_2',
    });
    await this.sleep(2000);
    logger.debug('I5フロー: 上書き保存実行');

    // スプレッドシート更新
    await this.sheets.updateTranscriptionStatus(sheetId, record.rowIndex, '転記済み');
    await this.sheets.writeDataFetchedAt(sheetId, record.rowIndex, new Date().toISOString());
    logger.info(`転記完了(I5): ${record.recordId} - ${record.patientName} (${record.visitDate})`);

    // メインメニューに戻る
    await this.auth.navigateToMainMenu();
  }

  // ========== ヘルパーメソッド ==========

  /**
   * k2_1 の検索結果から患者 ID (careuserid) を取得
   *
   * k2_1 の患者行には決定ボタンの onclick に careuserid が埋め込まれている:
   *   onclick="...careuserid.value='8806571'..."
   */
  private async findPatientId(nav: HamNavigator, patientName: string): Promise<string | null> {
    const frame = await nav.getMainFrame('k2_1');
    const result = await frame.evaluate((name) => {
      const body = document.body?.innerHTML || '';
      const rows = body.split('<tr');

      for (const row of rows) {
        if (row.includes(name)) {
          // careuserid.value='XXXXXXX' を抽出
          const match = row.match(/careuserid\.value\s*=\s*'(\d+)'/);
          if (match) return match[1];
          // form.careuserid.value='XXXXXXX' パターン
          const match2 = row.match(/careuserid\.value\s*=\s*"(\d+)"/);
          if (match2) return match2[1];
        }
      }

      // フォールバック: 全ボタンの onclick から患者名に最も近い行を検索
      const allButtons = Array.from(document.querySelectorAll('input[name="act_result"]'));
      for (const btn of allButtons) {
        const tr = btn.closest('tr');
        if (tr && tr.textContent?.includes(name)) {
          const onclick = btn.getAttribute('onclick') || '';
          const m = onclick.match(/careuserid\.value\s*=\s*'(\d+)'/);
          if (m) return m[1];
        }
      }

      return null;
    }, patientName);

    if (result) {
      logger.debug(`患者ID検出: ${patientName} → ${result}`);
    }
    return result;
  }

  /**
   * k2_2 から新規追加されたスケジュール行の assignid を取得
   *
   * k2_2 の各行には配置ボタンがあり、onclick に assignid が含まれる:
   *   onclick="...assignid.value='XXXXXXX'..."
   */
  private async findNewAssignId(nav: HamNavigator, visitDateHam: string): Promise<string | null> {
    const frame = await nav.getMainFrame('k2_2');
    const result = await frame.evaluate((targetDate) => {
      // 日付に対応する行から assignid を抽出
      const modifyButtons = document.querySelectorAll('input[name="act_modify"]');
      const assignIds: string[] = [];

      const modifyArr = Array.from(modifyButtons);
      for (const btn of modifyArr) {
        const onclick = btn.getAttribute('onclick') || '';
        const tr = btn.closest('tr');
        const rowText = tr?.textContent || '';

        // この行が対象日付を含むかチェック
        // 日付表示形式: MM/DD or YYYYMMDD
        const month = targetDate.substring(4, 6);
        const day = targetDate.substring(6, 8);
        const dateDisplay = `${parseInt(month)}/${parseInt(day)}`;

        const m = onclick.match(/assignid\.value\s*=\s*'(\d+)'/);
        if (m) {
          if (rowText.includes(dateDisplay) || rowText.includes(targetDate)) {
            assignIds.push(m[1]);
          }
        }
      }

      // 最後の assignid（＝最新追加分）を返す
      if (assignIds.length > 0) {
        return assignIds[assignIds.length - 1];
      }

      // フォールバック: 最後の配置ボタンの assignid
      const allModifyBtns = Array.from(document.querySelectorAll('input[name="act_modify"]'));
      if (allModifyBtns.length > 0) {
        const lastBtn = allModifyBtns[allModifyBtns.length - 1];
        const onclick = lastBtn.getAttribute('onclick') || '';
        const m = onclick.match(/assignid\.value\s*=\s*'(\d+)'/);
        if (m) return m[1];
      }

      return null;
    }, visitDateHam);

    if (result) {
      logger.debug(`assignId検出: ${result}`);
    }
    return result;
  }

  /**
   * k2_2f のスタッフ一覧から staffName に合致する helperid を取得
   */
  private async findStaffId(nav: HamNavigator, staffName: string): Promise<string | null> {
    const frame = await nav.getMainFrame('k2_2f');
    const result = await frame.evaluate((name) => {
      // 方法1: select 要素から検索
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        for (const opt of Array.from(sel.options)) {
          if (opt.text.includes(name)) {
            return opt.value;
          }
        }
      }

      // 方法2: テーブル行から検索
      const links = Array.from(document.querySelectorAll('a, input[type="button"]'));
      for (const link of links) {
        const text = link.textContent?.trim() || '';
        const value = (link as HTMLInputElement).value || '';
        if (text.includes(name) || value.includes(name)) {
          const onclick = link.getAttribute('onclick') || '';
          const m = onclick.match(/helperid\.value\s*=\s*'(\d+)'/);
          if (m) return m[1];
        }
      }

      // 方法3: hidden input helperid
      const form = document.forms[0];
      const helperid = form?.elements.namedItem('helperid') as HTMLInputElement | null;
      if (helperid?.value) {
        return helperid.value;
      }

      return null;
    }, staffName);

    return result;
  }

  /**
   * k2_2 で緊急時加算チェックボックスを ON にする
   */
  private async setUrgentFlag(nav: HamNavigator, assignId: string): Promise<void> {
    const frame = await nav.getMainFrame('k2_2');
    await frame.evaluate((targetAssignId) => {
      // urgentflags チェックボックスを探す
      const rows = Array.from(document.querySelectorAll('tr'));
      for (const row of rows) {
        const rowHtml = row.innerHTML;
        if (rowHtml.includes(targetAssignId)) {
          const cb = row.querySelector('input[name="urgentflags"]') as HTMLInputElement;
          if (cb) {
            cb.checked = true;
            cb.value = '1';
            return;
          }
        }
      }

      // フォールバック: 最後の urgentflags チェックボックス
      const allCbs = document.querySelectorAll('input[name="urgentflags"]');
      if (allCbs.length > 0) {
        const lastCb = allCbs[allCbs.length - 1] as HTMLInputElement;
        lastCb.checked = true;
        lastCb.value = '1';
      }
    }, assignId);
  }

  /**
   * エラー後にメインメニューへ復帰を試みる
   */
  private async tryRecoverToMainMenu(nav: HamNavigator): Promise<void> {
    try {
      for (let i = 0; i < 5; i++) {
        const pageId = await nav.getCurrentPageId();
        if (!pageId || pageId === 't1-2') break;
        await nav.submitForm({ action: 'act_back' });
        await this.sleep(1000);
      }
    } catch {
      logger.warn('メインメニューへの復帰に失敗。次のレコードで再ログインします');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
