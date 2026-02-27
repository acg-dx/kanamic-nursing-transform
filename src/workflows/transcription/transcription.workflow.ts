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
import { PatientMasterService } from '../../services/patient-master.service';
import type { ServiceCodeResult } from '../../services/service-code-resolver';
import { getTimetype, getTimePeriod, parseTime, toHamDate, toHamMonthStart } from '../../services/time-utils';
import type { HamNavigator } from '../../core/ham-navigator';
import type { WorkflowContext, WorkflowResult, WorkflowError, TranscriptionStatus } from '../../types/workflow.types';
import type { TranscriptionRecord } from '../../types/spreadsheet.types';
import type { SheetLocation } from '../../types/config.types';

const WORKFLOW_NAME = 'transcription';

export class TranscriptionWorkflow extends BaseWorkflow {
  private resolver = new ServiceCodeResolver();
  private patientMaster: PatientMasterService | null = null;
  private staffQualifications = new Map<string, string[]>();

  /** CSV利用者マスタを設定 */
  setPatientMaster(master: PatientMasterService): void {
    this.patientMaster = master;
  }

  /** スタッフ資格マップを設定 (staffName → [資格1, 資格2, ...]) */
  setStaffQualifications(qualMap: Map<string, string[]>): void {
    this.staffQualifications = qualMap;
  }

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
    await this.sheets.formatTranscriptionColumns(location.sheetId);
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
        const { status, category, detail } = TranscriptionWorkflow.classifyError(err);

        await this.sheets.updateTranscriptionStatus(
          location.sheetId,
          record.rowIndex,
          status,
          detail
        ).catch(e => logger.error(`ステータス更新失敗: ${(e as Error).message}`));

        errors.push({
          recordId: record.recordId,
          message: err.message,
          category,
          recoverable: category !== 'master',
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
    // 完了ステータスフィルタ: "1"(日々チェック保留) と ""(空白) は転記対象外
    // 会議決定: "2","3","4" のみ転記対象
    const cs = record.completionStatus;
    if (cs === '' || cs === '1') return false;
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
    const patientId = await this.findPatientId(nav, record);
    if (!patientId) {
      throw new Error(`患者が見つかりません: ${record.patientName}（マスタ不備の可能性）`);
    }
    logger.debug(`Step 4: 患者ID検出 → ${patientId}、submitTargetFormEx で k2_2 に遷移開始`);

    // HAM の決定ボタンは submitTargetFormEx を使用する（submitForm ではない！）
    // onclick="submitTargetFormEx(this.form,'k2_2',careuserid,'8876382')"
    // 独自の submitForm は commontarget をターゲットにするが、
    // submitTargetFormEx は mainFrame を直接ターゲットにする可能性がある。
    // → HAM のネイティブ関数を直接呼び出す
    const frame = await nav.getMainFrame('k2_1');
    await frame.evaluate((pid) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      const form = document.forms[0];
      if (!form) throw new Error('k2_1 form not found');
      // submitTargetFormEx(form, pageId, hiddenField, value)
      if (typeof win.submitTargetFormEx === 'function') {
        win.submitTargetFormEx(form, 'k2_2', form.careuserid, pid);
      } else {
        // フォールバック: submitTargetFormEx が見つからない場合
        // 手動で同等の操作を行う
        win.submited = 0;
        form.careuserid.value = pid;
        form.doAction.value = 'k2_2';
        form.target = 'mainFrame';
        form.submit();
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }, patientId);

    // k2_2 のフレーム出現を待つ
    await nav.waitForMainFrame('k2_2', 15000);
    await this.sleep(1000);

    // syserror チェック
    await this.checkForSyserror(nav);
    logger.debug(`Step 4: 月間スケジュールに遷移完了 (患者ID=${patientId})`);

    const visitDateHam = toHamDate(record.visitDate);

    // === Step 4.5: 修正レコードの場合 → 既存スケジュール先行削除 ===
    if (record.transcriptionFlag === '修正あり') {
      logger.info(`修正レコード検出: ${record.recordId} — 既存スケジュールを削除します`);
      const deleted = await this.deleteExistingSchedule(nav, visitDateHam, record.startTime);
      if (deleted) {
        logger.info(`既存スケジュール削除完了 → 再転記を続行`);
      } else {
        logger.warn(`既存スケジュールが見つからないか削除不可 → 新規追加として続行`);
      }
    }

    // === Step 5: k2_2 で追加ボタン → k2_3 ===
    await nav.submitForm({
      action: 'act_addnew',
      setLockCheck: true,
      hiddenFields: { editdate: visitDateHam },
      waitForPageId: 'k2_3',
    });
    await this.sleep(1000);
    await this.checkForSyserror(nav);
    logger.debug(`Step 5: スケジュール追加画面に遷移 (日付=${visitDateHam})`);

    // === Step 6: k2_3 で時間設定 ===
    const startParts = parseTime(record.startTime);
    const startPeriod = getTimePeriod(record.startTime);
    const timetype = getTimetype(record.startTime, record.endTime);

    // starttype 設定（onchange で act_changetime が発火し starttime0 の選択肢が更新される）
    const k2_3Frame = await nav.getMainFrame('k2_3');
    const currentStartType = await k2_3Frame.evaluate(() => {
      return (document.forms[0]?.starttype as HTMLSelectElement)?.value || '';
    }).catch(() => '');

    if (currentStartType !== startPeriod) {
      await k2_3Frame.evaluate((val) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (window as any).submited = 0;
        /* eslint-enable @typescript-eslint/no-explicit-any */
        const form = document.forms[0];
        (form.starttype as HTMLSelectElement).value = val;
        (form.starttype as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));
      }, startPeriod);
      await this.sleep(3000);
      await nav.waitForMainFrame('k2_3', 15000);
    }

