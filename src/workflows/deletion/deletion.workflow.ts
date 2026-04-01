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
 *   K: 支援区分1, L: 支援区分2, M: 削除ステータス（書き込み先: 削除済み/削除不要/エラー）
 */
import { BaseWorkflow } from '../base-workflow';
import { logger } from '../../core/logger';
import { withRetry } from '../../core/retry-manager';
import { CJK_VARIANT_MAP_SERIALIZABLE, extractPlainName } from '../../core/cjk-normalize';
import { toHamDate, toHamMonthStart } from '../../services/time-utils';
import { PAGE_DEATH_KEYWORDS, isPageCrashError } from '../../core/ham-error-keywords';
import type { HamNavigator } from '../../core/ham-navigator';
import type { Page } from 'playwright';
import type { WorkflowContext, WorkflowResult, WorkflowError } from '../../types/workflow.types';
import type { DeletionRecord, TranscriptionRecord } from '../../types/spreadsheet.types';
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
    let nav = await this.auth.ensureLoggedIn();

    // 月次Sheet から recordId → HAM assignId マップ＋転記済みレコードID集合を構築
    const { assignIds: assignIdMap, registeredIds } = await this.sheets.getAssignIdMap(location.sheetId);
    if (assignIdMap.size > 0) {
      logger.info(`HAM assignId マップ: ${assignIdMap.size}件ロード完了`);
    }
    if (registeredIds) {
      logger.info(`転記済みレコード: ${registeredIds.size}件検出`);
    }

    // 月次Sheet の重複ペアマップ構築（削除時に配対レコードの重複マークをクリアするため）
    // キーは看護記録転記プロジェクト (data-writer.ts) と同一: 利用者名+日付+開始+終了
    const duplicatePairMap = await this.buildDuplicatePairMap(location.sheetId, targets);

    for (const record of targets) {
      if (dryRun) {
        logger.info(`[DRY RUN] 削除スキップ: ${record.recordId} - ${record.patientName} (${record.visitDate} ${record.startTime})`);
        processedRecords++;
        continue;
      }

      // assignId が存在すれば精密削除、なければフォールバック（日付+時刻マッチ）
      const storedAssignId = assignIdMap.get(record.recordId) || '';
      // 月次シートで転記済みか判定（registeredIds が null の場合は読み取り失敗 → 安全のため「登録済み扱い」）
      const isRegistered = registeredIds === null || registeredIds.has(record.recordId);

      try {
        await withRetry(
          () => this.processRecord(record, nav, location.sheetId, storedAssignId, isRegistered, duplicatePairMap),
          `削除[${record.recordId}]`,
          {
            maxAttempts: 3,
            baseDelay: 2000,
            maxDelay: 10000,
            backoffMultiplier: 2,
            onRetry: async (_attempt, _err) => {
              const errMsg = _err?.message || '';
              const isServerError = ['メモリ不足', 'Out of Memory', 'OOM',
                'サーバーエラー', 'syserror', 'chrome-error',
                'Target crashed', 'Page crashed', 'ページ死亡検出',
                'ページ応答なし', 'ページクラッシュ検出', 'ブラウザ再起動',
                'Session closed', 'browser has been closed',
              ].some(k => errMsg.includes(k));

              if (isServerError) {
                const waitSec = 10 * _attempt;
                logger.warn(`削除: サーバーエラー検出 — ${waitSec}秒待機後にリトライ: ${errMsg.substring(0, 100)}`);
                await this.sleep(waitSec * 1000);
              }

              logger.info('削除: ページ復旧 → ensureLoggedIn → 利用者検索まで再遷移');
              nav = await this.auth.ensureLoggedIn();
              await this.auth.navigateToMainMenu();
              await this.auth.navigateToBusinessGuide();
              await this.auth.navigateToUserSearch();
            },
          }
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
        nav = await this.tryRecoverToMainMenu(nav);
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
    storedAssignId?: string,
    isRegistered?: boolean,
    duplicatePairMap?: Map<string, Array<{ rowIndex: number; recordId: string; tab: string }>>,
  ): Promise<void> {
    const hasAssignId = !!storedAssignId;

    // === 未転記レコードのHAM削除スキップ ===
    // 月次シートで転記済みでなく assignId もない場合、HAM にスケジュールは存在しない。
    // フォールバック（日付+時刻+スタッフ名マッチ）で別レコードの正しいスケジュールを
    // 誤削除するリスクを回避するため、HAM 操作をスキップして月次シート行のみ削除する。
    if (!hasAssignId && isRegistered === false) {
      logger.info(`HAM未転記レコード: ${record.recordId} - ${record.patientName} (${record.visitDate} ${record.startTime}) → HAM削除スキップ、月次シート行のみ削除`);
      const monthTab = this.visitDateToMonthTab(record.visitDate);
      if (monthTab) {
        await this.clearDuplicateFlagOnPairs(sheetId, monthTab, record.recordId, duplicatePairMap);
        const rowDeleted = await this.sheets.deleteRowByRecordId(sheetId, monthTab, record.recordId);
        if (rowDeleted) {
          logger.info(`月次シート行削除完了（HAM未転記）: ${record.recordId} (tab=${monthTab})`);
        } else {
          logger.warn(`月次シートに行が見つかりません: ${record.recordId} (tab=${monthTab})`);
        }
      }
      await this.sheets.updateDeletionStatus(sheetId, record.rowIndex, '削除済み');
      return;
    }

    logger.info(`削除開始: ${record.recordId} - ${record.patientName} (${record.visitDate} ${record.startTime})${hasAssignId ? ` [assignId=${storedAssignId}]` : ' [フォールバック: 日時マッチ]'}`);

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

    // assignId がある場合: 精密削除（confirmDelete を直接呼び出し）
    // assignId がない場合: フォールバック（日付+時刻+スタッフ名でマッチ）
    const assignIds = storedAssignId ? storedAssignId.split(',') : [];
    let deleted = false;

    if (assignIds.length > 0) {
      deleted = await this.deleteByAssignIds(nav, assignIds);
    }
    if (!deleted) {
      deleted = await this.deleteSchedule(nav, visitDateHam, record.startTime, record.staffName);
    }

    if (!deleted) {
      // HAM に該当スケジュールが存在しない場合でも、月次シートからは削除する
      // （旧データを残すと重複フラグが立ち、新データの転記がブロックされるため）
      logger.warn(`削除対象スケジュールが見つかりません: ${record.patientName} ${record.visitDate} ${record.startTime} → HAM削除不要、月次シート行を削除`);
      const monthTabNotFound = this.visitDateToMonthTab(record.visitDate);
      if (monthTabNotFound) {
        await this.clearDuplicateFlagOnPairs(sheetId, monthTabNotFound, record.recordId, duplicatePairMap);
        const rowDeleted = await this.sheets.deleteRowByRecordId(sheetId, monthTabNotFound, record.recordId);
        if (rowDeleted) {
          logger.info(`月次シート行削除完了（HAM未登録）: ${record.recordId} (tab=${monthTabNotFound})`);
        } else {
          logger.warn(`月次シートに行が見つかりません: ${record.recordId} (tab=${monthTabNotFound})`);
        }
      }
      await this.sheets.updateDeletionStatus(sheetId, record.rowIndex, '削除済み');
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

    // === Step 6: 配対レコードの重複マーク解除 + 月次シートから対象行を削除 ===
    const monthTab = this.visitDateToMonthTab(record.visitDate);
    if (monthTab) {
      await this.clearDuplicateFlagOnPairs(sheetId, monthTab, record.recordId, duplicatePairMap);
      const rowDeleted = await this.sheets.deleteRowByRecordId(sheetId, monthTab, record.recordId);
      if (rowDeleted) {
        logger.info(`月次シート行削除完了: ${record.recordId} (tab=${monthTab})`);
      } else {
        logger.warn(`月次シートに行が見つかりません: ${record.recordId} (tab=${monthTab})`);
      }
    } else {
      logger.warn(`月次シートタブ名を特定できません: visitDate=${record.visitDate}`);
    }

    // === Step 7: 削除Sheet M列を「削除済み」に更新 ===
    await this.sheets.updateDeletionStatus(sheetId, record.rowIndex, '削除済み');
    logger.info(`削除完了: ${record.recordId} - ${record.patientName} (${record.visitDate} ${record.startTime})`);

    // メインメニューに戻る（次のレコード用）
    await this.auth.navigateToMainMenu();
  }

  /**
   * 月次Sheet の重複ペアマップを構築する
   *
   * 削除対象レコードが属する月のみ読み込み、キー（患者名+日付+開始+終了）で
   * グループ化して N列=重複 のペアを特定する。
   * キーは看護記録転記プロジェクト (data-writer.ts buildDuplicateKeys) と同一基準。
   *
   * @returns recordId → 同グループの全メンバー（rowIndex, recordId, tab）
   */
  private async buildDuplicatePairMap(
    sheetId: string,
    targets: DeletionRecord[],
  ): Promise<Map<string, Array<{ rowIndex: number; recordId: string; tab: string }>>> {
    const pairMap = new Map<string, Array<{ rowIndex: number; recordId: string; tab: string }>>();

    // 削除対象レコードの月タブを収集（重複排除）
    const monthTabs = new Set<string>();
    for (const r of targets) {
      const tab = this.visitDateToMonthTab(r.visitDate);
      if (tab) monthTabs.add(tab);
    }

    for (const tab of monthTabs) {
      let records: TranscriptionRecord[];
      try {
        records = await this.sheets.getTranscriptionRecords(sheetId, tab);
      } catch (e) {
        logger.warn(`重複ペアマップ構築: タブ「${tab}」の読み取り失敗: ${(e as Error).message}`);
        continue;
      }

      // キーでグループ化（N列=重複 のレコードのみ）
      const groups = new Map<string, TranscriptionRecord[]>();
      for (const r of records) {
        if (!r.accompanyCheck.includes('重複')) continue;
        const key = `${r.patientName.normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '')}|${r.visitDate}|${r.startTime}|${r.endTime}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }

      // 2件以上のグループのみペアマップに登録
      for (const [, group] of groups) {
        if (group.length < 2) continue;
        const peers = group.map(r => ({ rowIndex: r.rowIndex, recordId: r.recordId, tab }));
        for (const r of group) {
          pairMap.set(r.recordId, peers);
        }
      }
    }

    if (pairMap.size > 0) {
      logger.info(`重複ペアマップ: ${pairMap.size}件のレコードにペア情報あり`);
    }
    return pairMap;
  }

  /**
   * 削除対象レコードの配対レコードから重複マーク（N列）をクリアする
   *
   * 行が物理削除される前に呼び出すこと。配対レコードの N列を空白に更新し、
   * 重複ブロックを即座に解除する（看護記録転記の cleanupStaleDuplicateMarkers と幂等）。
   */
  private async clearDuplicateFlagOnPairs(
    sheetId: string,
    tab: string,
    deletedRecordId: string,
    pairMap?: Map<string, Array<{ rowIndex: number; recordId: string; tab: string }>>,
  ): Promise<void> {
    if (!pairMap) return;
    const peers = pairMap.get(deletedRecordId);
    if (!peers) return;

    for (const peer of peers) {
      if (peer.recordId === deletedRecordId) continue; // 自分自身はスキップ
      if (peer.tab !== tab) continue; // 安全: 同じタブのみ
      try {
        await this.sheets.clearCellValue(sheetId, tab, 'N', peer.rowIndex);
        logger.info(`重複マーク解除: recordId=${peer.recordId} (row=${peer.rowIndex}, tab=${tab})`);
      } catch (e) {
        logger.warn(`重複マーク解除失敗: recordId=${peer.recordId} — ${(e as Error).message}`);
      }
    }
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
   *
   * staffName を指定すると、同一日付+時刻に複数エントリがある場合に
   * スタッフ名でマッチする行を優先的に削除する（重複キー対策）。
   */
  private async deleteSchedule(
    nav: HamNavigator,
    visitDateHam: string,
    startTime: string,
    staffName?: string,
  ): Promise<boolean> {
    const frame = await nav.getMainFrame('k2_2');
    const dayNum = parseInt(visitDateHam.substring(6, 8));
    const dayDisplay = `${dayNum}日`;

    // staffName から姓を抽出（"看護師-木場亜紗実" → "木場"）
    const staffSurname = staffName
      ? extractPlainName(staffName.split('-')[1] || '').substring(0, 3)
      : '';

    const deleteInfo = await frame.evaluate(({ dd, st, surname }) => {
      // 部分一致を防止: "1日" が "11日","21日","31日" にマッチしないよう正規表現で判定
      const dayRegex = new RegExp(`(?:^|[^0-9])${parseInt(dd)}日`);
      const rows = Array.from(document.querySelectorAll('tr'));

      interface Candidate {
        found: true;
        assignid: string;
        record2flag: string;
        rowText: string;
        staffMatch: boolean;
      }
      const candidates: Candidate[] = [];

      for (const row of rows) {
        const rowText = row.textContent || '';
        if (!dayRegex.test(rowText)) continue;
        if (!rowText.includes(st)) continue;

        const delBtn = row.querySelector('input[name="act_delete"][value="削除"]') as HTMLInputElement | null;
        if (!delBtn) continue;

        const onclick = delBtn.getAttribute('onclick') || '';
        const m = onclick.match(/confirmDelete\(\s*'(\d+)'\s*,\s*'(\d+)'\s*\)/);
        if (!m) continue;

        // スタッフ名チェック（td[bgcolor="#DDEEFF"] = 担当スタッフ欄）
        const staffCell = row.querySelector('td[bgcolor="#DDEEFF"]');
        const staffText = (staffCell?.textContent || '').replace(/[\s\u3000]+/g, '');
        const staffMatch = surname ? staffText.includes(surname) : false;

        candidates.push({
          found: true,
          assignid: m[1],
          record2flag: m[2],
          rowText: rowText.replace(/\s+/g, ' ').trim().substring(0, 120),
          staffMatch,
        });
      }

      if (candidates.length === 0) {
        return { found: false as const, candidateCount: 0, assignid: '', record2flag: '', rowText: '', staffMatch: false };
      }

      // スタッフ名一致を優先、なければ最初の候補（既存動作と互換）
      const best = candidates.find(c => c.staffMatch) || candidates[0];
      return { ...best, candidateCount: candidates.length };
    }, { dd: dayDisplay, st: startTime, surname: staffSurname });

    if (!deleteInfo.found) {
      logger.debug(`削除対象なし: ${dayDisplay} ${startTime}`);
      return false;
    }

    if (deleteInfo.candidateCount > 1) {
      logger.info(`重複キー検出: ${dayDisplay} ${startTime} に ${deleteInfo.candidateCount} 件 → スタッフ「${staffSurname}」で${deleteInfo.staffMatch ? '一致' : 'フォールバック'}`);
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
   * assignId リストを使って k2_2 のスケジュールを直接削除する（精密削除）
   *
   * 各 assignId に対応する削除ボタン confirmDelete('{assignId}', '{record2flag}') を特定し、
   * record2flag チェック後にクリックする。
   * I5 の場合は複数 assignId があるため、すべて削除してから true を返す。
   *
   * @param nav - HAM navigator
   * @param assignIds - HAM assignId のリスト（カンマ区切りから分割済み）
   * @returns true: 少なくとも1件削除した（上書き保存が必要）, false: 該当なし
   */
  private async deleteByAssignIds(nav: HamNavigator, assignIds: string[]): Promise<boolean> {
    const frame = await nav.getMainFrame('k2_2');
    let deletedCount = 0;

    for (const assignId of assignIds) {
      const trimmedId = assignId.trim();
      if (!trimmedId) continue;

      // 削除ボタンの onclick 属性から record2flag を取得
      const btnInfo = await frame.evaluate((aid: string) => {
        const selector = `input[name="act_delete"][onclick*="confirmDelete('${aid}'"]`;
        const btn = document.querySelector(selector) as HTMLInputElement | null;
        if (!btn) return { found: false, record2flag: '' };
        const onclick = btn.getAttribute('onclick') || '';
        const m = onclick.match(/confirmDelete\(\s*'\d+'\s*,\s*'(\d+)'\s*\)/);
        return { found: true, record2flag: m ? m[1] : '0' };
      }, trimmedId);

      if (!btnInfo.found) {
        logger.warn(`assignId=${trimmedId} の削除ボタンが見つかりません（既に削除済みの可能性）`);
        continue;
      }

      if (btnInfo.record2flag === '1') {
        throw new Error(`記録書IIが存在するため削除不可: assignId=${trimmedId}`);
      }

      // submited フラグをリセットして削除ボタンクリック
      const delBtn = await frame.$(`input[name="act_delete"][onclick*="confirmDelete('${trimmedId}'"]`);
      if (delBtn) {
        await frame.evaluate(() => {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          (window as any).submited = 0;
          /* eslint-enable @typescript-eslint/no-explicit-any */
        });
        await delBtn.click();
        await this.sleep(2000);
        deletedCount++;
        logger.debug(`assignId=${trimmedId} 削除ボタンクリック完了 (${deletedCount}/${assignIds.length})`);
      } else {
        // evaluate で見つかったが $ で取れない場合: confirmDelete 直接呼び出し
        await frame.evaluate((aid: string) => {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          const win = window as any;
          win.submited = 0;
          if (typeof win.confirmDelete === 'function') {
            win.confirmDelete(aid, '0');
          }
          /* eslint-enable @typescript-eslint/no-explicit-any */
        }, trimmedId);
        await this.sleep(2000);
        deletedCount++;
        logger.debug(`assignId=${trimmedId} confirmDelete直接呼出完了 (${deletedCount}/${assignIds.length})`);
      }
    }

    if (deletedCount > 0) {
      logger.info(`assignId精密削除: ${deletedCount}件削除（対象: ${assignIds.join(',')}）`);
    }
    return deletedCount > 0;
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

      // NFKC + Variation Selector 除去 + 旧字体→新字体（眞→真 等）+ ひらがな→カタカナ統一
      function normalize(s: string): string {
        let r = s.normalize('NFKC');
        r = r.replace(/[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, '');
        r = r.replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g, '');
        for (const [old, rep] of args.variantMap) {
          if (r.includes(old)) r = r.replaceAll(old, rep);
        }
        // ひらがな → カタカナ統一
        r = r.replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
        r = r.replace(/\u30F2/g, '\u30AA'); // ヲ→オ
        r = r.replace(/\u30F1/g, '\u30A8'); // ヱ→エ
        return r.replace(/[\s\u3000\u00a0]+/g, '').trim();
      }

      const normalizedName = normalize(args.name);

      // 決定ボタンの onclick から患者名でマッチ
      // (非表示) 行はスキップ（旧レコードへの誤マッチを防ぐ）
      const allButtons = Array.from(document.querySelectorAll('input[name="act_result"][value="決定"]'));
      for (const btn of allButtons) {
        const tr = btn.closest('tr');
        if (!tr) continue;
        const rawText = tr.textContent || '';
        if (rawText.includes('(非表示)')) continue;
        const rowText = normalize(rawText);
        if (rowText.includes(normalizedName)) {
          const onclick = btn.getAttribute('onclick') || '';
          const id = extractCareUserId(onclick);
          if (id) return id;
        }
      }

      // フォールバック: HTML 行分割
      // (非表示) 行はスキップ
      const body = document.body?.innerHTML || '';
      const rows = body.split('<tr');
      for (const row of rows) {
        if (row.includes('(非表示)')) continue;
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
   * 全ページ死活チェック + syserror/OOM 検出。
   * 転記ワークフローと同等の検出力を持つ。
   */
  private async checkForSyserror(nav: HamNavigator): Promise<void> {
    try {
      // === 全ページ死活チェック（TRITRUS + HAM 両方） ===
      const pagesToCheck: Array<{ page: Page; label: string }> = [];
      try { pagesToCheck.push({ page: nav.tritrusPage, label: 'TRITRUS' }); } catch { /* not available */ }
      try { pagesToCheck.push({ page: nav.hamPage, label: 'HAM' }); } catch { /* not available */ }
      const EVAL_TIMEOUT = 5000; // 5秒タイムアウト（OOM ページでは evaluate がハングするため）
      for (const { page: p, label } of pagesToCheck) {
        const pUrl = (() => { try { return p.url(); } catch { return ''; } })();
        if (pUrl.startsWith('chrome-error://') || pUrl === 'about:blank') {
          throw new Error(`ページ死亡検出 (OOM): ${label} が ${pUrl} — ブラウザ再起動が必要です`);
        }
        const alive = await Promise.race([
          p.evaluate(() => true).catch(() => false),
          new Promise<false>(resolve => setTimeout(() => resolve(false), EVAL_TIMEOUT)),
        ]);
        if (!alive) {
          throw new Error(`ページ応答なし (OOM): ${label} ${pUrl} — ブラウザ再起動が必要です`);
        }
        const bodyText = await Promise.race([
          p.evaluate(() => document.body?.innerText || '').catch(() => '__EVAL_FAILED__'),
          new Promise<string>(resolve => setTimeout(() => resolve('__EVAL_TIMEOUT__'), EVAL_TIMEOUT)),
        ]);
        if (bodyText === '__EVAL_FAILED__' || bodyText === '__EVAL_TIMEOUT__') {
          throw new Error(`ページ応答異常 (OOM): ${label} body取得${bodyText === '__EVAL_TIMEOUT__' ? 'タイムアウト' : '失敗'} ${pUrl} — ブラウザ再起動が必要です`);
        }
        const oomHit = PAGE_DEATH_KEYWORDS.find(kw => bodyText.includes(kw));
        if (oomHit) {
          throw new Error(`ページ死亡検出 (OOM): ${label} に "${oomHit}" — ブラウザ再起動が必要です`);
        }
      }

      // === フレーム内 syserror/OOM チェック ===
      const hamPage = nav.hamPage;
      const allFrames = hamPage.frames();
      for (const frame of allFrames) {
        const url = frame.url();
        if (url.startsWith('chrome-error://')) {
          throw new Error('HAM フレームクラッシュ検出 — ブラウザ再起動が必要です');
        }
        if (url.includes('syserror.jsp') || url.includes('error/syserror')) {
          const content = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
          throw new Error(
            `HAM システムエラー検出 (syserror.jsp): ${content.substring(0, 200)}`
          );
        }
        const frameText = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
        const oomMatch = PAGE_DEATH_KEYWORDS.find(k => frameText.includes(k));
        if (oomMatch) {
          throw new Error(`HAM フレーム内 OOM 検出: "${oomMatch}" — ブラウザ再起動が必要です`);
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      const isOwnError = msg.includes('syserror.jsp') ||
        msg.includes('OOM') ||
        msg.includes('クラッシュ') ||
        PAGE_DEATH_KEYWORDS.some(kw => msg.includes(kw));
      if (isOwnError) throw e;
      if (isPageCrashError(msg)) {
        throw new Error(`ページクラッシュ検出 (OOM): ${msg}`);
      }
      // フレームアクセスエラー（遷移中等）は無視
    }
  }

  /**
   * エラー後にメインメニューへ復帰を試みる
   */
  private async tryRecoverToMainMenu(nav: HamNavigator): Promise<HamNavigator> {
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
        nav = await this.auth.ensureLoggedIn();
      } catch {
        logger.error('再ログインにも失敗');
      }
    }
    return nav;
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
