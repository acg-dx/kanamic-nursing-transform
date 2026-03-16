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
import { normalizeCjkName, CJK_VARIANT_MAP_SERIALIZABLE, extractPlainName } from '../../core/cjk-normalize';
import { ServiceCodeResolver } from '../../services/service-code-resolver';
import { PatientMasterService } from '../../services/patient-master.service';
import type { ServiceCodeResult } from '../../services/service-code-resolver';
import { getTimetype, getTimePeriod, parseTime, toHamDate, toHamMonthStart, calcDurationMinutes, calcCorrectedEndTime } from '../../services/time-utils';
import type { Frame } from 'playwright';
import type { HamNavigator } from '../../core/ham-navigator';
import type { WorkflowContext, WorkflowResult, WorkflowError, TranscriptionStatus } from '../../types/workflow.types';
import type { TranscriptionRecord } from '../../types/spreadsheet.types';
import type { SheetLocation } from '../../types/config.types';
import type { SmartHRService } from '../../services/smarthr.service';
import type { StaffSyncService } from '../../workflows/staff-sync/staff-sync.workflow';

const WORKFLOW_NAME = 'transcription';

export class TranscriptionWorkflow extends BaseWorkflow {
  private resolver = new ServiceCodeResolver();
  private patientMaster: PatientMasterService | null = null;
  private staffQualifications = new Map<string, string[]>();
  private smarthr: SmartHRService | null = null;
  private staffSync: StaffSyncService | null = null;
  private hamRegistrationState = new Map<string, boolean>();

  /** CSV利用者マスタを設定 */
  setPatientMaster(master: PatientMasterService): void {
    this.patientMaster = master;
  }

  /** スタッフ資格マップを設定 (staffName → [資格1, 資格2, ...]) */
  setStaffQualifications(qualMap: Map<string, string[]>): void {
    // SmartHR は "姓 名"（半角スペースあり）、Sheet は "姓名"（スペースなし）で
    // 名前フォーマットが異なるため、空白を除去して正規化した Map を作成する
    this.staffQualifications = new Map();
    for (const [name, quals] of qualMap) {
      this.staffQualifications.set(name.replace(/[\s\u3000]+/g, ''), quals);
    }
  }

  /** SmartHR + StaffSync を設定（転記前スタッフ自動補登用） */
  setStaffAutoRegister(smarthr: SmartHRService, staffSync: StaffSyncService): void {
    this.smarthr = smarthr;
    this.staffSync = staffSync;
  }

  async run(context: WorkflowContext): Promise<WorkflowResult[]> {
    const locations = context.locations || [];
    const results: WorkflowResult[] = [];

    for (const location of locations) {
      const result = await this.executeWithTiming(() =>
        this.processLocation(location, context.dryRun, context.tab, context.targetRecordIds)
      );
      results.push(result);
    }

    return results;
  }