    await nav.setSelectValue('starttime0', startParts.hour);
    await nav.setSelectValue('starttime1', startParts.minute);
    await nav.setSelectValue('timetype', timetype);
    // 終了時間は HAM 自動値のまま（手動修正するとエラーになる。専務確認済み 2026-02-26）

    // 次へ → k2_3a
    await nav.submitForm({ action: 'act_next', waitForPageId: 'k2_3a' });
    await this.sleep(1000);
    logger.debug(`Step 6: 時間設定完了 (${record.startTime}-${record.endTime}, timetype=${timetype})`);

    // === Step 7: k2_3a でサービスコード選択 ===
    await nav.switchInsuranceType(codeResult.showflag);
    await this.sleep(1500); // 保険種別切替後のリロード待ち
    await nav.selectServiceCode(codeResult.servicetype, codeResult.serviceitem, undefined, codeResult.textPattern);
    logger.debug(`Step 7: サービスコード選択完了 (${codeResult.servicetype}#${codeResult.serviceitem})`);

    // === Step 7.5: k2_3a でスタッフ資格チェックボックス選択（医療保険のみ）===
    await this.selectQualificationCheckbox(nav, record, codeResult);

    // 次へ → k2_3b
    await nav.submitForm({ action: 'act_next', waitForPageId: 'k2_3b' });
    await this.sleep(500);

    // === Step 8: k2_3b で決定 → k2_2 に戻る ===
    await nav.submitForm({ action: 'act_do', waitForPageId: 'k2_2' });
    await this.sleep(1500);
    logger.debug('Step 8: スケジュール確定、月間スケジュールに戻る');

    // === Step 9: k2_2 で新規行の配置ボタン → k2_2f ===
    // 配置ボタン onclick: submitTargetFormEx(this.form, 'act_modify', assignid, 'XXX')
    const assignId = await this.findNewAssignId(nav, visitDateHam);
    if (!assignId) {
      throw new Error(`新規スケジュール行が見つかりません (日付=${visitDateHam})`);
    }

    const k2_2FrameForAssign = await nav.getMainFrame('k2_2');
    await k2_2FrameForAssign.evaluate((aid) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      const form = document.forms[0];
      const lockChecks = document.getElementsByName('lockCheck');
      if (lockChecks[0]) (lockChecks[0] as HTMLInputElement).value = '1';
      win.submited = 0;
      if (typeof win.submitTargetFormEx === 'function') {
        win.submitTargetFormEx(form, 'act_modify', form.assignid, aid);
      } else {
        form.assignid.value = aid;
        form.doAction.value = 'act_modify';
        form.target = 'commontarget';
        if (form.doTarget) form.doTarget.value = 'commontarget';
        form.submit();
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }, assignId);

    await nav.waitForMainFrame('k2_2f', 15000);
    await this.sleep(1000);
    await this.checkForSyserror(nav);
    logger.debug(`Step 9: スタッフ配置画面に遷移 (assignId=${assignId})`);

    // === Step 10: k2_2f でスタッフ選択（2段階操作） ===
    // Stage 1: k2_2f の配置ボタンクリック → 従業員リスト表示
    const k2_2fFrame = await nav.getMainFrame('k2_2f');
    await k2_2fFrame.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      win.submited = 0;
      const form = document.forms[0];
      if (typeof win.setTime === 'function') {
        const sh = (form.newstarthour || form.starthour)?.value || '';
        const sm = (form.newstartminute || form.startminute)?.value || '';
        const eh = (form.newendhour || form.endhour)?.value || '';
        const em = (form.newendminute || form.endminute)?.value || '';
        win.setTime(sh, sm, eh, em);
      }
      if (typeof win.submitTargetForm === 'function') {
        win.submitTargetForm(form, 'act_select');
      } else {
        form.doAction.value = 'act_select';
        form.target = 'commontarget';
        if (form.doTarget) form.doTarget.value = 'commontarget';
        form.submit();
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    await this.sleep(2000);
    logger.debug('Step 10: k2_2f 配置ボタンクリック → 従業員リスト待ち');

    // 「選択」ボタンが出現するまで待機
    let staffListFrame = await nav.getMainFrame();
    for (let i = 0; i < 15; i++) {
      const hasList = await staffListFrame.evaluate(() =>
        document.querySelectorAll('input[name="act_select"][value="選択"]').length > 0
      ).catch(() => false);
      if (hasList) break;
      await this.sleep(1000);
      staffListFrame = await nav.getMainFrame();
    }

    // Stage 2: 従業員リストからスタッフを検索して選択
    const staffId = await this.findStaffId(nav, record.staffName);
    if (!staffId) {
      logger.warn(`スタッフ ID が見つかりません: ${record.staffName}。配置画面で手動設定が必要です`);
    }

    const staffFrame = await nav.getMainFrame();
    await staffFrame.evaluate((hid) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      win.submited = 0;
      const form = document.forms[0];
      if (form.helperid) {
        form.helperid.value = hid;
      } else {
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'helperid';
        hidden.value = hid;
        form.appendChild(hidden);
      }
      form.doAction.value = 'act_select';
      form.target = 'commontarget';
      if (form.doTarget) form.doTarget.value = 'commontarget';
      form.submit();
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }, staffId || '');

    await nav.waitForMainFrame('k2_2', 15000);
    await this.sleep(1000);
    logger.debug(`Step 10: スタッフ配置完了 (staffId=${staffId || 'N/A'})`);

    // === Step 10.5: 上書き保存（1回目: 配置確定） ===
    // 配置後に保存しないと実績(results) 入力欄が出現しない
    await nav.submitForm({
      action: 'act_update',
      setLockCheck: true,
      waitForPageId: 'k2_2',
    });
    await this.sleep(2000);
    logger.debug('Step 10.5: 上書き保存（1回目: 配置確定）');

    // === Step 11: k2_2 で「全1」ボタン — 実績フラグ一括設定 ===
    await this.clickSelectAll1(nav);
    logger.debug('Step 11: 全1ボタン実行（実績フラグ一括設定）');