  private async processLocation(location: SheetLocation, dryRun: boolean, tab?: string, targetRecordIds?: string[]): Promise<WorkflowResult> {
    const tabLabel = tab || '当月';
    logger.info(`転記処理開始: ${location.name} (${tabLabel})`);
    const errors: WorkflowError[] = [];
    let processedRecords = 0;

    const records = await this.sheets.getTranscriptionRecords(location.sheetId, tab);
    await this.sheets.formatTranscriptionColumns(location.sheetId, tab);

    // 重複ペア跨レコードバリデーション: 同一キーのグループでいずれかのP列が空 → 全員ブロック
    const duplicateBlocked = this.buildDuplicateBlockedSet(records);
    if (duplicateBlocked.size > 0) {
      logger.info(`重複ペア未判定でブロック: ${duplicateBlocked.size}件 (P列未入力のペアあり)`);
    }

    let targets = records.filter(r => {
      if (duplicateBlocked.has(r.recordId)) return false;
      return this.isTranscriptionTarget(r);
    });

    // targetRecordIds 指定時: 対象レコードのみに絞り込む
    if (targetRecordIds && targetRecordIds.length > 0) {
      const idSet = new Set(targetRecordIds);
      targets = targets.filter(r => idSet.has(r.recordId));
      logger.info(`レコードIDフィルタ適用: ${targetRecordIds.join(', ')} → ${targets.length}件`);
    }

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

    // === スタッフ事前チェック＋自動補登 ===
    let unregisteredStaff = new Set<string>();
    try {
      unregisteredStaff = await this.ensureStaffRegistered(nav, targets);
    } catch (err) {
      logger.error(`スタッフ事前チェックエラー（転記は続行）: ${(err as Error).message}`);
      // エラー後にメインメニューに復帰
      try { await this.auth.navigateToMainMenu(); } catch (navErr) { logger.debug(`メインメニュー復帰失敗: ${(navErr as Error).message}`); }
    }

    // 補登失敗のスタッフのレコードを事前にエラーマーク
    if (unregisteredStaff.size > 0) {
      for (const record of targets) {
        if (unregisteredStaff.has(record.staffName)) {
          await this.sheets.updateTranscriptionStatus(
            location.sheetId,
            record.rowIndex,
            'エラー：マスタ不備',
            `スタッフ「${record.staffName}」がHAMに未登録です（自動補登失敗）`,
            tab,
          ).catch(e => logger.error(`ステータス更新失敗: ${(e as Error).message}`));

          errors.push({
            recordId: record.recordId,
            message: `スタッフ「${record.staffName}」がHAMに未登録`,
            category: 'master',
            recoverable: false,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // 未登録スタッフのレコードを除外して転記
    const executableTargets = unregisteredStaff.size > 0
      ? targets.filter(r => !unregisteredStaff.has(r.staffName))
      : targets;

    logger.info(`転記実行対象: ${executableTargets.length}件${unregisteredStaff.size > 0 ? ` (スタッフ未登録で除外: ${targets.length - executableTargets.length}件)` : ''}`);

    const MAX_CONSECUTIVE_ERRORS = 3;
    let consecutiveErrors = 0;

    for (const record of executableTargets) {
      if (dryRun) {
        logger.info(`[DRY RUN] 転記スキップ: ${record.recordId} - ${record.patientName}`);
        processedRecords++;
        continue;
      }

      try {
        await withRetry(
          () => this.processRecord(record, nav, location.sheetId, tab),
          `転記[${record.recordId}]`,
          {
            maxAttempts: 2,
            baseDelay: 3000,
            maxDelay: 15000,
            backoffMultiplier: 2,
            onRetry: async () => {
              // エラー後のリトライ: メインメニューまで完全復帰してから k2_1 まで再遷移
              // getCurrentPageId の結果に頼らず、確実に t1-2 → k1_1 → k2_1 を通る
              logger.info('ページ復旧: メインメニュー → 利用者検索まで再遷移');
              await this.auth.navigateToMainMenu();
              await this.auth.navigateToBusinessGuide();
              await this.auth.navigateToUserSearch();
            },
          }
        );
        processedRecords++;
        consecutiveErrors = 0; // 成功でリセット
      } catch (error) {
        const err = error as Error;
        const { status, category, detail } = TranscriptionWorkflow.classifyError(err);

        await this.sheets.updateTranscriptionStatus(
          location.sheetId,
          record.rowIndex,
          status,
          detail,
          tab,
        ).catch(e => logger.error(`ステータス更新失敗: ${(e as Error).message}`));

        errors.push({
          recordId: record.recordId,
          message: err.message,
          category,
          recoverable: category !== 'master',
          timestamp: new Date().toISOString(),
        });
        logger.error(`転記エラー [${record.recordId}]: ${err.message}`);

        // マスタ不備（患者/スタッフ未登録等）はデータ問題であり、システム障害ではない。
        // 連続エラーカウントに含めると、同一患者の複数レコードで熔断してしまう。
        if (category !== 'master') {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            logger.error(`連続${MAX_CONSECUTIVE_ERRORS}件システムエラー — システム障害と判断し処理を中止します`);
            break;
          }
        }

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
   * 重複ペアの跨レコードバリデーション
   *
   * 同一キー（患者名+日付+開始時刻+終了時刻）のグループで N列=重複 のレコードがあり、
   * いずれかの P列が空欄の場合、グループ全体をブロックする。
   * キーは看護記録転記プロジェクト (data-writer.ts buildDuplicateKeys) と同一基準。
   *
   * @returns ブロック対象の recordId セット
   */
  private buildDuplicateBlockedSet(records: TranscriptionRecord[]): Set<string> {
    // Step 1: 重複レコードをキーでグループ化
    const groups = new Map<string, TranscriptionRecord[]>();
    for (const r of records) {
      if (!r.accompanyCheck.includes('重複')) continue;
      const key = `${r.patientName.normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '')}|${r.visitDate}|${r.startTime}|${r.endTime}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }

    // Step 2: いずれかの P列が空 → グループ全体をブロック
    const blocked = new Set<string>();
    for (const [, group] of groups) {
      if (group.some(r => !r.accompanyClerkCheck.trim())) {
        for (const r of group) {
          blocked.add(r.recordId);
        }
      }
    }
    return blocked;
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

    // N列「重複」かつ P列が空欄 → スキップ（事務員未判定 — ペアの役割が未確定）
    if (record.accompanyCheck.includes('重複') && !record.accompanyClerkCheck.trim()) return false;

    // O列「緊急支援あり」かつ R列が空欄 → スキップ（緊急時事務員未設定）
    if (record.emergencyFlag.includes('緊急支援あり') && !record.emergencyClerkCheck.trim()) return false;

    // ---- 転記処理詳細.xlsx 全組み合わせ表に基づく転記対象外判定 ----
    const pCol = record.accompanyClerkCheck.trim();     // P列: 同行事務員チェック
    const qTruthy = ['true', '1'].includes(           // Q列: 複数名訪問(二)
      (record.multipleVisit?.trim().toLowerCase() || ''));
    const st1 = record.serviceType1;                    // K列: 支援区分1
    const st2 = record.serviceType2;                    // L列: 支援区分2

    // P列「同行者」→ 転記なし（全支援区分共通: 医療ROW18-19, 精神ROW42-43,55-56, 介護ROW3,11）
    if (pCol === '同行者') return false;

    // --- 医療+通常: 複数人(副)+Q=true → 転記なし (ROW 23) ---
    if (st1 === '医療' && st2.startsWith('通常') && pCol === '複数人(副)' && qTruthy) return false;

    // --- 精神+通常: 複数人(副)+Q=true → 転記あり (ROW 47) → スキップしない ---
    // ★ ROW 47 は転記対象: 精神科訪問看護基本療養費（Ⅰ・Ⅲ）/・准/（作業療法士等）

    // --- 医療+リハビリ: P≠空欄 → 全部転記なし (ROW 29-38) ---
    if (st1 === '医療' && st2 === 'リハビリ' && pCol !== '') return false;

    // --- 精神医療+リハビリ: 複数人系+Q=false → 転記しない (ROW 57,59,61) ---
    // ★精神+リハビリ+複数人+Q=true は転記する (ROW 58,60,62) → スキップしない★
    if (st1 === '精神医療' && st2 === 'リハビリ') {
      if (['複数人(主)', '複数人(副)', '複数人(看護+介護)'].includes(pCol) && !qTruthy) return false;
    }

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
    tab?: string,
  ): Promise<void> {
    logger.info(`転記開始: ${record.recordId} - ${record.patientName} (${record.visitDate})`);

    // Check if HAM registration is already complete from a previous retry attempt
    const hamAlreadyComplete = this.hamRegistrationState.get(record.recordId) || false;

    // サービスコード決定
    const codeResult = this.resolver.resolve(record);
    logger.debug(`サービスコード: ${codeResult.description} (${codeResult.servicetype}#${codeResult.serviceitem})`);

    // --- 介護度判定: K列='介護' でも実際の介護度が要支援 → 予防 (showflag=2) に切替 ---
    // Google Sheet K列は '介護' と記載されるが、患者の介護度が要支援1-2の場合、
    // HAM では予防訪問看護（showflag=2, servicetype=63）として登録する必要がある。
    // I5 フロー（介護+リハビリ）は内部で servicetype 13→63 切替済み（6a ステップ）。
    // k2_3a フロー（介護+通常/緊急）はここで showflag + textPattern を上書きする。
    if (record.serviceType1 === '介護' && this.patientMaster) {
      const patient = this.patientMaster.findByAozoraId(record.aozoraId);
      if (patient) {
        const careType = PatientMasterService.determineCareType(patient.careLevel);
        if (careType === '予防') {
          logger.info(
            `介護度判定: ${record.patientName} は${patient.careLevel} → 予防モード ` +
            `(showflag=${codeResult.showflag}→2, textPattern=${codeResult.textPattern}→予訪看Ⅰ)`,
          );
          codeResult.showflag = '2';
          codeResult.servicetype = '63';
          // HAM k2_3a showflag=2 のサービス一覧: '予訪看Ⅰ{N}' (等級は時間帯依存)
          if (codeResult.textPattern === '訪看Ⅰ') {
            codeResult.textPattern = '予訪看Ⅰ';
          }
        }
      }
    }

    // 介護+リハビリ → k2_7_1 フロー
    if (codeResult.useI5Page) {
      await this.processI5Record(record, nav, sheetId, codeResult, tab);
      return;
    }

    // === Step 1-2: k2_1 に遷移（既に k2_1 にいればスキップ） ===
    const currentPageId = await nav.getCurrentPageId();
    if (currentPageId === 'k2_1') {
      logger.debug('Step 1-2: 既に k2_1（利用者検索）にいるためスキップ');
    } else if (currentPageId === 'k2_2') {
      // k2_2 にいる場合（リトライ等）→「戻る」で k2_1 に戻る
      logger.debug('Step 1-2: k2_2 にいるため「戻る」で k2_1 へ');
      await this.clickBackButtonOnK2_2(nav);
    } else {
      // その他のページ → メインメニュー経由で k2_1 へ
      if (currentPageId && currentPageId !== 't1-2') {
        await this.auth.navigateToMainMenu();
      }
      await this.auth.navigateToBusinessGuide();
      logger.debug('Step 1: 業務ガイドに遷移');
      await this.auth.navigateToUserSearch();
      logger.debug('Step 2: 利用者検索に遷移');
    }

    // === Step 3: k2_1 で患者検索 ===
    const monthStart = toHamMonthStart(record.visitDate);
    await nav.setSelectValue('searchdate', monthStart);

    // 検索前のフレーム URL を記録（リロード検出用）
    // 既に k2_1 にいる場合、submitForm → waitForPageId:'k2_1' は
    // URL が既に k2_1 を含むため即座に旧ページを返してしまう。
    // フレーム URL の変化（一時的に空 or 別 URL → k2_1 に戻る）を検出して
    // 実際のリロード完了を待つ。
    const preSearchFrame = await nav.getMainFrame('k2_1');
    const preSearchUrl = preSearchFrame.url();

    // 全患者を検索（waitForPageId は使わない — 下記で独自にリロード待ち）
    await nav.submitForm({ action: 'act_search' });

    // フレームリロード待ち: URL が一旦変化するか、DOM が再構築されるまで待機
    for (let waitIdx = 0; waitIdx < 30; waitIdx++) {
      await this.sleep(500);
      try {
        const f = await nav.getMainFrame();
        const currentUrl = f.url();
        // URL が変化した（リロード発生）→ k2_1 の再出現を待つ
        if (currentUrl !== preSearchUrl) break;
        // URL が同じでも forms[0] が一時的に消えた→リロード中
        const hasForm = await f.evaluate(() => !!document.forms[0]).catch(() => false);
        if (!hasForm) break;
        // 決定ボタンが表示されたら検索結果がロード済み
        const hasResults = await f.evaluate(() =>
          document.querySelectorAll('input[name="act_result"][value="決定"]').length > 0
        ).catch(() => false);
        if (hasResults && waitIdx >= 2) break; // 最低1秒は待つ
      } catch {
        break; // フレーム遷移中
      }
    }

    // k2_1 のフレームが完全にロードされるまで待機
    await nav.waitForMainFrame('k2_1', 15000);
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

    // === スケジュール作成・スタッフ配置スキップ判定 ===
    // hamAlreadyComplete: 同一実行内リトライでスケジュール作成済み → スタッフ配置のみ
    // dupStatus === 'partial': k2_2 にスケジュールあるがスタッフ未配置 → スタッフ配置のみ
    // dupStatus === 'needs_jisseki': スケジュール＋スタッフ済みだが実績≠1 → 全1＋保存のみ
    let skipScheduleCreation = hamAlreadyComplete;
    let skipStaffAssignment = false;

    // === Step 4.5a: 重複チェック — 同一日付+時刻のエントリ状態を確認 ===
    if (record.transcriptionFlag !== '修正あり') {
      const dupStatus = await this.checkDuplicateOnK2_2(nav, visitDateHam, record.startTime, record.staffName);
      if (dupStatus === 'complete') {
        await this.sheets.updateTranscriptionStatus(sheetId, record.rowIndex, '転記済み', undefined, tab);
        await this.sheets.writeDataFetchedAt(sheetId, record.rowIndex, new Date().toISOString(), tab);
        logger.info(`重複スキップ → 転記済みに更新: ${record.recordId} - ${record.patientName}`);
        await this.clickBackButtonOnK2_2(nav);
        return;
      }
      if (dupStatus === 'needs_jisseki') {
        skipScheduleCreation = true;
        skipStaffAssignment = true;
      }
      if (dupStatus === 'partial') {
        skipScheduleCreation = true;
      }
    }

    if (!skipScheduleCreation) {
    // === Step 4.5b: 修正レコードの場合 → 既存スケジュール先行削除 ===
    if (record.transcriptionFlag === '修正あり') {
      logger.info(`修正レコード検出: ${record.recordId} — 既存スケジュールを削除します`);
      const deleted = await this.deleteExistingSchedule(nav, visitDateHam, record.startTime, record.staffName);
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
      timeout: 30000,
    });
    await this.sleep(2000);
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

    // timetype の onchange="checkTimeHk604()" を発火して終了時間を自動計算させる
    const k2_3FrameForChange = await nav.getMainFrame('k2_3');
    await k2_3FrameForChange.evaluate(() => {
      const form = document.forms[0];
      const timeSel = form?.timetype as HTMLSelectElement;
      if (timeSel) {
        timeSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await this.sleep(1000);

    // === Step 6.5: 終了時間補正（HAM自動値を上書き） ===
    // HAM は timetype に基づく区間終了時刻を自動設定するが、
    // 実訪問時間が区間境界と一致しない場合は不正確（例: 12:00-12:35 → HAM自動=12:59）。
    // 正しい終了時間 = 表格の終了時間 - 1分（HAM仕様: 12:35 → 12:34）。
    const correctedEnd = calcCorrectedEndTime(record.endTime);
    const k2_3FrameForEnd = await nav.getMainFrame('k2_3');
    await k2_3FrameForEnd.locator('select[name="endtime0"]').selectOption(correctedEnd.hour);
    await this.sleep(300);
    await k2_3FrameForEnd.locator('select[name="endtime1"]').selectOption(correctedEnd.minute);
    await this.sleep(300);
    logger.debug(`Step 6.5: 終了時間補正 ${record.endTime} → ${correctedEnd.hour}:${correctedEnd.minute}`);

    // 次へ → k2_3a
    await nav.submitForm({ action: 'act_next', waitForPageId: 'k2_3a', timeout: 30000 });
    await this.sleep(2000);
    logger.debug(`Step 6: 時間設定完了 (${record.startTime}-${record.endTime}, timetype=${timetype})`);

    // === Step 7: k2_3a でサービスコード選択 ===
    await nav.switchInsuranceType(codeResult.showflag);
    await this.sleep(2000); // 保険種別切替後のリロード待ち

    // === Step 7.5: k2_3a でスタッフ資格選択（医療保険のみ）— サービスコード選択の前に実行 ===
    // 資格フィルタを先に適用することで、サービスコード一覧が准看護師用に絞り込まれる
    await this.selectQualificationCheckbox(nav, record, codeResult);

    await nav.selectServiceCode(codeResult.servicetype, codeResult.serviceitem, undefined, codeResult.textPattern, codeResult.textRequire);
    logger.debug(`Step 7: サービスコード選択完了 (${codeResult.servicetype}#${codeResult.serviceitem})`);

    // 次へ → k2_3b
    await nav.submitForm({ action: 'act_next', waitForPageId: 'k2_3b' });
    await this.sleep(500);

    // === Step 8: k2_3b で決定 → k2_2 に戻る ===
    await nav.submitForm({ action: 'act_do', waitForPageId: 'k2_2' });
    await this.sleep(3000);
    logger.debug('Step 8: スケジュール確定、月間スケジュールに戻る');
    this.hamRegistrationState.set(record.recordId, true);
    } else {
      logger.info(`スケジュール作成スキップ（部分登録/リトライ） → ${skipStaffAssignment ? '実績設定に進む' : 'スタッフ配置に進む'}: ${record.recordId}`);
    }

    // === Step 9-10.5: スタッフ配置（skipStaffAssignment の場合はスキップ → 全1+保存のみ） ===
    let k2_2MainFrame: Frame | null = null;

    let assignId: string | null = null;

    if (!skipStaffAssignment) {
    // === Step 9: k2_2 で新規行の配置ボタン → k2_2f ===
    // 配置ボタン onclick: submitTargetFormEx(this.form, 'act_modify', assignid, 'XXX')
    // 新規行が表示されるまでリトライ（k2_2 再読み込みに時間がかかる場合がある）
    for (let attempt = 0; attempt < 10; attempt++) {
      assignId = await this.findNewAssignId(nav, visitDateHam, record.startTime);
      if (assignId) break;
      logger.debug(`Step 9: 新規行待ち (${attempt + 1}/10)...`);
      await this.sleep(2000);
    }

    if (!assignId) {
      throw new Error(`新規スケジュール行が見つかりません (日付=${visitDateHam})。配置ボタンが存在しない場合、サービスコードの選択が間違っている可能性があります。`);
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

    // === Step 10: k2_2f でスタッフ選択（Playwright native click + HAM choice() 関数） ===
    // Stage 1: k2_2f の配置ボタンを Playwright native click
    const k2_2fFrame = await nav.getMainFrame('k2_2f');
    await k2_2fFrame.evaluate(() => { (window as any).submited = 0; }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const haichi1Btn = await k2_2fFrame.$('input[name="act_select"][value="配置"]');
    if (haichi1Btn) {
      await haichi1Btn.click();
    } else {
      logger.warn('配置ボタンが見つかりません。フォーム送信にフォールバック');
      await nav.submitForm({ action: 'act_select' });
    }
    await this.sleep(3000);
    logger.debug('Step 10: k2_2f 配置ボタンクリック → 従業員リスト待ち');

    // Stage 2: 従業員リスト表示待ち（全フレームから検索）
    const hamPage = nav.hamPage;
    let staffFrame: Frame | null = null;
    for (let i = 0; i < 20; i++) {
      const allFrames = hamPage.frames();
      for (const f of allFrames) {
        const hasList = await f.evaluate(() =>
          document.querySelectorAll('input[name="act_select"][value="選択"]').length > 0
        ).catch(() => false);
        if (hasList) { staffFrame = f; break; }
      }
      if (staffFrame) break;
      await this.sleep(1000);
    }
    if (!staffFrame) {
      throw new Error('従業員選択リストが表示されません');
    }

    // Stage 3: スタッフ検索 + HAM choice() 呼び出し
    // CJK 異体字正規化: NFKC + 旧字体→新字体（眞→真, 﨑→崎 等）
    // extractPlainName: "資格-姓名" 形式の場合、資格プレフィックスを除去して氏名のみ使用
    const staffSearchName = normalizeCjkName(extractPlainName(record.staffName));
    const choiceResult = await staffFrame.evaluate((args: { searchName: string; variantMap: [string, string][] }) => {
      function normCjk(s: string): string {
        let r = s.normalize('NFKC');
        for (const [old, rep] of args.variantMap) {
          if (r.includes(old)) r = r.replaceAll(old, rep);
        }
        return r.replace(/[\s\u3000\u00a0]+/g, '').trim();
      }
      const rows = Array.from(document.querySelectorAll('tr'));
      let foundButDisabled = false;
      for (const row of rows) {
        const rowText = normCjk(row.textContent || '');
        if (!rowText.includes(args.searchName)) continue;
        const selectBtn = row.querySelector('input[name="act_select"][value="選択"]') as HTMLInputElement | null;
        if (!selectBtn) continue;
        // 選択ボタンが disabled → スタッフは存在するが同時間帯に他利用者の予定と重複
        if (selectBtn.disabled) {
          foundButDisabled = true;
          continue;
        }
        const onclick = selectBtn.getAttribute('onclick') || '';
        const m = onclick.match(/choice\(this,\s*'(\d+)',\s*'([^']+)',\s*(\d+)\)/);
        if (!m) continue;
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (window as any).submited = 0;
        if (typeof (window as any).choice === 'function') {
          (window as any).choice(selectBtn, m[1], m[2], 1);
          return { found: true, disabled: false, helperId: m[1], staffName: m[2] };
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
        selectBtn.click();
        return { found: true, disabled: false, helperId: m[1], staffName: m[2] };
      }
      return { found: false, disabled: foundButDisabled, helperId: '', staffName: '' };
    }, { searchName: staffSearchName, variantMap: CJK_VARIANT_MAP_SERIALIZABLE });

    if (!choiceResult.found) {
      if (choiceResult.disabled) {
        throw new Error(
          `スタッフ配置不可：担当スタッフ「${record.staffName}」が同時間帯に他利用者の予定と重複しHAMで選択不可（手動配置が必要）`
        );
      }
      throw new Error(`スタッフ「${record.staffName}」(検索名: ${staffSearchName}) が見つかりません（HAMに登録されていません）`);
    }
    await this.sleep(3000);

    // Stage 4: 確認画面の決定ボタンクリック
    let confirmClicked = false;
    for (let retry = 0; retry < 10; retry++) {
      const allFrames2 = hamPage.frames();
      for (const f of allFrames2) {
        try {
          const hasConfirm = await f.evaluate(() => {
            const body = document.body?.innerText || '';
            return body.includes('スタッフでよろしければ') || body.includes('決定');
          }).catch(() => false);
          if (hasConfirm) {
            const ketteBtn = await f.$('input[value="決定"]');
            if (ketteBtn) {
              await f.evaluate(() => { (window as any).submited = 0; }); // eslint-disable-line @typescript-eslint/no-explicit-any
              await ketteBtn.click();
              confirmClicked = true;
              break;
            }
          }
        } catch (e) { logger.debug(`確認画面フレーム検索エラー: ${(e as Error).message}`); }
      }
      if (confirmClicked) break;
      await this.sleep(1000);
    }
    await this.sleep(3000);

    if (!confirmClicked) {
      throw new Error(
        `スタッフ配置不可：担当スタッフ「${record.staffName}」の確認画面（決定ボタン）が表示されませんでした。` +
        '同時間帯に他利用者の予定と重複しHAMで選択不可の可能性があります（手動配置が必要）'
      );
    }
    logger.debug(`Step 10: スタッフ配置完了 (${choiceResult.staffName})`);

    // === Step 10.5: k2_2f で「戻る」→ k2_2 に戻る ===
    let backClicked = false;
    const allFramesForBack = hamPage.frames();
    for (const f of allFramesForBack) {
      try {
        const backLink = await f.$('a:has-text("戻る")');
        if (backLink) {
          await backLink.click();
          backClicked = true;
          break;
        }
      } catch (e) { logger.debug(`戻るリンク検索エラー: ${(e as Error).message}`); }
    }
    if (!backClicked) {
      logger.warn('戻るリンク未検出。act_back にフォールバック');
      await nav.submitForm({ action: 'act_back' });
    }
    await this.sleep(3000);

    // k2_2 に戻るまで待機
    for (let i = 0; i < 20; i++) {
      const allF = hamPage.frames();
      for (const f of allF) {
        const hasAll1 = await f.evaluate(() =>
          !!document.querySelector('input[name="act_chooseall"]')
        ).catch(() => false);
        if (hasAll1) { k2_2MainFrame = f; break; }
      }
      if (k2_2MainFrame) break;
      await this.sleep(1500);
    }
    if (!k2_2MainFrame) {
      k2_2MainFrame = await nav.getMainFrame();
    }
    logger.debug('Step 10.5: k2_2 に戻った');
    } else {
      // skipStaffAssignment: スケジュール＋スタッフ済み → 実績フラグ設定のみ
      logger.info(`スタッフ配置スキップ（実績フラグのみ更新）: ${record.recordId}`);
      k2_2MainFrame = await nav.getMainFrame('k2_2');
    }

    // === Step 11: k2_2 で「全1」ボタン — 実績フラグ一括設定 ===
    const all1Btn = await k2_2MainFrame.$('input[name="act_chooseall"]');
    if (all1Btn) {
      await all1Btn.click();
    } else {
      await this.clickSelectAll1(nav);
    }
    await this.sleep(1000);
    logger.debug('Step 11: 全1ボタン実行（実績フラグ一括設定）');

    // === Step 11.5: k2_2 で緊急時加算チェック (必要な場合) ===
    if (codeResult.setUrgentFlag && assignId) {
      await this.setUrgentFlag(nav, assignId);
      logger.debug('Step 11.5: 緊急時加算チェック ON');
    }

    // === Step 12: 上書き保存 ===
    const saveBtnK2_2 = await k2_2MainFrame.$('input[value="上書き保存"]');
    if (saveBtnK2_2) {
      await k2_2MainFrame.evaluate(() => { (window as any).submited = 0; }); // eslint-disable-line @typescript-eslint/no-explicit-any
      await saveBtnK2_2.click();
    } else {
      await nav.submitForm({ action: 'act_update', setLockCheck: true });
    }
    await this.sleep(3000);
    logger.debug('Step 12: 上書き保存完了');

    // === Step 13: 保存結果検証 ===
    // HAM のエラーはページ内にエラーメッセージとして表示される
    // 「エラー」を含むが、正常な k2_2 ページの表示文字列を除外する
    const saveContent = await nav.getFrameContent('k2_2');
    const hasHamError = saveContent.includes('エラー') &&
      !saveContent.includes('配置') && // k2_2 正常時は「配置」ボタンがある
      !saveContent.includes('act_chooseall'); // 正常時は「全1」ボタンがある
    if (hasHamError) {
      throw new Error(`HAM保存エラー: ${saveContent.substring(0, 300)}`);
    }
    logger.debug('Step 13: 保存結果検証OK');

    // === Step 14: スプレッドシート更新 ===
    await this.sheets.updateTranscriptionStatus(sheetId, record.rowIndex, '転記済み', undefined, tab);
    await this.sheets.writeDataFetchedAt(sheetId, record.rowIndex, new Date().toISOString(), tab);
    // HAM assignId を保存（削除時に正確な行特定に使用）
    if (assignId) {
      await this.sheets.writeHamAssignId(sheetId, record.rowIndex, assignId, tab);
    }
    logger.info(`転記完了: ${record.recordId} - ${record.patientName} (${record.visitDate})`);

    // k2_2 の「戻る」ボタンで k2_1（利用者検索）に戻る
    // submitTargetForm(form, 'act_back') 相当 — target は mainFrame
    await this.clickBackButtonOnK2_2(nav);
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
    tab?: string,
  ): Promise<void> {
    // Step 1-2: k2_1 に遷移（processRecord と同じ智能ページ検出）
    const currentPageId = await nav.getCurrentPageId();
    if (currentPageId === 'k2_1') {
      logger.debug('I5 Step 1-2: 既に k2_1（利用者検索）にいるためスキップ');
    } else if (currentPageId === 'k2_2') {
      logger.debug('I5 Step 1-2: k2_2 にいるため「戻る」で k2_1 へ');
      await this.clickBackButtonOnK2_2(nav);
    } else {
      if (currentPageId && currentPageId !== 't1-2') {
        await this.auth.navigateToMainMenu();
      }
      await this.auth.navigateToBusinessGuide();
      await this.auth.navigateToUserSearch();
    }

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

    // 介護/予防判定（ログ出力のみ。実際の切替は k2_7_1 の 6a ステップで実施）
    if (this.patientMaster) {
      const patient = this.patientMaster.findByAozoraId(record.aozoraId);
      if (patient) {
        const careType = PatientMasterService.determineCareType(patient.careLevel);
        if (careType === '予防') {
          logger.info(`I5フロー: 予防モード (${record.patientName}, 要介護度=${patient.careLevel})`);
        }
      }
    }

    // 日付文字列（スタッフ配置時の行検索に使用）
    const visitDateHam = toHamDate(record.visitDate);

    // === 重複チェック — 同一日付+時刻のエントリ状態を確認 ===
    let skipI5Creation = false;
    let skipI5StaffAssignment = false;
    if (record.transcriptionFlag !== '修正あり') {
      const dupStatus = await this.checkDuplicateOnK2_2(nav, visitDateHam, record.startTime, record.staffName);
      if (dupStatus === 'complete') {
        await this.sheets.updateTranscriptionStatus(sheetId, record.rowIndex, '転記済み', undefined, tab);
        await this.sheets.writeDataFetchedAt(sheetId, record.rowIndex, new Date().toISOString(), tab);
        logger.info(`I5 重複スキップ → 転記済みに更新: ${record.recordId} - ${record.patientName}`);
        await this.clickBackButtonOnK2_2(nav);
        return;
      }
      if (dupStatus === 'needs_jisseki') {
        skipI5Creation = true;
        skipI5StaffAssignment = true;
        logger.info(`I5 実績未設定検出 → 実績フラグのみ更新: ${record.recordId}`);
      }
      if (dupStatus === 'partial') {
        skipI5Creation = true;
        logger.info(`I5 部分登録検出 → スケジュール作成スキップ・スタッフ配置に進む: ${record.recordId}`);
      }
    }

    if (!skipI5Creation) {
    // Step 5: k2_2 で 訪看I5入力ボタン → k2_7_1
    await nav.submitForm({
      action: 'act_i5',
      setLockCheck: true,
      waitForPageId: 'k2_7_1',
    });
    await this.sleep(1000);
    logger.debug('I5フロー: k2_7_1に遷移');

    // Step 6: k2_7_1 で時間設定 + サービス回数 + サービス検索
    //
    // k2_7_1 ページ構造:
    //   3行の時間設定行（row 0/1/2）。各行に:
    //     - starttimetype (select): 昼間/夜朝/深夜/指定なし
    //     - starthour, startminute (select): 開始時刻
    //     - serivcetimesno{N} (radio): 1回/2回/3回 → onclick=setEndtime(N, count)
    //     - endhour, endminute (select): 終了時刻
    //     - serivcename{N} (radio): 通常/複1/複2
    //   底部:
    //     - servicetype (radio): 訪問看護(13) / 予防訪問看護(63)
    //     - サービス検索 ボタン
    //
    // ★ serivcetimesno の選択が必須。未選択だとサービス検索が空データになる。
    const startParts = parseTime(record.startTime);
    const endParts = parseTime(record.endTime);
    const startPeriod = getTimePeriod(record.startTime);
    const durationMinutes = calcDurationMinutes(record.startTime, record.endTime);
    // サービス回数: 20分=1回、40分=2回、60分=3回（仕様書定義）
    const serviceCount = Math.min(3, Math.max(1, Math.ceil(durationMinutes / 20)));
    logger.debug(`I5フロー: duration=${durationMinutes}分 → サービス回数=${serviceCount}回`);

    // --- 6a: 訪問看護(13) vs 予防訪問看護(63) の確認・切替 ---
    // 要介護1-5 → 13(訪問看護), 要支援1-2 → 63(予防訪問看護)
    // HAM がデフォルトで正しい方を選択している場合が多いが、
    // 不一致の場合のみ radio をクリックして切替（ページリロード発生）。
    let expectedServiceType = '13'; // デフォルト: 訪問看護
    if (this.patientMaster) {
      const patient = this.patientMaster.findByAozoraId(record.aozoraId);
      if (patient) {
        const careType = PatientMasterService.determineCareType(patient.careLevel);
        if (careType === '予防') expectedServiceType = '63';
      }
    }

    let k2_7_1Frame = await nav.getMainFrame('k2_7_1');
    const currentServiceType = await k2_7_1Frame.evaluate(() => {
      const radios = document.querySelectorAll('input[name="servicetype"]');
      for (const r of Array.from(radios)) {
        if ((r as HTMLInputElement).checked) return (r as HTMLInputElement).value;
      }
      return '';
    });
    const serviceTypeLabel = currentServiceType === '63' ? '予防訪問看護' : '訪問看護';
    logger.info(`I5フロー: ${serviceTypeLabel} (servicetype=${currentServiceType}) が選択済み`);

    if (currentServiceType !== expectedServiceType) {
      // radio クリック → act_change_servicetype → ページリロード
      logger.info(`I5フロー: servicetype 切替 ${currentServiceType} → ${expectedServiceType}`);
      await k2_7_1Frame.evaluate((val) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (window as any).submited = 0;
        const form = document.forms[0];
        const radios = document.querySelectorAll('input[name="servicetype"]');
        for (const r of Array.from(radios)) {
          if ((r as HTMLInputElement).value === val) {
            (r as HTMLInputElement).checked = true;
            break;
          }
        }
        form.doAction.value = 'act_change_servicetype';
        form.target = 'commontarget';
        if (form.doTarget) form.doTarget.value = 'commontarget';
        form.submit();
        /* eslint-enable @typescript-eslint/no-explicit-any */
      }, expectedServiceType);
      await this.sleep(3000);
      k2_7_1Frame = await nav.waitForMainFrame('k2_7_1', 15000);
      logger.debug(`I5フロー: servicetype 切替完了 → ${expectedServiceType}`);
    }

    // --- 6b: starttimetype（時間帯区分）---
    const currentTimeType = await k2_7_1Frame.evaluate(() => {
      const selects = document.querySelectorAll('select[name="starttimetype"]');
      return selects.length > 0 ? (selects[0] as HTMLSelectElement).value : '1';
    });

    if (currentTimeType !== startPeriod) {
      // starttimetype を変更 → onchange で submitTargetForm → ページリロード
      await k2_7_1Frame.evaluate((val) => {
        (window as any).submited = 0; // eslint-disable-line @typescript-eslint/no-explicit-any
        const selects = document.querySelectorAll('select[name="starttimetype"]');
        if (selects.length > 0) {
          (selects[0] as HTMLSelectElement).value = val;
          (selects[0] as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, startPeriod);
      await this.sleep(3000);
      await nav.waitForMainFrame('k2_7_1', 15000);
      logger.debug(`I5フロー: starttimetype 変更 ${currentTimeType} → ${startPeriod}`);
    }

    // --- 6c: 開始時刻設定（Playwright ネイティブ API で確実にイベント発火） ---
    // 培訓確認: I5 は1行にN回を設定する方式
    // 「開始時刻を入れたら2回ボタンを押す → 終了時刻が自動で入る」
    //
    // evaluate() での .value 直接設定は HAM の onchange/onfocus ハンドラが発火せず
    // 内部状態が同期されない問題がある。Playwright の selectOption()/click() を使用する。
    const frameAfterReload = await nav.getMainFrame('k2_7_1');

    // row 0 の starthour / startminute を Playwright locator で設定
    // 同名 select が3つあるため nth(0) で最初の行を指定
    await frameAfterReload.locator('select[name="starthour"]').nth(0).selectOption(startParts.hour);
    await this.sleep(300);
    await frameAfterReload.locator('select[name="startminute"]').nth(0).selectOption(startParts.minute);
    await this.sleep(300);
    logger.debug(`I5フロー: 開始時刻設定 ${startParts.hour}:${startParts.minute}`);

    // サービス回数 radio クリック — setEndtime(0, count) で終了時刻が自動設定される
    await frameAfterReload.locator(`input[name="serivcetimesno0"][value="${serviceCount}"]`).click();
    await this.sleep(1000);
    logger.debug(`I5フロー: サービス回数 ${serviceCount}回 クリック`);

    // --- 6d: 終了時刻を上書き（表格終了時間 - 1分） ---
    // setEndtime() が自動計算した値ではなく、補正済み終了時刻で上書き。
    // HAM仕様: 終了時間 = 表格の終了時間 - 1分（例: 12:35 → 12:34）。
    const correctedEndI5 = calcCorrectedEndTime(record.endTime);
    await frameAfterReload.locator('select[name="endhour"]').nth(0).selectOption(correctedEndI5.hour);
    await this.sleep(300);
    await frameAfterReload.locator('select[name="endminute"]').nth(0).selectOption(correctedEndI5.minute);
    await this.sleep(300);
    logger.debug(`I5フロー: 終了時間補正 ${record.endTime} → ${correctedEndI5.hour}:${correctedEndI5.minute}`);

    // 設定値の検証（DOM 読み返し）
    const i5Verify = await frameAfterReload.evaluate(() => {
      const sh = document.querySelectorAll('select[name="starthour"]');
      const sm = document.querySelectorAll('select[name="startminute"]');
      const eh = document.querySelectorAll('select[name="endhour"]');
      const em = document.querySelectorAll('select[name="endminute"]');
      const radios = document.querySelectorAll('input[name="serivcetimesno0"]');
      let cnt = '';
      for (const r of Array.from(radios)) {
        if ((r as HTMLInputElement).checked) cnt = (r as HTMLInputElement).value;
      }
      return {
        sh: sh[0] ? (sh[0] as HTMLSelectElement).value : '',
        sm: sm[0] ? (sm[0] as HTMLSelectElement).value : '',
        eh: eh[0] ? (eh[0] as HTMLSelectElement).value : '',
        em: em[0] ? (em[0] as HTMLSelectElement).value : '',
        cnt,
      };
    });
    logger.info(`I5フロー: 時間設定検証 start=${i5Verify.sh}:${i5Verify.sm} end=${i5Verify.eh}:${i5Verify.em} 回数=${i5Verify.cnt}`);
    if (!i5Verify.sh || !i5Verify.cnt) {
      throw new Error(`I5 時間設定失敗: starthour=${i5Verify.sh}, 回数=${i5Verify.cnt} — DOM値が反映されていません`);
    }
    logger.debug(`I5フロー: 時間設定完了 (${record.startTime}-${record.endTime}, 回数=${serviceCount}, timetype=${startPeriod})`);

    // --- 6e: サービス検索 ---
    await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_7_1' });
    await this.sleep(2000);

    // サービス検索結果の検証: 検索後に k2_7_1 にエラーメッセージが出ていないか確認
    const searchResultFrame = await nav.getMainFrame('k2_7_1');
    const searchError = await searchResultFrame.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      if (bodyText.includes('該当するサービスがありません') || bodyText.includes('エラー')) {
        return bodyText.substring(0, 200);
      }
      return '';
    });
    if (searchError) {
      throw new Error(`I5 サービス検索エラー: ${searchError}`);
    }
    logger.debug('I5フロー: サービス検索完了');

    // --- 6f: 次へ → 日付選択ページ ---
    await nav.submitForm({ action: 'act_next' });
    await this.sleep(2000);
    logger.debug('I5フロー: 次へ → 日付選択ページ');

    // --- 6g: 日付チェックボックスを選択して決定 ---
    const dayNum = parseInt(visitDateHam.substring(6, 8));
    const dateFrame = await nav.getMainFrame();
    // name="selectdate" value="日" のチェックボックスをクリック
    await dateFrame.locator(`input[name="selectdate"][value="${dayNum}"]`).click();
    await this.sleep(500);
    logger.debug(`I5フロー: ${dayNum}日 チェック`);

    // 決定ボタン → k2_2 に戻る
    await nav.submitForm({ action: 'act_do', waitForPageId: 'k2_2' });
    await this.sleep(3000);
    logger.debug('I5フロー: 決定 → k2_2');

    // === k2_2 でスケジュール行が生成されたか検証 ===
    // 注意: HAM の k2_2 テーブルでは日付は最初の行にのみ表示される。
    // 後続の子行（2回目以降の I5 行、減算行）には日付テキストがないため、
    // 日付でフィルタリングせず「配置」ボタンの総数で判定する。
    const k2_2FrameCheck = await nav.getMainFrame('k2_2');
    const newRowCount = await k2_2FrameCheck.evaluate(() => {
      return document.querySelectorAll('input[name="act_modify"][value="配置"]').length;
    });

    if (newRowCount === 0) {
      throw new Error(
        `I5 転記失敗: 日付選択後にスケジュール行が生成されませんでした ` +
        `(${record.patientName}, ${record.visitDate}, ${record.startTime}-${record.endTime})`
      );
    }
    logger.info(`I5フロー: k2_2 にスケジュール行（配置ボタン）${newRowCount}行 を確認`);
    } // end if (!skipI5Creation)

    // === I5 スタッフ配置: 未配置の行すべてに同一スタッフを配置 ===
    let i5AssignIds: string[] = [];
    if (!skipI5StaffAssignment) {
      i5AssignIds = await this.assignStaffToAllUnassigned(nav, record);
    } else {
      logger.info(`I5 スタッフ配置スキップ（実績フラグのみ更新）: ${record.recordId}`);
    }

    // 全1ボタン（実績フラグ一括設定）
    const k2_2FrameI5 = await nav.getMainFrame('k2_2');
    const all1BtnI5 = await k2_2FrameI5.$('input[name="act_chooseall"]');
    if (all1BtnI5) {
      await all1BtnI5.click();
    } else {
      await this.clickSelectAll1(nav);
    }
    await this.sleep(1000);
    logger.debug('I5フロー: 全1ボタン実行');

    // 上書き保存
    const saveBtnI5 = await k2_2FrameI5.$('input[value="上書き保存"]');
    if (saveBtnI5) {
      await k2_2FrameI5.evaluate(() => { (window as any).submited = 0; }); // eslint-disable-line @typescript-eslint/no-explicit-any
      await saveBtnI5.click();
    } else {
      await nav.submitForm({ action: 'act_update', setLockCheck: true });
    }
    await this.sleep(3000);
    logger.debug('I5フロー: 上書き保存実行');

    // I5 保存結果検証（main flow の Step 13 と同等）
    const i5SaveContent = await nav.getFrameContent('k2_2');
    const hasI5Error = i5SaveContent.includes('エラー') &&
      !i5SaveContent.includes('配置') &&
      !i5SaveContent.includes('act_chooseall');
    if (hasI5Error) {
      throw new Error(`I5 HAM保存エラー: ${i5SaveContent.substring(0, 300)}`);
    }
    logger.debug('I5フロー: 保存結果検証OK');

    // スプレッドシート更新
    await this.sheets.updateTranscriptionStatus(sheetId, record.rowIndex, '転記済み', undefined, tab);
    await this.sheets.writeDataFetchedAt(sheetId, record.rowIndex, new Date().toISOString(), tab);
    // HAM assignId を保存（I5 は複数行の場合カンマ区切り）
    if (i5AssignIds.length > 0) {
      await this.sheets.writeHamAssignId(sheetId, record.rowIndex, i5AssignIds.join(','), tab);
    }
    logger.info(`転記完了(I5): ${record.recordId} - ${record.patientName} (${record.visitDate})`);

    // k2_2 の「戻る」ボタンで k2_1（利用者検索）に戻る
    await this.clickBackButtonOnK2_2(nav);
  }

  // ========== スタッフ自動補登 ==========

  /**
   * HAM h1-1a（登録スタッフ一覧）から全登録済みスタッフ名を取得
   *
   * 遷移: t1-2 → h1-1 → h1-1a（全件検索） → 名前リスト取得 → t1-2 に戻る
   */
  private async fetchHamStaffNames(nav: HamNavigator): Promise<Set<string>> {
    logger.info('HAM 登録スタッフ一覧を取得中...');

    // t1-2 → h1-1 (スタッフマスタ管理)
    await this.auth.navigateToStaffMaster();
    await this.sleep(1500);

    // h1-1 → h1-1a (登録スタッフ一覧)
    await nav.submitForm({
      action: 'act_edit',
      waitForPageId: 'h1-1a',
      timeout: 15000,
    });
    await this.sleep(2000);

    // h1-1a: 全件検索
    const h1_1aFrame = await nav.waitForMainFrame('h1-1a', 15000);

    // JS ロード待機 (xinwork_searchKeyword が定義されるまで)
    for (let i = 0; i < 20; i++) {
      const ready = await h1_1aFrame.evaluate(() =>
        typeof (window as any).xinwork_searchKeyword === 'function' // eslint-disable-line @typescript-eslint/no-explicit-any
      ).catch(() => false);
      if (ready) break;
      await this.sleep(500);
    }

    await h1_1aFrame.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      (window as any).submited = 0;
      const form = document.forms[0];
      form.doAction.value = 'act_search';
      form.target = 'commontarget';
      if (form.doTarget) form.doTarget.value = 'commontarget';
      form.submit();
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    // 検索結果待ち（「詳細」ボタン出現まで）
    let resultFrame: Frame | null = null;
    const searchStart = Date.now();
    while (Date.now() - searchStart < 15000) {
      await this.sleep(1000);
      try {
        const frame = await nav.getMainFrame();
        const count = await frame.evaluate(() =>
          document.querySelectorAll('input[type="button"][name="act_edit"][value="詳細"]').length
        ).catch(() => 0);
        if (count > 0) { resultFrame = frame; break; }
      } catch (e) { logger.debug(`スタッフ一覧フレーム待機中: ${(e as Error).message}`); }
    }

    if (!resultFrame) {
      logger.warn('スタッフ一覧の検索結果が15秒以内に表示されませんでした。空セットを返します');
    }

    const names = new Set<string>();

    if (resultFrame) {
      // h1-1a の HTML 構造:
      //   <tr><td>[詳細]</td><td>従業員番号</td><td>氏名</td>...</tr>
      const staffList = await resultFrame.evaluate(() => {
        const results: string[] = [];
        const btns = document.querySelectorAll('input[type="button"][name="act_edit"][value="詳細"]');
        for (const btn of Array.from(btns)) {
          const row = btn.closest('tr');
          const cells = row?.querySelectorAll('td');
          if (cells && cells.length >= 3) {
            const name = cells[2]?.textContent?.trim() || '';
            if (name) results.push(name);
          }
        }
        return results;
      });

      for (const name of staffList) {
        // 正規化: スペース除去 + NFKC + 旧字体→新字体（眞→真 等）
        const normalized = normalizeCjkName(name);
        names.add(normalized);
        // 元の名前もそのまま追加（全角スペース区切り等）
        names.add(name);
      }
      logger.info(`HAM 登録スタッフ: ${staffList.length}名`);
    } else {
      logger.warn('HAM h1-1a 検索結果を取得できませんでした');
    }

    // メインメニューに戻る
    await this.auth.navigateToMainMenu();

    return names;
  }

  /**
   * 転記対象レコードのスタッフが HAM に登録されているか事前チェックし、
   * 未登録のスタッフを SmartHR 経由で自動補登する。
   *
   * @returns 補登失敗で転記不可のスタッフ名のセット
   */
  private async ensureStaffRegistered(
    nav: HamNavigator,
    targets: TranscriptionRecord[],
  ): Promise<Set<string>> {
    // HAM の登録済みスタッフ名を取得
    const hamStaffNames = await this.fetchHamStaffNames(nav);

    // 転記対象の一意なスタッフを抽出
    const staffMap = new Map<string, { staffName: string; staffNumber: string }>();
    for (const r of targets) {
      if (!staffMap.has(r.staffName)) {
        staffMap.set(r.staffName, { staffName: r.staffName, staffNumber: r.staffNumber });
      }
    }

    // HAM に未登録のスタッフを特定
    // NFKC 正規化で CJK 異体字を統一（﨑→崎, 髙→高 等）
    // extractPlainName: "資格-姓名" 形式の場合、資格プレフィックスを除去して氏名のみ使用
    const missingStaff: { staffName: string; staffNumber: string }[] = [];
    for (const [staffName, info] of staffMap) {
      const normalized = normalizeCjkName(extractPlainName(staffName));
      if (!hamStaffNames.has(normalized) && !hamStaffNames.has(staffName)) {
        missingStaff.push(info);
      }
    }

    if (missingStaff.length === 0) {
      logger.info('全スタッフが HAM に登録済みです');
      return new Set();
    }

    logger.warn(`HAM 未登録スタッフ ${missingStaff.length}名: ${missingStaff.map(s => s.staffName).join(', ')}`);

    // SmartHR + StaffSync が未設定なら補登不可
    if (!this.smarthr || !this.staffSync) {
      logger.warn('SmartHR/StaffSync が未設定のため自動補登できません。該当レコードはエラーになります');
      return new Set(missingStaff.map(s => s.staffName));
    }

    // SmartHR から従業員情報を取得
    const empCodes = missingStaff
      .map(s => s.staffNumber)
      .filter(code => code !== '');

    if (empCodes.length === 0) {
      logger.warn('従業員番号が空のためSmartHR検索不可。該当レコードはエラーになります');
      return new Set(missingStaff.map(s => s.staffName));
    }

    const crewMap = await this.smarthr.getCrewsByEmpCodes(empCodes);
    logger.info(`SmartHR 検索結果: ${crewMap.size}/${empCodes.length}名`);

    // StaffMasterEntry に変換
    const entriesToRegister = [];
    const failedNames = new Set<string>();

    for (const staff of missingStaff) {
      const crew = crewMap.get(staff.staffNumber);
      if (!crew) {
        logger.error(`SmartHR にも見つかりません: ${staff.staffName} (emp_code=${staff.staffNumber})`);
        failedNames.add(staff.staffName);
        continue;
      }
      entriesToRegister.push(this.smarthr.toStaffMasterEntry(crew));
    }

    // TRITRUS + HAM に登録
    if (entriesToRegister.length > 0) {
      const syncResult = await this.staffSync.registerSpecificStaff(entriesToRegister);
      logger.info(`スタッフ補登結果: 登録=${syncResult.synced}, スキップ=${syncResult.skipped}, エラー=${syncResult.errors}`);

      // 登録失敗したスタッフを特定
      for (const detail of syncResult.details) {
        if (detail.phase1 === 'error') {
          failedNames.add(detail.staffName);
        }
      }

      // メインメニューに戻る
      await this.auth.navigateToMainMenu();
    }

    return failedNames;
  }

  // ========== ヘルパーメソッド ==========

  /**
   * k2_2 で未配置の全行にスタッフを配置する（I5 フロー用）
   *
   * I5 は 1レコードで複数行（例: 11:00-11:20 と 11:20-11:40）を生成する。
   * 各行の「配置」ボタンをクリック → スタッフ選択 → 確認 → 戻る を繰り返す。
   *
   * 注意: HAM の k2_2 テーブルでは日付は最初の行のみ表示。
   * 後続の子行（2回目以降）には日付テキストがないため、
   * 日付フィルタなしで全「配置」ボタンを対象にする。
   */
  private async assignStaffToAllUnassigned(
    nav: HamNavigator,
    record: TranscriptionRecord,
  ): Promise<string[]> {
    const hamPage = nav.hamPage;
    // CJK 異体字正規化: NFKC + 旧字体→新字体（眞→真, 﨑→崎 等）
    // extractPlainName: "資格-姓名" 形式の場合、資格プレフィックスを除去して氏名のみ使用
    const staffSearchName = normalizeCjkName(extractPlainName(record.staffName));

    // 未配置行の assignId を全て取得（日付フィルタなし — 子行には日付表示がないため）
    const frame = await nav.getMainFrame('k2_2');
    const unassignedIds: string[] = await frame.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[name="act_modify"][value="配置"]'));
      const ids: string[] = [];
      for (const btn of btns) {
        const tr = btn.closest('tr');
        // 担当スタッフ欄が空 = 未配置
        const staffCell = tr?.querySelector('td[bgcolor="#DDEEFF"]');
        if (staffCell?.textContent?.trim()) continue;
        const onclick = btn.getAttribute('onclick') || '';
        const m = onclick.match(/assignid\s*,\s*'(\d+)'/) || onclick.match(/assignid\.value\s*=\s*'(\d+)'/);
        if (m) ids.push(m[1]);
      }
      return ids;
    });

    if (unassignedIds.length === 0) {
      logger.debug('I5 スタッフ配置: 未配置行なし（既に配置済み）');
      return [];
    }

    logger.info(`I5 スタッフ配置: ${unassignedIds.length}行に「${record.staffName}」を配置`);

    for (let idx = 0; idx < unassignedIds.length; idx++) {
      const aid = unassignedIds[idx];
      logger.debug(`I5 スタッフ配置 ${idx + 1}/${unassignedIds.length}: assignId=${aid}`);

      // k2_2 → k2_2f（配置画面）
      const k2_2Frame = await nav.getMainFrame('k2_2');
      await k2_2Frame.evaluate((assignId) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const win = window as any;
        const form = document.forms[0];
        const lockChecks = document.getElementsByName('lockCheck');
        if (lockChecks[0]) (lockChecks[0] as HTMLInputElement).value = '1';
        win.submited = 0;
        if (typeof win.submitTargetFormEx === 'function') {
          win.submitTargetFormEx(form, 'act_modify', form.assignid, assignId);
        } else {
          form.assignid.value = assignId;
          form.doAction.value = 'act_modify';
          form.target = 'commontarget';
          if (form.doTarget) form.doTarget.value = 'commontarget';
          form.submit();
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
      }, aid);

      await nav.waitForMainFrame('k2_2f', 15000);
      await this.sleep(1000);

      // k2_2f の配置ボタンクリック
      const k2_2fFrame = await nav.getMainFrame('k2_2f');
      await k2_2fFrame.evaluate(() => { (window as any).submited = 0; }); // eslint-disable-line @typescript-eslint/no-explicit-any
      const haichiBtn = await k2_2fFrame.$('input[name="act_select"][value="配置"]');
      if (haichiBtn) {
        await haichiBtn.click();
      } else {
        await nav.submitForm({ action: 'act_select' });
      }
      await this.sleep(3000);

      // 従業員リスト待ち（全フレーム検索）
      let staffFrame: Frame | null = null;
      for (let i = 0; i < 20; i++) {
        for (const f of hamPage.frames()) {
          const hasList = await f.evaluate(() =>
            document.querySelectorAll('input[name="act_select"][value="選択"]').length > 0
          ).catch(() => false);
          if (hasList) { staffFrame = f; break; }
        }
        if (staffFrame) break;
        await this.sleep(1000);
      }
      if (!staffFrame) {
        throw new Error(`スタッフ選択リストが表示されません (assignId=${aid})`);
      }

      // HAM choice() でスタッフ選択（CJK 異体字正規化: NFKC + 旧字体→新字体）
      const choiceResult = await staffFrame.evaluate((args: { searchName: string; variantMap: [string, string][] }) => {
        function normCjk(s: string): string {
          let r = s.normalize('NFKC');
          for (const [old, rep] of args.variantMap) {
            if (r.includes(old)) r = r.replaceAll(old, rep);
          }
          return r.replace(/[\s\u3000\u00a0]+/g, '').trim();
        }
        const rows = Array.from(document.querySelectorAll('tr'));
        for (const row of rows) {
          const rowText = normCjk(row.textContent || '');
          if (!rowText.includes(args.searchName)) continue;
          const selectBtn = row.querySelector('input[name="act_select"][value="選択"]') as HTMLInputElement | null;
          if (!selectBtn || selectBtn.disabled) continue;
          const onclick = selectBtn.getAttribute('onclick') || '';
          const m = onclick.match(/choice\(this,\s*'(\d+)',\s*'([^']+)',\s*(\d+)\)/);
          if (!m) continue;
          (window as any).submited = 0; // eslint-disable-line @typescript-eslint/no-explicit-any
          if (typeof (window as any).choice === 'function') { // eslint-disable-line @typescript-eslint/no-explicit-any
            (window as any).choice(selectBtn, m[1], m[2], 1); // eslint-disable-line @typescript-eslint/no-explicit-any
            return { found: true, staffName: m[2] };
          }
          selectBtn.click();
          return { found: true, staffName: m[2] };
        }
        return { found: false, staffName: '' };
      }, { searchName: staffSearchName, variantMap: CJK_VARIANT_MAP_SERIALIZABLE });

      if (!choiceResult.found) {
        throw new Error(`スタッフ「${record.staffName}」が見つかりません`);
      }
      await this.sleep(3000);

      // 確認画面の決定ボタン
      let confirmClicked = false;
      for (let retry = 0; retry < 10; retry++) {
        for (const f of hamPage.frames()) {
          try {
            const hasConfirm = await f.evaluate(() => {
              const body = document.body?.innerText || '';
              return body.includes('スタッフでよろしければ') || body.includes('決定');
            }).catch(() => false);
            if (hasConfirm) {
              const ketteBtn = await f.$('input[value="決定"]');
              if (ketteBtn) {
                await f.evaluate(() => { (window as any).submited = 0; }); // eslint-disable-line @typescript-eslint/no-explicit-any
                await ketteBtn.click();
                confirmClicked = true;
                break;
              }
            }
          } catch (e) { logger.debug(`I5 確認画面フレーム検索エラー: ${(e as Error).message}`); }
        }
        if (confirmClicked) break;
        await this.sleep(1000);
      }
      await this.sleep(3000);

      if (!confirmClicked) {
        throw new Error(
          `I5 スタッフ配置不可：担当スタッフ「${record.staffName}」の確認画面（決定ボタン）が表示されませんでした。` +
          '同時間帯に他利用者の予定と重複しHAMで選択不可の可能性があります（手動配置が必要）'
        );
      }

      // 「戻る」リンクで k2_2 に戻る
      let backClicked = false;
      for (const f of hamPage.frames()) {
        try {
          const backLink = await f.$('a:has-text("戻る")');
          if (backLink) {
            await backLink.click();
            backClicked = true;
            break;
          }
        } catch (e) { logger.debug(`I5 戻るリンク検索中にフレームエラー: ${(e as Error).message}`); }
      }
      if (!backClicked) {
        await nav.submitForm({ action: 'act_back' });
      }
      await this.sleep(3000);

      // k2_2 に戻ったか確認
      for (let i = 0; i < 15; i++) {
        const pageId = await nav.getCurrentPageId();
        if (pageId === 'k2_2') break;
        await this.sleep(1000);
      }

      logger.debug(`I5 スタッフ配置 ${idx + 1}/${unassignedIds.length}: 完了`);
    }

    return unassignedIds;
  }

  /**
   * k2_2 の「戻る」ボタンをクリックして k2_1（利用者検索）に戻る
   *
   * HAM の「戻る」ボタンは submitTargetForm(form, 'act_back') を使う。
   * これは form.target を mainFrame にして submit するため、
   * 通常の submitForm（commontarget）とは異なる。
   */
  private async clickBackButtonOnK2_2(nav: HamNavigator): Promise<void> {
    const hamPage = nav.hamPage;
    let clicked = false;

    // k2_2 のフレームから「戻る」ボタンを探してクリック
    for (const frame of hamPage.frames()) {
      try {
        const backBtn = await frame.$('input[name="act_back"][value="戻る"]');
        if (backBtn) {
          await frame.evaluate(() => {
            (window as any).submited = 0; // eslint-disable-line @typescript-eslint/no-explicit-any
          });
          await backBtn.click();
          clicked = true;
          break;
        }
      } catch (e) { logger.debug(`k2_2 戻るボタン検索エラー: ${(e as Error).message}`); }
    }

    if (!clicked) {
      logger.warn('k2_2 の「戻る」ボタンが見つかりません。navigateToMainMenu にフォールバック');
      await this.auth.navigateToMainMenu();
      return;
    }

    // k2_1 に戻るまで待機
    for (let i = 0; i < 15; i++) {
      await this.sleep(1000);
      const pageId = await nav.getCurrentPageId();
      if (pageId === 'k2_1') {
        logger.debug('k2_2 → k2_1 に戻った');
        return;
      }
    }

    logger.warn('k2_1 への遷移がタイムアウト。現在のページで続行');
  }

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

    const result = await frame.evaluate(({ name, useHihokensha, hihokensha, variantMap }) => {
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
      // 比較時にスペースを除去 + NFKC + 旧字体→新字体（眞→真 等）で正規化する
      function normalize(s: string): string {
        let r = s.normalize('NFKC');
        for (const [old, rep] of variantMap) {
          if (r.includes(old)) r = r.replaceAll(old, rep);
        }
        return r.replace(/[\s\u3000\u00a0]+/g, '').trim();
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
    }, { name: patientName, useHihokensha: searchByHihokensha, hihokensha: hihokenshaBangou, variantMap: CJK_VARIANT_MAP_SERIALIZABLE });

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
   * 日付マッチ + 時刻マッチ + 未配置の行を優先して特定する。
   *
   * 田中穂純バグ修正: 同一患者・同一日に複数レコード (例: 16:00, 17:00) がある場合、
   * 日付のみのマッチだと間違った行を返す可能性がある。startTime を追加して
   * 日付+時刻+未配置 の3条件で正確にマッチする。
   */
  private async findNewAssignId(nav: HamNavigator, visitDateHam: string, startTime?: string): Promise<string | null> {
    const frame = await nav.getMainFrame('k2_2');
    const dayNum = parseInt(visitDateHam.substring(6, 8));
    const dayDisplay = `${dayNum}日`;

    const result = await frame.evaluate(({ targetDay, st }) => {
      // HAM k2_2 は rowspan で日付セルを結合するため、日付テキストは日グループの
      // 最初の <tr> にしか存在しない。全 <tr> を走査して currentDay を追跡し、
      // 各配置ボタンがどの日に属するかを判定する。
      const dayPattern = /(?:^|[^0-9])(\d{1,2})日/;
      const allRows = Array.from(document.querySelectorAll('tr'));

      // まず全行を走査して各行の所属日を記録
      const rowDayMap = new Map<Element, number>();
      let currentDay = -1;
      for (const row of allRows) {
        const m = (row.textContent || '').match(dayPattern);
        if (m) currentDay = parseInt(m[1]);
        rowDayMap.set(row, currentDay);
      }

      const btns = Array.from(document.querySelectorAll('input[name="act_modify"][value="配置"]'));
      const all: { id: string; hasStaff: boolean; matchDay: boolean; matchTime: boolean }[] = [];

      for (const btn of btns) {
        const onclick = btn.getAttribute('onclick') || '';
        const m = onclick.match(/assignid\s*,\s*'(\d+)'/) || onclick.match(/assignid\.value\s*=\s*'(\d+)'/);
        if (!m) continue;

        const tr = btn.closest('tr');
        const rowText = tr?.textContent || '';
        const staffCell = tr?.querySelector('td[bgcolor="#DDEEFF"]');
        const hasStaff = !!(staffCell?.textContent?.trim());
        const rowDay = tr ? (rowDayMap.get(tr) ?? -1) : -1;

        all.push({
          id: m[1],
          hasStaff,
          matchDay: rowDay === targetDay,
          matchTime: st ? rowText.includes(st) : true,
        });
      }

      // 優先1: 指定日 + 指定時刻 + 未配置（最も正確）
      for (const item of all) {
        if (item.matchDay && item.matchTime && !item.hasStaff) return item.id;
      }
      // 優先2: 指定日 + 未配置（時刻マッチなし — 後方互換）
      for (const item of all) {
        if (item.matchDay && !item.hasStaff) return item.id;
      }
      // 優先3: 未配置（最後）
      const unassigned = all.filter(i => !i.hasStaff);
      if (unassigned.length > 0) return unassigned[unassigned.length - 1].id;
      // 優先4: 指定日 + 指定時刻（最後）
      const dayTimeMatch = all.filter(i => i.matchDay && i.matchTime);
      if (dayTimeMatch.length > 0) return dayTimeMatch[dayTimeMatch.length - 1].id;
      // 優先5: 指定日（最後）
      const dayMatch = all.filter(i => i.matchDay);
      if (dayMatch.length > 0) return dayMatch[dayMatch.length - 1].id;
      // フォールバック
      if (all.length > 0) return all[all.length - 1].id;
      return null;
    }, { targetDay: dayNum, st: startTime || '' });

    if (result) {
      logger.debug(`assignId検出: ${result} (day=${dayDisplay}${startTime ? `, time=${startTime}` : ''})`);
    }
    return result;
  }

  /**
   * k2_2 で同一日付+開始時刻のスケジュールが既に存在するかチェック
   *
   * 行テキスト例: "9日  月  10:10 ～ 11:09  訪問看護基本療養費（Ⅰ・Ⅱ）"
   * 日付行の下に子行（日付なし）が続く場合がある。
   * 「配置」ボタンが存在する行（＝スタッフ配置済み）のみを "登録済み" と判定する。
   */
  /**
   * k2_2 で同一日付+開始時刻のスケジュールが既に存在するかチェック
   *
   * @returns 'complete'       — スケジュール＋スタッフ配置＋実績=1（完全に登録済み）
   *          'needs_jisseki' — スケジュール＋スタッフ配置済みだが実績≠1
   *          'partial'       — スケジュールあるがスタッフ未配置（部分登録）
   *          'none'          — エントリなし
   */
  /**
   * @param staffName スタッフ名（"資格-姓名" 形式）。指定時はスタッフ名一致する行のみを
   *   重複判定対象とする。同一日付+時刻に別スタッフのエントリがあっても 'none' を返す。
   *   これにより、同一患者の同一時間帯に複数スタッフの訪問がある場合の誤スキップを防止する。
   */
  private async checkDuplicateOnK2_2(
    nav: HamNavigator,
    visitDateHam: string,
    startTime: string,
    staffName?: string,
  ): Promise<'complete' | 'needs_jisseki' | 'partial' | 'none'> {
    const frame = await nav.getMainFrame('k2_2');
    const dayNum = parseInt(visitDateHam.substring(6, 8));
    const dayDisplay = `${dayNum}日`;

    // staffName から姓を抽出（"看護師-冨迫広美" → "冨迫"）
    const staffSurname = staffName
      ? extractPlainName(staffName.split('-')[1] || '').substring(0, 3)
      : '';

    const result = await frame.evaluate(({ dd, st, surname }) => {
      // 部分一致を防止: "1日" が "11日","21日","31日" にマッチしないよう正規表現で判定
      const dayRegex = new RegExp(`(?:^|[^0-9])${parseInt(dd)}日`);
      const rows = Array.from(document.querySelectorAll('tr'));
      let inTargetDay = false;
      let foundPartial = false;
      let foundNeedsJisseki = false;
      for (const row of rows) {
        const text = row.textContent || '';
        // 日付行を検出
        if (dayRegex.test(text)) {
          inTargetDay = true;
        } else if (/^\s*\d+日/.test(text.trim())) {
          // 別の日付行に入ったらリセット
          inTargetDay = false;
        }
        if (!inTargetDay) continue;
        if (!text.includes(st)) continue;
        // 編集ボタンがある → スケジュール存在
        const hasEdit = row.querySelector('input[value="編集"]');
        if (hasEdit) {
          // スタッフ配置済みかチェック（td[bgcolor="#DDEEFF"] = 担当スタッフ欄）
          const staffCell = row.querySelector('td[bgcolor="#DDEEFF"]');
          const staffText = (staffCell?.textContent || '').replace(/[\s\u3000]+/g, '');
          const hasStaff = !!staffText;

          // スタッフ名フィルタ: 指定されている場合、一致しない行は「別スタッフのエントリ」なのでスキップ
          if (surname && hasStaff && !staffText.includes(surname)) continue;

          if (hasStaff) {
            // 実績チェック: input[name="results"] が checked かつ value="1"
            const resultsCheckbox = row.querySelector('input[name="results"]') as HTMLInputElement | null;
            const hasJisseki = !!(resultsCheckbox?.checked && resultsCheckbox?.value === '1');
            if (hasJisseki) return 'complete';
            foundNeedsJisseki = true;
          } else {
            foundPartial = true;
          }
        }
      }
      if (foundNeedsJisseki) return 'needs_jisseki';
      return foundPartial ? 'partial' : 'none';
    }, { dd: dayDisplay, st: startTime, surname: staffSurname });

    if (result === 'complete') {
      logger.info(`重複検出（完了済み）: ${dayDisplay} ${startTime}${staffSurname ? ` [${staffSurname}]` : ''} — スケジュール＋スタッフ配置＋実績1。スキップします`);
    } else if (result === 'needs_jisseki') {
      logger.info(`実績未設定検出: ${dayDisplay} ${startTime}${staffSurname ? ` [${staffSurname}]` : ''} — スケジュール＋スタッフ配置済み・実績未設定`);
    } else if (result === 'partial') {
      logger.info(`部分登録検出: ${dayDisplay} ${startTime}${staffSurname ? ` [${staffSurname}]` : ''} — スケジュールあり・スタッフ未配置`);
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
   *   スタッフ欄: td[bgcolor="#DDEEFF"] に担当スタッフ名が表示される
   *
   * staffName を指定すると、同一日付+時刻に複数エントリがある場合に
   * スタッフ名でマッチする行を優先的に削除する（重複キー対策）。
   */
  private async deleteExistingSchedule(
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

    const deleteInfo = await frame.evaluate(({ targetDay, st, surname }) => {
      // HAM k2_2 は rowspan で日付セルを結合するため、日付テキストは日グループの
      // 最初の <tr> にしか存在しない。行を順番に走査し、最後に見つけた日付を追跡する。
      const dayRegex = /(?:^|[^0-9])(\d{1,2})日/;
      const rows = Array.from(document.querySelectorAll('tr'));
      let currentDay = -1;

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

        // 日付を含む行なら currentDay を更新
        const dayMatch = rowText.match(dayRegex);
        if (dayMatch) {
          currentDay = parseInt(dayMatch[1]);
        }

        // 目的の日でなければスキップ
        if (currentDay !== targetDay) continue;
        // 開始時刻が含まれていなければスキップ
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
    }, { targetDay: dayNum, st: startTime, surname: staffSurname });

    if (!deleteInfo.found) {
      logger.debug(`削除対象なし: ${dayDisplay} ${startTime}`);
      return false;
    }

    if (deleteInfo.candidateCount > 1) {
      logger.info(`重複キー検出: ${dayDisplay} ${startTime} に ${deleteInfo.candidateCount} 件のエントリ → スタッフ名「${staffSurname}」で${deleteInfo.staffMatch ? '一致' : 'フォールバック（最初の候補）'}`);
    }
    logger.info(`既存スケジュール削除: ${deleteInfo.rowText} (assignid=${deleteInfo.assignid})`);

    if (deleteInfo.record2flag === '1') {
      throw new Error(`record2flag=1: 記録書IIにより削除不可 (assignid=${deleteInfo.assignid})`);
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

    // confirmDelete() の挙動は二通り:
    //   A) 内部で form.submit() を実行 → ページリロード → サーバー側で削除完了
    //   B) クライアント側の UI 変更のみ → act_update（上書き保存）で永続化が必要
    // 両方に対応するため、まずページリロードを待って検証し、
    // 残存していれば act_update で永続化を試みる。

    // ページリロード完了を待つ（confirmDelete が form.submit() した場合に備える）
    await nav.waitForMainFrame('k2_2', 15000);
    await this.sleep(2000);

    // form.doAction の復元を待つ（後続の act_addnew で必須）
    for (let waitIdx = 0; waitIdx < 10; waitIdx++) {
      const f = await nav.getMainFrame('k2_2');
      const ready = await f.evaluate(() => {
        const form = document.forms[0];
        return !!(form && (form as HTMLFormElement & { doAction?: unknown }).doAction);
      }).catch(() => false);
      if (ready) break;
      await this.sleep(1000);
    }

    // 削除が反映されたか検証（同一日付+時刻のエントリが消えていること）
    const verifyFrame = await nav.getMainFrame('k2_2');
    const stillExists = await verifyFrame.evaluate(({ targetDay, st }) => {
      const dayRegex = /(?:^|[^0-9])(\d{1,2})日/;
      const rows = Array.from(document.querySelectorAll('tr'));
      let currentDay = -1;
      for (const row of rows) {
        const rowText = row.textContent || '';
        const dayMatch = rowText.match(dayRegex);
        if (dayMatch) currentDay = parseInt(dayMatch[1]);
        if (currentDay !== targetDay) continue;
        if (!rowText.includes(st)) continue;
        const delBtn = row.querySelector('input[name="act_delete"][value="削除"]');
        if (delBtn) return true;
      }
      return false;
    }, { targetDay: dayNum, st: startTime });

    if (!stillExists) {
      // パターン A: confirmDelete が内部 form.submit() でサーバー反映済み
      logger.info(`既存スケジュール削除完了（confirmDelete 内部処理）: assignid=${deleteInfo.assignid}`);
      return true;
    }

    // パターン B: confirmDelete はクライアント側のみ → 上書き保存で永続化
    logger.info('confirmDelete 後もレコード残存 → 上書き保存で永続化を試行');
    try {
      await nav.submitForm({
        action: 'act_update',
        setLockCheck: true,
        waitForPageId: 'k2_2',
      });
      await this.sleep(2000);
    } catch (saveErr) {
      throw new Error(
        `既存スケジュール削除の上書き保存に失敗しました（重複作成を防ぐため中断）: ${(saveErr as Error).message}`
      );
    }

    // 上書き保存後の再検証
    const verifyFrame2 = await nav.getMainFrame('k2_2');
    const stillExists2 = await verifyFrame2.evaluate(({ targetDay, st }) => {
      const dayRegex = /(?:^|[^0-9])(\d{1,2})日/;
      const rows = Array.from(document.querySelectorAll('tr'));
      let currentDay = -1;
      for (const row of rows) {
        const rowText = row.textContent || '';
        const dayMatch = rowText.match(dayRegex);
        if (dayMatch) currentDay = parseInt(dayMatch[1]);
        if (currentDay !== targetDay) continue;
        if (!rowText.includes(st)) continue;
        const delBtn = row.querySelector('input[name="act_delete"][value="削除"]');
        if (delBtn) return true;
      }
      return false;
    }, { targetDay: dayNum, st: startTime });

    if (stillExists2) {
      throw new Error(
        `既存スケジュール削除に失敗しました（上書き保存後もレコードが残存）: assignid=${deleteInfo.assignid}（重複作成を防ぐため中断）`
      );
    }

    logger.info(`既存スケジュール削除完了（上書き保存で永続化）: assignid=${deleteInfo.assignid}`);
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
          await frame.evaluate(() => {
            const btn = document.querySelector('input[type="button"], button');
            if (btn) (btn as HTMLElement).click();
          }).catch(() => {});
          await this.sleep(2000);
          break;
        }
      }

      // getCurrentPageId は URL + DOM を検証済み（k2_1 なら searchdate 存在チェック済み）
      const pageId = await nav.getCurrentPageId();

      if (pageId === 'k2_2') {
        // k2_2 にいる場合は「戻る」ボタンで k2_1 に戻る
        await this.clickBackButtonOnK2_2(nav);
        return;
      }
      if (pageId === 'k2_1') {
        // getCurrentPageId が k2_1 を返す = searchdate が実際に存在する
        logger.debug('tryRecoverToMainMenu: k2_1 にいるためそのまま続行');
        return;
      }

      // pageId が null（異常ページ）またはその他のページ → メインメニュー経由で完全復帰
      // navigateToMainMenu は forceNavigateToMainMenu まで含むため、
      // 異常ページからでも t1-2 に戻れる
      logger.info(`tryRecoverToMainMenu: pageId=${pageId} → メインメニューへ復帰`);
      await this.auth.navigateToMainMenu();
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
   * k2_3a でスタッフ資格に基づく searchKbn ラジオボタン + チェックボックスを選択
   *
   * ★全保険種別対応（介護/医療/精神医療）★
   * 介護 (showflag=1): searchKbn 非対応 → textRequire='・准' で准看護師を精准選択
   * 医療 (showflag=3): searchKbn + checkbox で資格フィルタ
   * 精神 (showflag=3): 同上 + flag2(緊急)
   *
   * 転記処理詳細.xlsx 全組み合わせ表に準拠:
   *   - searchKbn: 資格判定（看護師→1, 准看護師→2, 理学療法士等→3）
   *   - flag2=緊急: 精神医療+緊急+加算対象 のみ (ROW 50)
   *   - pluralnurseflag1=複数名訪問: 通常+複数人(主/副/看護+介護)+Q=false
   *     ROW 4-5,7(介護), ROW 20,22,24(医療), ROW 44,46,48(精神)
   *   - pluralnurseflag2=複数名訪問(二): (支援者/複数人(主)/看護+介護/複数人(副))+Q=true
   *     ROW 8-10(介護), ROW 17,21,25(医療), ROW 41,45,49,58,60,62(精神)
   *
   * 資格制限:
   *   - 医療+リハビリ: 理学療法士等のみ（看護師/准看護師→エラー）
   *   - 精神+リハビリ: 全資格OK（医療リハビリと異なる！）
   *   - 精神+通常+複数人(主/副)+Q=false: 主は看護師のみ（准/理学→エラー）
   */
  private async selectQualificationCheckbox(
    nav: HamNavigator,
    record: TranscriptionRecord,
    codeResult: ServiceCodeResult,
  ): Promise<void> {
    // 介護+リハビリ (useI5Page=true) は k2_3a を経由しないのでスキップ
    if (codeResult.useI5Page) return;

    // extractPlainName: "資格-姓名" 形式の場合、資格プレフィックスを除去して氏名のみで検索
    const lookupName = extractPlainName(record.staffName).replace(/[\s\u3000]+/g, '');
    let staffQuals = this.staffQualifications.get(lookupName) || [];

    // SmartHR に資格情報がない場合、staffName の資格プレフィックスから取得（フォールバック）
    // 例: "准看護師-冨迫広美" → ['准看護師'], "理学療法士等-阪本大樹" → ['理学療法士']
    if (staffQuals.length === 0) {
      const nameStr = record.staffName.trim();
      const dashIdx = nameStr.indexOf('-');
      if (dashIdx > 0) {
        const prefix = nameStr.substring(0, dashIdx);
        // 資格プレフィックスとして認識できるか確認
        const knownQuals = ['看護師', '准看護師', '理学療法士等', '理学療法士', '作業療法士', '言語聴覚士'];
        if (knownQuals.includes(prefix)) {
          staffQuals = [prefix];
          logger.debug(`資格フォールバック: ${record.staffName} → staffName から "${prefix}" を取得`);
        }
      }
      if (staffQuals.length === 0) {
        logger.warn(`資格情報なし: ${record.staffName} (lookup="${lookupName}")（デフォルト選択を使用）`);
        return;
      }
    }

    const isKaigo = record.serviceType1 === '介護';
    const isSeishin = record.serviceType1 === '精神医療';
    const isRehab = record.serviceType2 === 'リハビリ';
    const isKinkyu = record.serviceType2.startsWith('緊急');
    const pCol = record.accompanyClerkCheck?.trim() || '';
    const qTruthy = ['true', '1'].includes((record.multipleVisit?.trim().toLowerCase() || ''));
    const isKasanTaisho = record.emergencyClerkCheck?.trim() === '加算対象';

    // 資格判定（優先度: 看護師 > 准看護師 > 理学療法士等）
    const hasKangoshi = staffQuals.some(q => q === '看護師' || q === '正看護師');
    const hasJunKangoshi = staffQuals.some(q => q === '准看護師');
    const hasRigaku = staffQuals.some(q =>
      q.includes('理学療法士') || q.includes('作業療法士') || q.includes('言語聴覚士')
    );

    // --- 資格制限チェック ---
    // 医療+リハビリ: 理学療法士等のみ（看護師/准看護師はエラー）
    if (!isKaigo && !isSeishin && isRehab) {
      if (!hasRigaku && (hasKangoshi || hasJunKangoshi)) {
        throw new Error(
          `医療リハビリ資格制限: ${record.staffName} は看護師/准看護師のため医療リハビリに対応できません。` +
          '理学療法士/作業療法士/言語聴覚士のみ可能です。'
        );
      }
    }

    // 精神+通常+複数人(主/副)+Q=false: 主は看護師のみ（准/理学→エラー）
    if (isSeishin && record.serviceType2.startsWith('通常') &&
        ['複数人(主)', '複数人(副)'].includes(pCol) && !qTruthy) {
      if (pCol === '複数人(主)' && !hasKangoshi) {
        throw new Error(
          `精神科複数人資格制限: ${record.staffName} — 精神+複数人(主)は看護師のみ可。` +
          '准看護師/理学療法士等はエラー対象です。'
        );
      }
    }

    // --- searchKbn (資格ラジオ) 決定 ---
    let qualType: 'kangoshi' | 'junkangoshi' | 'rigaku';

    if (!isKaigo && !isSeishin && isRehab) {
      // 医療+リハビリ: 理学療法士等固定 (ROW 28)
      qualType = 'rigaku';
    } else if (isSeishin && isRehab) {
      // 精神+リハビリ: 全資格OK → 優先順位で判定 (ROW 52-62)
      if (hasKangoshi) qualType = 'kangoshi';
      else if (hasJunKangoshi) qualType = 'junkangoshi';
      else if (hasRigaku) qualType = 'rigaku';
      else return;
    } else {
      // 介護+通常/緊急, 医療+通常/緊急, 精神+通常/緊急: 看護師 > 准看護師 > 理学療法士等
      if (hasKangoshi) qualType = 'kangoshi';
      else if (hasJunKangoshi) qualType = 'junkangoshi';
      else if (hasRigaku) qualType = 'rigaku';
      else return;
    }

    // --- k2_3a チェックボックス決定 ---
    const checkboxes: {
      flag2?: boolean;            // 緊急
      pluralnurseflag1?: boolean; // 複数名訪問
      pluralnurseflag2?: boolean; // 複数名訪問(二)
    } = {};

    // flag2=緊急: 緊急+加算対象 → k2_3a で ・緊急 サービスを表示するために必須
    //   医療 ROW 26 / 精神 ROW 50（全保険種別共通）
    //   ★ flag2 を ON にしないと HAM は ・緊急 付きサービスを候補に表示しない
    if (isKinkyu && isKasanTaisho) {
      checkboxes.flag2 = true;
    }

    // pluralnurseflag1=複数名訪問: 通常+複数人(主/副/看護+介護)+Q=false
    //   介護 ROW 4-5,7 / 医療 ROW 20,22,24 / 精神 ROW 44,46,48
    if (record.serviceType2.startsWith('通常') &&
        ['複数人(主)', '複数人(副)', '複数人(看護+介護)'].includes(pCol) && !qTruthy) {
      checkboxes.pluralnurseflag1 = true;
    }

    // pluralnurseflag2=複数名訪問(二): (支援者/複数人(主)/看護+介護/複数人(副))+Q=true
    //   ★介護 ROW 8-10 / 医療 ROW 17,21,25 のみ★
    //   ★精神医療は Q=TRUE でも複数名訪問(二)を設定しない（基本サービスを選択）★
    //   精神の Q=TRUE 行（ROW 41,45,47,49,54,58,60,62）はすべて基本サービスを使用し、
    //   ・複数名サフィックスなし。医療と異なり checkbox 不要。
    if (!isSeishin && ['支援者', '複数人(主)', '複数人(看護+介護)', '複数人(副)'].includes(pCol) && qTruthy) {
      checkboxes.pluralnurseflag2 = true;
    }

    // --- 実行: searchKbn + checkboxes → 検索 ---
    await this.selectQualificationInFrame(nav, qualType, checkboxes);

    // ★ 介護・医療 + 准看護師: textRequire='・准' で精准選択
    //
    // HAM CSV 実績確認済みの ・准 サフィックス付きサービス:
    //   介護: 訪看Ⅰ２・准, 訪看Ⅰ３・准 等 (showflag=1/2, searchKbn 非対応)
    //   医療: 訪問看護基本療養費（Ⅰ・Ⅱ）・准 (showflag=3, searchKbn 対応だが防御的に設定)
    //
    // 精神科は ・准 サフィックスが存在しないため対象外
    // (精神は searchKbn + serviceitem コードレベルで看護師/准看護師を区別)
    if (!isSeishin && qualType === 'junkangoshi' && !codeResult.textRequire) {
      codeResult.textRequire = '・准';
      logger.debug(`${record.serviceType1}+准看護師: textRequire='・准' (精准一致)`);
    }

    logger.debug(`Step 7.5: 資格選択 → ${qualType} (${record.staffName})` +
      (checkboxes.flag2 ? ' [flag2=緊急]' : '') +
      (checkboxes.pluralnurseflag1 ? ' [複数名訪問]' : '') +
      (checkboxes.pluralnurseflag2 ? ' [複数名訪問(二)]' : ''));
  }

  /**
   * k2_3a フレーム内で searchKbn ラジオボタン + チェックボックスを設定し、検索を実行
   *
   * HAM HTML (k2_3a):
   *   searchKbn: 1=看護師等, 2=准看護師, 3=理学療法士等, 4=悪性腫瘍, 5=外泊, 6=緊急加算のみ, 99=すべて
   *   flag2: 緊急, longcareflag: 長時間, infantcareflag: 乳幼児
   *   pluralnurseflag1: 複数名訪問, pluralnurseflag2: 複数名訪問(二)
   *   検索ボタン: onclick="submitTargetForm(this.form, 'act_change')"
   */
  private async selectQualificationInFrame(
    nav: HamNavigator,
    qualType: 'kangoshi' | 'junkangoshi' | 'rigaku',
    checkboxes?: {
      flag2?: boolean;
      pluralnurseflag1?: boolean;
      pluralnurseflag2?: boolean;
    },
  ): Promise<void> {
    const valueMap: Record<string, string> = {
      kangoshi: '1',
      junkangoshi: '2',
      rigaku: '3',
    };
    const targetValue = valueMap[qualType];

    const frame = await nav.getMainFrame('k2_3a');

    // searchKbn ラジオボタンを選択 + チェックボックスを設定
    await frame.evaluate((args: { searchKbnValue: string; cbs: { flag2?: boolean; pluralnurseflag1?: boolean; pluralnurseflag2?: boolean } }) => {
      // searchKbn ラジオボタン
      const radios = document.querySelectorAll('input[name="searchKbn"]');
      for (const radio of Array.from(radios)) {
        const r = radio as HTMLInputElement;
        if (r.value === args.searchKbnValue) {
          r.checked = true;
          r.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }

      // チェックボックス設定（全 checkbox を明示的に目標状態に設定）
      // ★ HAM が URL パラメータ等で checkbox を pre-check する場合があるため、
      //   必要ないものは明示的に OFF にしないと誤ったフィルタ結果になる
      const setCheckbox = (name: string, checked: boolean) => {
        const cb = document.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
        if (cb) {
          cb.checked = checked;
          if (checked) cb.value = '1';
        }
      };
      setCheckbox('flag2', !!args.cbs.flag2);
      setCheckbox('pluralnurseflag1', !!args.cbs.pluralnurseflag1);
      setCheckbox('pluralnurseflag2', !!args.cbs.pluralnurseflag2);
    }, { searchKbnValue: targetValue, cbs: checkboxes || {} });

    // 検索ボタンをクリックしてフィルタ結果を表示
    await frame.evaluate(() => {
      const buttons = document.querySelectorAll('input[type="button"]');
      for (const btn of Array.from(buttons)) {
        const b = btn as HTMLInputElement;
        if (b.value === '検索') {
          b.click();
          break;
        }
      }
    });

    // ページリロード待ち（検索結果表示まで）
    await this.sleep(2000);
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

    // スタッフ配置不可（同時間帯重複）— schedule は作成済みだが手動配置が必要
    if (msg.includes('スタッフ配置不可')) {
      return {
        status: 'エラー：システム',
        category: 'system',
        detail: 'スタッフ配置不可：担当スタッフが同時間帯に他利用者の予定と重複しHAMで選択不可（手動配置が必要）',
      };
    }

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