    // === Step 11.5: k2_2 で緊急時加算チェック (必要な場合) ===
    if (codeResult.setUrgentFlag) {
      await this.setUrgentFlag(nav, assignId);
      logger.debug('Step 11.5: 緊急時加算チェック ON');
    }

    // === Step 12: 上書き保存（2回目: 実績確定） ===
    await nav.submitForm({
      action: 'act_update',
      setLockCheck: true,
      waitForPageId: 'k2_2',
    });
    await this.sleep(2000);
    logger.debug('Step 12: 上書き保存（2回目: 実績確定）');

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

    const patientId = await this.findPatientId(nav, record);
    if (!patientId) {
      throw new Error(`患者が見つかりません: ${record.patientName}（マスタ不備の可能性）`);
    }
    await nav.submitForm({
      action: 'k2_2',
      hiddenFields: { careuserid: patientId },
      waitForPageId: 'k2_2',
    });
    await this.sleep(1000);

    // 介護/予防判定
    if (this.patientMaster) {
      const patient = this.patientMaster.findByAozoraId(record.aozoraId);
      if (patient) {
        const careType = PatientMasterService.determineCareType(patient.careLevel);
        if (careType === '予防') {
          logger.info(`I5フロー: 予防モード (${record.patientName}, 要介護度=${patient.careLevel})`);
          // TODO: k2_7_1 で予防/介護の切替が必要な場合の実装
          // 現時点ではログのみ。実際のUI操作は実機検証後に追加。
        }
      }
    }

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

    // 全1ボタン（実績フラグ一括設定）
    await this.clickSelectAll1(nav);
    logger.debug('I5フロー: 全1ボタン実行');

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
   * 同名同姓対応:
   *   - PatientMasterService で aozoraID から被保険者番号を取得
   *   - 同名が複数いる場合は被保険者番号で正確に特定
   *   - 同名がいない場合は名前検索
   *
   * k2_1 の患者行には決定ボタンの onclick に careuserid が埋め込まれている:
   *   onclick="...careuserid.value='8806571'..."
   */
  private async findPatientId(nav: HamNavigator, record: TranscriptionRecord): Promise<string | null> {
    const frame = await nav.getMainFrame('k2_1');
    const patientName = record.patientName;

    // 被保険者番号で検索（同名同姓対応）
    let searchByHihokensha = false;
    let hihokenshaBangou = '';

    if (this.patientMaster) {
      const patient = this.patientMaster.findByAozoraId(record.aozoraId);
      if (patient && patient.hihokenshaBangou) {
        hihokenshaBangou = patient.hihokenshaBangou;
        // 同名同姓がいる場合は被保険者番号で特定
        if (this.patientMaster.hasDuplicateName(patientName)) {
          searchByHihokensha = true;
          logger.debug(`同名同姓検出: ${patientName} → 被保険者番号(${hihokenshaBangou})で特定`);
        }
      }
    }

    const result = await frame.evaluate(({ name, useHihokensha, hihokensha }) => {
      // careuserid パターン: submitTargetFormEx(this.form,'k2_2',careuserid,'8876382')
      // → 第4引数がID。onclick 全体から抽出
      const careUserIdRegex = /careuserid\s*,\s*'(\d+)'/;
      // フォールバック: careuserid.value='XXXXX'
      const careUserIdRegex2 = /careuserid\.value\s*=\s*['"](\d+)['"]/;

      function extractCareUserId(html: string): string | null {
        const m1 = html.match(careUserIdRegex);
        if (m1) return m1[1];
        const m2 = html.match(careUserIdRegex2);
        if (m2) return m2[1];
        return null;
      }

      // HAM の患者名は「瀧下　絹子」（全角スペース）だが
      // Google Sheets は「瀧下絹子」（スペースなし）のため、
      // 比較時にスペースを除去して正規化する
      function normalize(s: string): string {
        return s.replace(/[\s\u3000\u00a0]+/g, '').trim();
      }

      const normalizedName = normalize(name);

      // === 方法1: 被保険者番号で検索（最も正確・同名同姓対応） ===
      if (useHihokensha && hihokensha) {
        const allButtons = Array.from(document.querySelectorAll('input[name="act_result"][value="決定"]'));
        for (const btn of allButtons) {
          const tr = btn.closest('tr');
          if (!tr) continue;
          const rowText = tr.textContent || '';
          if (rowText.includes(hihokensha)) {
            const onclick = btn.getAttribute('onclick') || '';
            const id = extractCareUserId(onclick);
            if (id) return id;
          }
        }
      }

      // === 方法2: 決定ボタンの onclick から患者名でマッチ ===
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

      // === 方法3: HTML 行分割でフォールバック ===
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
    }, { name: patientName, useHihokensha: searchByHihokensha, hihokensha: hihokenshaBangou });

    if (result) {
      logger.debug(`患者ID検出: ${patientName}${searchByHihokensha ? `(被保険者番号=${hihokenshaBangou})` : ''} → ${result}`);
    }
    return result;
  }

  /**
   * k2_2 から新規追加されたスケジュール行の assignid を取得
   *
   * k2_2 の各行には配置ボタンがあり、onclick に assignid が含まれる:
   *   onclick="...assignid.value='XXXXXXX'..."
   */
  /**
   * k2_2 から新規追加されたスケジュール行の assignid を取得
   *
   * HAM の日付表示形式は "X日" (e.g. "1日", "15日")。
   * 新規行はスタッフ未配置（担当スタッフ欄が空）なので、
   * 日付マッチ + 未配置の行を優先して特定する。
   */
  private async findNewAssignId(nav: HamNavigator, visitDateHam: string): Promise<string | null> {
    const frame = await nav.getMainFrame('k2_2');
    const dayNum = parseInt(visitDateHam.substring(6, 8));
    const dayDisplay = `${dayNum}日`;

    const result = await frame.evaluate((dd) => {
      const btns = Array.from(document.querySelectorAll('input[name="act_modify"][value="配置"]'));
      const all: { id: string; hasStaff: boolean; matchDay: boolean }[] = [];

      for (const btn of btns) {
        const onclick = btn.getAttribute('onclick') || '';
        const m = onclick.match(/assignid\s*,\s*'(\d+)'/) || onclick.match(/assignid\.value\s*=\s*'(\d+)'/);
        if (!m) continue;

        const tr = btn.closest('tr');
        const rowText = tr?.textContent || '';
        const staffCell = tr?.querySelector('td[bgcolor="#DDEEFF"]');
        const hasStaff = !!(staffCell?.textContent?.trim());

        all.push({ id: m[1], hasStaff, matchDay: rowText.includes(dd) });
      }

      // 優先1: 指定日 + 未配置
      for (const item of all) {
        if (item.matchDay && !item.hasStaff) return item.id;
      }
      // 優先2: 未配置（最後）
      const unassigned = all.filter(i => !i.hasStaff);
      if (unassigned.length > 0) return unassigned[unassigned.length - 1].id;
      // 優先3: 指定日（最後）
      const dayMatch = all.filter(i => i.matchDay);
      if (dayMatch.length > 0) return dayMatch[dayMatch.length - 1].id;
      // フォールバック
      if (all.length > 0) return all[all.length - 1].id;
      return null;
    }, dayDisplay);

    if (result) {
      logger.debug(`assignId検出: ${result} (day=${dayDisplay})`);
    }
    return result;
  }

  /**
   * k2_2 で既存スケジュールを削除する（修正レコード再転記時に使用）
   *
   * 同一日付 + 同一開始時刻の既存エントリを特定し、削除ボタンをクリックして上書き保存する。
   *
   * k2_2 HTML 構造:
   *   削除ボタン: <input name="act_delete" type="button" value="削除"
   *               onclick="confirmDelete('{assignid}', '{record2flag}');">
   *   行テキスト: "1日  日  18:00 ～ 18:30  訪問看護基本療養費（Ⅰ・Ⅱ）・夜朝"
   */
  private async deleteExistingSchedule(
    nav: HamNavigator,
    visitDateHam: string,
    startTime: string,
  ): Promise<boolean> {
    const frame = await nav.getMainFrame('k2_2');
    const dayNum = parseInt(visitDateHam.substring(6, 8));
    const dayDisplay = `${dayNum}日`;

    const deleteInfo = await frame.evaluate(({ dd, st }) => {
      const rows = Array.from(document.querySelectorAll('tr'));
      for (const row of rows) {
        const rowText = row.textContent || '';
        if (!rowText.includes(dd)) continue;
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

    logger.info(`既存スケジュール削除: ${deleteInfo.rowText} (assignid=${deleteInfo.assignid})`);

    if (deleteInfo.record2flag === '1') {
      logger.warn(`記録書IIが存在します (assignid=${deleteInfo.assignid})。削除をスキップします`);
      return false;
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

    // 上書き保存（削除反映に必須）
    await nav.submitForm({
      action: 'act_update',
      setLockCheck: true,
      waitForPageId: 'k2_2',
    });
    await this.sleep(2000);

    logger.info(`既存スケジュール削除完了: assignid=${deleteInfo.assignid}`);
    return true;
  }

  /**
   * k2_2f のスタッフ一覧から staffName に合致する helperid を取得
   *
   * k2_2f HTML 構造 (2026-02-26 検証済):
   *   各行: [従業員番号] [氏名] [性別] [資格] [職種] [勤怠] [確認] [選択]
   *   選択ボタン: onclick="return choice(this, 'helperId', '氏名', 1);"
   */
  private async findStaffId(nav: HamNavigator, staffName: string): Promise<string | null> {
    const frame = await nav.getMainFrame('k2_2f');
    const searchName = staffName.replace(/[\s\u3000]+/g, '');

    const result = await frame.evaluate((sn) => {
      const rows = Array.from(document.querySelectorAll('tr'));
      for (const row of rows) {
        const rowText = (row.textContent || '').replace(/[\s\u3000\u00a0]+/g, '');
        if (!rowText.includes(sn)) continue;

        const selectBtn = row.querySelector('input[name="act_select"][value="選択"]');
        if (!selectBtn || (selectBtn as HTMLInputElement).disabled) continue;

        const onclick = selectBtn.getAttribute('onclick') || '';
        const m = onclick.match(/choice\(this,\s*'(\d+)'/);
        if (m) return m[1];
      }
      return null;
    }, searchName);

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
   * syserror.jsp が表示されていないかチェック
   * HAM サーバーエラー時に mainFrame に syserror.jsp がロードされる
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
      // フレームアクセスエラーは無視
    }
  }

  /**
   * エラー後にメインメニューへ復帰を試みる
   */
  private async tryRecoverToMainMenu(nav: HamNavigator): Promise<void> {
    try {
      // syserror.jsp が表示されている場合、閉じるボタンをクリック
      const allFrames = nav.hamPage.frames();
      for (const frame of allFrames) {
        if (frame.url().includes('syserror')) {
          // syserror ページの「閉じる」ボタンをクリック
          await frame.evaluate(() => {
            const btn = document.querySelector('input[type="button"], button');
            if (btn) (btn as HTMLElement).click();
          }).catch(() => {});
          await this.sleep(1000);
          break;
        }
      }

      // 通常の act_back で戻る
      for (let i = 0; i < 5; i++) {
        const pageId = await nav.getCurrentPageId();
        if (!pageId || pageId === 't1-2') break;
        await nav.submitForm({ action: 'act_back' }).catch(() => {});
        await this.sleep(1000);
      }
    } catch {
      logger.warn('メインメニューへの復帰に失敗。次のレコードで再ログインを試みます');
      // 再ログインフラグを設定（KanamickAuthService の isLoggedIn を false にする）
      try {
        await this.auth.ensureLoggedIn();
      } catch {
        logger.error('再ログインにも失敗');
      }
    }
  }

  /**
   * k2_3a でスタッフ資格チェックボックスを選択
   * 医療保険 (showflag=3) の場合のみ。
   *
   * - 通常/緊急: 看護師等 or 准看護師等
   * - リハビリ: 理学療法士等のみ（看護師/准看護師はエラー）
   */
  private async selectQualificationCheckbox(
    nav: HamNavigator,
    record: TranscriptionRecord,
    codeResult: ServiceCodeResult,
  ): Promise<void> {
    // 医療保険 (showflag=3) のみ
    if (codeResult.showflag !== '3') return;

    const staffQuals = this.staffQualifications.get(record.staffName) || [];
    if (staffQuals.length === 0) {
      logger.debug(`資格情報なし: ${record.staffName}（デフォルト選択を使用）`);
      return;
    }

    // 医療+リハビリの場合、理学療法士等のみ可
    if (record.serviceType2 === 'リハビリ') {
      const hasRigaku = staffQuals.some(q =>
        q.includes('理学療法士') || q.includes('作業療法士') || q.includes('言語聴覚士')
      );
      const hasNurse = staffQuals.some(q => q.includes('看護師'));

      if (!hasRigaku && hasNurse) {
        throw new Error(
          `医療リハビリ資格制限: ${record.staffName} は看護師/准看護師のため医療リハビリに対応できません。` +
          '理学療法士/作業療法士/言語聴覚士のみ可能です。'
        );
      }

      if (hasRigaku) {
        await this.selectQualificationInFrame(nav, 'rigaku');
        logger.debug(`Step 7.5: 資格選択 → 理学療法士等 (${record.staffName})`);
      }
      return;
    }

    // 通常/緊急: 看護師 > 准看護師 の優先順位
    const hasKangoshi = staffQuals.some(q => q === '看護師' || q === '正看護師');
    const hasJunKangoshi = staffQuals.some(q => q === '准看護師');

    if (hasKangoshi) {
      await this.selectQualificationInFrame(nav, 'kangoshi');
      logger.debug(`Step 7.5: 資格選択 → 看護師等 (${record.staffName})`);
    } else if (hasJunKangoshi) {
      await this.selectQualificationInFrame(nav, 'junkangoshi');
      logger.debug(`Step 7.5: 資格選択 → 准看護師等 (${record.staffName})`);
    }
  }

  /**
   * k2_3a フレーム内で資格チェックボックス/ラジオを選択
   */
  private async selectQualificationInFrame(
    nav: HamNavigator,
    qualType: 'kangoshi' | 'junkangoshi' | 'rigaku',
  ): Promise<void> {
    const frame = await nav.getMainFrame('k2_3a');
    await frame.evaluate((qType) => {
      const form = document.forms[0];
      // k2_3a の資格選択は radio/checkbox (name に shikaku/staff を含む)
      // 値: kangoshi=1, junkangoshi=2, rigaku=3
      const valueMap: Record<string, string> = {
        kangoshi: '1',
        junkangoshi: '2',
        rigaku: '3',
      };
      const targetValue = valueMap[qType];

      // ラジオボタンを試す
      const radios = form.querySelectorAll('input[type="radio"]');
      for (const radio of Array.from(radios)) {
        const r = radio as HTMLInputElement;
        if (r.value === targetValue && (r.name.includes('shikaku') || r.name.includes('staff'))) {
          r.checked = true;
          return;
        }
      }

      // チェックボックスを試す
      const checkboxes = form.querySelectorAll('input[type="checkbox"]');
      for (const cb of Array.from(checkboxes)) {
        const c = cb as HTMLInputElement;
        if (c.value === targetValue && (c.name.includes('shikaku') || c.name.includes('staff'))) {
          c.checked = true;
          return;
        }
      }

      // select 要素を試す
      const selects = form.querySelectorAll('select');
      for (const sel of Array.from(selects)) {
        if (sel.name.includes('shikaku') || sel.name.includes('staff')) {
          for (const opt of Array.from(sel.options)) {
            if (opt.value === targetValue) {
              sel.value = targetValue;
              return;
            }
          }
        }
      }
    }, qualType);
  }

  /**
   * k2_2 で「全1」ボタンをクリック（checkAllAndSet1）
   * 実績フラグを一括で「1」に設定する
   */
  private async clickSelectAll1(nav: HamNavigator): Promise<void> {
    const frame = await nav.getMainFrame('k2_2');
    await frame.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      // checkAllAndSet1 は HAM 組み込み関数
      if (typeof win.checkAllAndSet1 === 'function') {
        win.checkAllAndSet1('results');
      } else {
        // フォールバック: results チェックボックスを手動で設定
        const form = document.forms[0];
        const checkboxes = form.querySelectorAll('input[name="results"]');
        for (const cb of Array.from(checkboxes)) {
          const checkbox = cb as HTMLInputElement;
          checkbox.checked = true;
          checkbox.value = '1';
        }
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    await this.sleep(500);
  }

  /**
   * エラーを分類し、U列に書き込む簡潔な日本語メッセージを生成
   *
   * S列ステータス:
   *   - エラー：マスタ不備 — 患者/スタッフが HAM に未登録
   *   - エラー：システム   — その他のシステム/ネットワークエラー
   *
   * U列エラー詳細: 業務担当者が読める簡潔な日本語（スタックトレースは書かない）
   */
  static classifyError(err: Error): {
    status: TranscriptionStatus;
    category: 'master' | 'system' | 'network';
    detail: string;
  } {
    const msg = err.message;

    // マスタ不備系
    if (msg.includes('患者が見つかりません') || msg.includes('マスタ不備')) {
      return { status: 'エラー：マスタ不備', category: 'master', detail: '利用者がHAMに登録されていません' };
    }
    if (msg.includes('スタッフ') && msg.includes('見つかりません')) {
      return { status: 'エラー：マスタ不備', category: 'master', detail: 'スタッフがHAMに登録されていません' };
    }
    if (msg.includes('医療リハビリ資格制限')) {
      return { status: 'エラー：マスタ不備', category: 'master', detail: '医療リハビリ：看護師/准看護師は対応不可（理学療法士等のみ）' };
    }
    if (msg.includes('サービスコード未検出')) {
      return { status: 'エラー：システム', category: 'system', detail: 'サービスコードが見つかりません。HAM設定を確認してください' };
    }

    // HAM システムエラー
    if (msg.includes('syserror') || msg.includes('E00010') || msg.includes('一時的に利用できません')) {
      return { status: 'エラー：システム', category: 'network', detail: 'HAMシステムが一時的に利用できません。時間をおいて再実行してください' };
    }

    // フレーム/DOM系
    if (msg.includes('form not found') || msg.includes('not found (timeout)')) {
      return { status: 'エラー：システム', category: 'system', detail: 'HAM画面の読み込みタイムアウト。再実行してください' };
    }
    if (msg.includes('mainFrame') || msg.includes('フレーム')) {
      return { status: 'エラー：システム', category: 'system', detail: 'HAM画面遷移エラー。再実行してください' };
    }

    // ネットワーク系
    if (msg.includes('timeout') || msg.includes('Timeout') || msg.includes('net::')) {
      return { status: 'エラー：システム', category: 'network', detail: 'ネットワークタイムアウト。接続を確認して再実行してください' };
    }

    // セッション切れ
    if (msg.includes('ログイン') || msg.includes('expired') || msg.includes('login')) {
      return { status: 'エラー：システム', category: 'network', detail: 'セッション切れ。再ログインして再実行してください' };
    }

    // 不明なエラー → 先頭80文字のみ
    const shortMsg = msg.substring(0, 80).replace(/\n/g, ' ');
    return { status: 'エラー：システム', category: 'system', detail: `システムエラー: ${shortMsg}` };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
