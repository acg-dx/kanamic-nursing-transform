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
import { BrowserManager } from '../../core/browser-manager';
import { withRetry } from '../../core/retry-manager';
import { normalizeCjkName, CJK_VARIANT_MAP_SERIALIZABLE, extractPlainName, resolveStaffAlias, STAFF_NAME_ALIASES, QUALIFICATION_PREFIXES, STAFF_EMPCODE_OVERRIDES } from '../../core/cjk-normalize';
import { ServiceCodeResolver } from '../../services/service-code-resolver';
import { PatientMasterService } from '../../services/patient-master.service';
import { PatientCsvDownloaderService } from '../../services/patient-csv-downloader.service';
import type { ServiceCodeResult } from '../../services/service-code-resolver';
import { getTimetype, getTimePeriod, parseTime, toHamDate, toHamMonthStart, calcDurationMinutes, calcCorrectedEndTime } from '../../services/time-utils';
import { CorrectionSheetSync } from '../correction/correction-sheet-sync';
import type { Frame, Page } from 'playwright';
import type { HamNavigator } from '../../core/ham-navigator';
import { PAGE_DEATH_KEYWORDS, isPageCrashError } from '../../core/ham-error-keywords';
import type { WorkflowContext, WorkflowResult, WorkflowError, TranscriptionStatus } from '../../types/workflow.types';
import type { TranscriptionRecord } from '../../types/spreadsheet.types';
import type { SheetLocation } from '../../types/config.types';
import type { SmartHRService } from '../../services/smarthr.service';
import type { StaffSyncService } from '../../workflows/staff-sync/staff-sync.workflow';
import { ReconciliationService } from '../../services/reconciliation.service';
import type { VerificationResult, VerificationMismatch } from '../../services/reconciliation.service';
import { ScheduleCsvDownloaderService, computeVerificationDateRange } from '../../services/schedule-csv-downloader.service';

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
    // 名前フォーマットが異なるため、空白除去 + CJK 正規化した Map を作成する
    // 例: "髙山 利愛" → "高山利愛" (髙→高 異体字正規化)
    this.staffQualifications = new Map();
    for (const [name, quals] of qualMap) {
      const raw = name.replace(/[\s\u3000]+/g, '');
      this.staffQualifications.set(raw, quals);
      // CJK 正規化した名前でも登録（異体字検索に対応）
      const normalized = normalizeCjkName(raw);
      if (normalized !== raw) {
        this.staffQualifications.set(normalized, quals);
      }
    }
  }

  /** SmartHR + StaffSync を設定（転記前スタッフ自動補登用） */
  setStaffAutoRegister(smarthr: SmartHRService, _staffSync?: StaffSyncService): void {
    this.smarthr = smarthr;
    // staffSync は processLocation で location ごとに動的生成するため、ここでは設定しない
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

    // ロック済みレコードの自動解除
    for (const record of records) {
      if (!record.recordLocked) continue;

      const isAlreadyTranscribed = record.transcriptionFlag === '転記済み' || record.transcriptionFlag === '修正あり';

      if (isAlreadyTranscribed && record.updatedAt && record.dataFetchedAt) {
        // ケース1: 転記済みロック → 転記後にデータが更新されていれば再転記のためロック解除
        const updatedAt = new Date(record.updatedAt);
        const dataFetchedAt = new Date(record.dataFetchedAt);
        if (updatedAt > dataFetchedAt) {
          logger.info(`ロック自動解除: row=${record.rowIndex}, recordId=${record.recordId} (updatedAt=${record.updatedAt} > dataFetchedAt=${record.dataFetchedAt})`);
          await this.sheets.unlockRecord(location.sheetId, record.rowIndex, tab);
          await this.sheets.updateTranscriptionStatus(location.sheetId, record.rowIndex, '修正あり', undefined, tab);
          record.recordLocked = false;
          record.transcriptionFlag = '修正あり';
        }
      } else if (!isAlreadyTranscribed) {
        // ケース2: 未転記のままロックされている（異常状態） → ロックを解除して転記対象に戻す
        logger.warn(
          `未転記ロック検出 → 自動解除: row=${record.rowIndex}, recordId=${record.recordId}, ` +
          `transcriptionFlag='${record.transcriptionFlag}' (転記済みでないのにロックされていた)`,
        );
        await this.sheets.unlockRecord(location.sheetId, record.rowIndex, tab);
        record.recordLocked = false;
      }
    }

    // === 修正管理シート駆動の強制フラグ設定 ===
    // updatedAt > dataFetchedAt のタイミング問題で修正が見逃されるバグを防止するため、
    // 修正管理シートの「上書きOK」かつ未処理のレコードで月次シートのフラグを強制設定する。
    const corrSync = new CorrectionSheetSync(this.sheets);
    let correctionMap = new Map<string, number[]>();
    try {
      const pendingCorrections = await corrSync.getUnprocessedCorrections(location.sheetId);
      if (pendingCorrections.length > 0) {
        logger.info(`修正管理シート: 未処理修正 ${pendingCorrections.length}件を検出`);
        correctionMap = await corrSync.applyCorrectionsToRecords(
          pendingCorrections, records, location.sheetId, tab
        );
      }
    } catch (error) {
      logger.warn(`修正管理シート同期エラー（転記は続行）: ${(error as Error).message}`);
    }

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

    // HAM にログイン（リトライ時に再代入するため let）
    let nav = await this.auth.ensureLoggedIn();

    // location に対応する StaffSyncService を動的生成（事業所ごとに異なる office 情報を使用）
    if (this.smarthr) {
      const { StaffSyncService } = await import('../staff-sync/staff-sync.workflow');
      this.staffSync = new StaffSyncService(this.smarthr, this.auth, {
        cd: location.tritrusOfficeCd,
        name: location.stationName,
      });
      logger.info(`スタッフ補登: ${location.name} (${location.stationName}) 用に初期化`);
    }

    // === 事業所ごとの利用者マスタ CSV を読み込み ===
    try {
      const csvDownloader = new PatientCsvDownloaderService(this.auth);
      const targetMonth = PatientCsvDownloaderService.getCurrentMonth();

      for (let csvAttempt = 0; csvAttempt < 2; csvAttempt++) {
        try {
          const csvPath = await csvDownloader.ensurePatientCsv({
            targetMonth,
            force: csvAttempt > 0,
            officeCd: location.tritrusOfficeCd,
          });
          const patientMaster = new PatientMasterService();
          await patientMaster.loadFromCsv(csvPath);
          this.patientMaster = patientMaster;
          logger.info(
            `利用者マスタ[${location.name}]: ${patientMaster.count}名読み込み完了` +
            `${csvAttempt > 0 ? '（リトライ成功）' : ''} (officeCd=${location.tritrusOfficeCd})`,
          );
          break;
        } catch (csvError) {
          if (csvAttempt === 0) {
            logger.warn(`利用者マスタ CSV ダウンロード失敗[${location.name}]（リトライします）: ${(csvError as Error).message}`);
            try { await this.auth.navigateToMainMenu(); } catch { /* ignore */ }
          } else {
            logger.error(
              `利用者マスタ CSV ダウンロード 2回失敗[${location.name}]（要支援患者の介護度判定が無効です）: ` +
              `${(csvError as Error).message}`,
            );
          }
        }
      }
    } catch (err) {
      logger.error(`利用者マスタ CSV ローダーエラー[${location.name}]: ${(err as Error).message}`);
    }

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

    // Cloud Run タイムアウト防止: 3400秒（約56分）で優雅に終了し、残りは次回実行に委ねる
    const GRACEFUL_TIMEOUT_MS = 85_000_000; // 約23.6時間（Cloud Run task-timeout=86400s に対応）
    const workflowStartTime = Date.now();

    let recordIndex = 0;
    for (const record of executableTargets) {
      recordIndex++;

      // タイムアウト守衛: 残り時間不足なら安全に終了
      const elapsed = Date.now() - workflowStartTime;
      if (elapsed > GRACEFUL_TIMEOUT_MS) {
        const remaining = executableTargets.length - recordIndex + 1;
        logger.warn(`タイムアウト守衛: ${Math.round(elapsed / 1000)}秒経過 — 残り${remaining}件を次回実行に委ねて終了します`);
        break;
      }

      // 20件ごとにメモリ使用量をログ出力
      if (recordIndex % 20 === 0) {
        BrowserManager.logMemoryUsage(`${location.name} ${recordIndex}/${executableTargets.length}件目`);
      }
      if (dryRun) {
        logger.info(`[DRY RUN] 転記スキップ: ${record.recordId} - ${record.patientName}`);
        processedRecords++;
        continue;
      }

      try {
        await withRetry(
          () => {
            // 単一レコード処理を5分タイムアウトで保護（ページ死亡で無限ハングを防止）
            const RECORD_TIMEOUT_MS = 300_000;
            return Promise.race([
              this.processRecord(record, nav, location.sheetId, tab),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(
                  `レコード処理タイムアウト（${RECORD_TIMEOUT_MS / 1000}秒）: ${record.recordId} — ページ死亡の可能性`
                )), RECORD_TIMEOUT_MS)
              ),
            ]);
          },
          `転記[${record.recordId}]`,
          {
            maxAttempts: 2,
            baseDelay: 3000,
            maxDelay: 15000,
            backoffMultiplier: 2,
            isNonRetryable: (err) => {
              // データ不備系エラーは再試行しても解決しない → 即座にスキップ
              const m = err.message;
              return m.includes('資格情報なし')
                || m.includes('資格制限')
                || m.includes('不明なサービス種別')
                || m.includes('患者が見つかりません')
                || m.includes('マスタ不備')
                || m.includes('スタッフ配置不可');
            },
            onRetry: async (attempt, _err) => {
              // エラー後のリトライ: まずブラウザ/セッション健全性を確認し、
              // 必要に応じて再ログイン。その後メインメニュー → k2_1 まで再遷移。
              // 全体を3分タイムアウトで保護（各ステップのハングを防止）
              const errMsg = _err?.message || '';
              const isServerError = ['メモリ不足', 'このページを開けません', 'Out of Memory',
                'サーバーエラー', '一時的に利用できません',
                'E00010', 'syserror', 'chrome-error', 'net::', 'Execution context was destroyed',
                'クラッシュ', 'Target closed', 'Session closed',
                'Target crashed', 'Page crashed', 'page has been closed',
                'browser has been closed', 'Browser closed', 'Connection closed',
                'ページ死亡検出', 'ページ応答なし', 'ページクラッシュ検出',
                'レコード処理タイムアウト',
              ].some(k => errMsg.includes(k));

              if (isServerError) {
                // HAM サーバー側のエラー → サーバー復旧を待ってからリトライ
                const waitSec = 10 * attempt;
                logger.warn(`HAM サーバーエラー検出 — ${waitSec}秒待機後にリトライ: ${errMsg.substring(0, 100)}`);
                await this.sleep(waitSec * 1000);
              }

              logger.info('ページ復旧: セッション確認 → メインメニュー → 利用者検索まで再遷移');
              const recoveryTimeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('ページ復旧タイムアウト（3分）')), 180_000)
              );
              await Promise.race([
                (async () => {
                  // OOM / ページクラッシュ検出 → ensureLoggedIn がブラウザ再起動を処理
                  // ensureLoggedIn 内の relaunchIfAnyPageDead が全ページを検査し、
                  // 死亡ページがあればブラウザ再起動 + 再ログインを自動実行する。
                  // 個別リロードは不要（ensureLoggedIn が最適な復旧を判断）。
                  nav = await this.auth.ensureLoggedIn();
                  await this.auth.navigateToMainMenu();
                  await this.auth.navigateToBusinessGuide();
                  await this.auth.navigateToUserSearch();
                })(),
                recoveryTimeout,
              ]);
            },
          }
        );
        processedRecords++;
        consecutiveErrors = 0; // 成功でリセット

        // 修正管理シートの該当レコードを「処理済み」にマーク
        const corrRows = correctionMap.get(record.recordId);
        if (corrRows && corrRows.length > 0) {
          try {
            await corrSync.markProcessed(location.sheetId, corrRows);
            logger.info(`修正管理処理済みマーク: recordId=${record.recordId} (${corrRows.length}件)`);
          } catch (markErr) {
            logger.warn(`修正管理処理済みマーク失敗（次回再処理される）: ${(markErr as Error).message}`);
          }
        }
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
        nav = await this.tryRecoverToMainMenu(nav);
      }
    }

    // ── 検証ステップ (VER-01): 転記完了後に自動実行 ──
    // 転記後の最新レコードを再取得（新たに「転記済み」になったレコードを含む）
    const freshRecords = await this.sheets.getTranscriptionRecords(location.sheetId, tab);
    const verificationOutcome = await this.runVerification(location, freshRecords, tab);
    // D-10: 検証スキップ情報を WorkflowResult に含める
    if (!verificationOutcome.ran && verificationOutcome.error) {
      errors.push({
        recordId: 'verification',
        message: `検証スキップ: ${verificationOutcome.error}`,
        category: 'system' as const,
        recoverable: false,
        timestamp: new Date().toISOString(),
      });
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
   * 転記完了後の自動検証ステップ (VER-01, VER-02, RPT-01)
   * 各事業所の processLocation() 完了直後に実行される。
   * エラー発生時は logger.warn で記録し、転記ワークフローは続行する (D-09)。
   */
  private async runVerification(
    location: SheetLocation,
    records: TranscriptionRecord[],
    tab?: string,
  ): Promise<{ ran: boolean; error?: string }> {
    try {
      // ── VER-02: 「転記済み」かつ「未検証」のレコードを抽出 ──
      const unverified = records.filter(
        r => r.transcriptionFlag === '転記済み' && !r.verifiedAt,
      );
      if (unverified.length === 0) {
        logger.info(`[${location.name}] 検証: 未検証レコードなし — スキップ`);
        return { ran: true };
      }

      // ── D-02: 当月タブの未検証レコードの日付範囲でCSV取得 ──
      const dateRanges = computeVerificationDateRange(unverified);
      if (!dateRanges || dateRanges.length === 0) {
        logger.warn(`[${location.name}] 検証: 日付範囲を計算できませんでした — スキップ`);
        return { ran: false, error: '日付範囲計算失敗' };
      }

      // D-01: HAMセッションが生きている間にCSVダウンロード
      const csvDownloader = new ScheduleCsvDownloaderService(this.auth);
      // 当月のみ (D-02) — dateRanges[0] を使用（当月タブなので通常1エントリ）
      const dr = dateRanges[0];
      const csvPath = await csvDownloader.downloadScheduleCsv({
        targetMonth: dr.targetMonth,
        startDay: dr.startDay,
        endDay: dr.endDay,
        force: true,
      });

      // ── ReconciliationService.verify() で突合 ──
      const reconciliation = new ReconciliationService(this.sheets);
      const result: VerificationResult = await reconciliation.verify(csvPath, unverified);

      // ── STS-01/STS-02: Sheets に検証結果を書き込む ──
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, '');
      // 不一致レコードを recordId でルックアップ用マップに変換
      const mismatchMap = new Map(result.mismatches.map(m => [m.recordId, m]));

      for (const r of unverified) {
        const mm = mismatchMap.get(r.recordId);
        // 不一致の場合はエラー詳細、一致の場合は空文字列
        const errorDetail = mm ? this.formatMismatchError(mm) : '';

        await this.sheets.writeVerificationStatus(
          location.sheetId,
          r.rowIndex,
          now,
          errorDetail,
          tab,
        );
      }

      // ── RPT-01: コンソール報告 ──
      this.logVerificationSummary(location.name, result, unverified.length);

      return { ran: true };
    } catch (error) {
      // D-09: 検証エラーは転記ワークフローを停止しない
      const msg = (error as Error).message;
      logger.warn(`[${location.name}] 検証ステップでエラーが発生しました（転記は正常完了）: ${msg}`);
      return { ran: false, error: msg };
    }
  }

  /**
   * VerificationMismatch からエラー詳細文字列を生成する。
   * 例: "missing_in_ham" or "time,service" or "staff"
   */
  private formatMismatchError(mm: VerificationMismatch): string {
    if (mm.missingFromHam) {
      return 'missing_in_ham';
    }
    const parts: string[] = [];
    if (mm.timeMismatch) {
      parts.push('time');
    }
    if (mm.serviceMismatch) {
      parts.push('service');
    }
    if (mm.staffMismatch) {
      parts.push('staff');
    }
    return parts.length > 0 ? parts.join(',') : 'unknown_mismatch';
  }

  /**
   * 検証サマリーをコンソールに出力する (D-06, D-07, D-08)
   */
  private logVerificationSummary(
    locationName: string,
    result: VerificationResult,
    checkedCount: number,
  ): void {
    // D-06: 事業所ごとのサマリー
    logger.info('─'.repeat(50));
    logger.info(`[${locationName}] 検証サマリー:`);
    logger.info(`  チェック件数: ${checkedCount}`);
    logger.info(`  一致: ${result.matched}`);
    logger.info(`  不一致: ${result.mismatches.length}`);
    logger.info(`  extraInHam: ${result.extraInHam.length}`);

    // D-07: 不一致レコードの詳細 (logger.warn)
    for (const mm of result.mismatches) {
      const mismatchTypes: string[] = [];
      if (mm.missingFromHam) mismatchTypes.push('missing_in_ham');
      if (mm.timeMismatch) mismatchTypes.push('time');
      if (mm.serviceMismatch) mismatchTypes.push('service');
      if (mm.staffMismatch) mismatchTypes.push('staff');
      logger.warn(`  不一致: ${mm.patientName} ${mm.visitDate} — ${mismatchTypes.join(',')}`);
    }

    // D-08: extraInHam (logger.info — 情報レベル)
    for (const extra of result.extraInHam) {
      logger.info(`  extraInHam: ${extra.patientName} ${extra.visitDate}`);
    }
    logger.info('─'.repeat(50));
  }

  /**
   * HAM上の1レコードを assignId で削除する (FIX-01)
   * DeletionWorkflow.processRecord() の HAM 削除部分を簡略化して再実装。
   * 削除Sheet操作・重複ペア処理は不要（月次シート行は残す → 再転記で上書き）。
   */
  private async deleteHamRecord(
    nav: HamNavigator,
    record: TranscriptionRecord,
  ): Promise<boolean> {
    // === Step 1: メインメニュー → 業務ガイド → 利用者検索 ===
    await this.auth.navigateToBusinessGuide();
    await this.auth.navigateToUserSearch();

    // === Step 2: 年月設定 → 全患者検索 ===
    const monthStart = toHamMonthStart(record.visitDate);
    await nav.setSelectValue('searchdate', monthStart);
    await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_1' });
    await this.sleep(1000);

    // === Step 3: 患者特定 ===
    const patientId = await this.findPatientId(nav, record);
    if (!patientId) {
      logger.warn(`[自動修正] 患者が見つかりません: ${record.patientName} — 削除スキップ`);
      return false;
    }

    // === Step 4: k2_2 へ遷移 ===
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

    // === Step 5: assignId で削除 ===
    const assignIds = (record.hamAssignId || '').split(',').filter(Boolean);
    if (assignIds.length === 0) {
      logger.warn(`[自動修正] assignId が空です: ${record.recordId} — 削除スキップ`);
      return false;
    }

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
        logger.warn(`[自動修正] assignId=${trimmedId} の削除ボタンが見つかりません（既に削除済みの可能性）`);
        continue;
      }

      if (btnInfo.record2flag === '1') {
        logger.warn(`[自動修正] 記録書IIが存在するため削除不可: assignId=${trimmedId}`);
        continue;
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
      } else {
        // フォールバック: confirmDelete 直接呼び出し
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
      }
      logger.debug(`[自動修正] assignId=${trimmedId} 削除完了 (${deletedCount}/${assignIds.length})`);
    }

    if (deletedCount === 0) {
      logger.warn(`[自動修正] 削除対象が見つかりませんでした: ${record.recordId}`);
      return false;
    }

    // === Step 6: 上書き保存 ===
    await nav.submitForm({
      action: 'act_update',
      setLockCheck: true,
      waitForPageId: 'k2_2',
    });
    await this.sleep(2000);
    logger.info(`[自動修正] HAM削除完了: ${record.patientName} ${record.visitDate} (${deletedCount}件)`);
    return true;
  }

  /**
   * 重複ペアの跨レコードバリデーション
   *
   * 同一キー（患者名+日付+開始時刻+終了時刻）のグループで N列=重複 のレコードがあり:
   *   1. いずれかの P列が空欄 → グループ全体をブロック（事務員未判定）
   *   2. 全 P列が入力済み → 資格優先度が最も高いスタッフの1件のみ転記対象、残りをブロック
   *      優先度: 看護師 > 准看護師 > その他
   *
   * キーは看護記録転記プロジェクト (data-writer.ts buildDuplicateKeys) と同一基準。
   *
   * @returns ブロック対象の recordId セット
   */
  private buildDuplicateBlockedSet(records: TranscriptionRecord[]): Set<string> {
    // Step 1: 重複レコードをキーでグループ化
    const groups = new Map<string, TranscriptionRecord[]>();
    for (const r of records) {
      if (!r.accompanyCheck.includes('重複')) continue;
      const key = `${normalizeCjkName(r.patientName)}|${r.visitDate}|${r.startTime}|${r.endTime}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }

    const blocked = new Set<string>();
    for (const [key, group] of groups) {
      // Step 2a: いずれかの P列が空 → グループ全体をブロック
      if (group.some(r => !r.accompanyClerkCheck.trim())) {
        for (const r of group) {
          blocked.add(r.recordId);
        }
        continue;
      }

      // Step 2b: 全 P列入力済み → 資格が最も高い1件のみ転記、残りをブロック
      if (group.length <= 1) continue;

      // スタッフ名プレフィックスから資格スコアを算出（看護師=2, 准看護師=1, その他=0）
      const scored = group.map(r => {
        const name = r.staffName || '';
        const pCol = r.accompanyClerkCheck?.trim() || '';
        // 同行者は isTranscriptionTarget で必ず除外されるため、winner 候補から排除する。
        // 同行者が winner になると、実際に転記されるべきレコード（支援者/複数人等）が
        // blocked されてしまい、グループ全体が未転記になる（#270895）
        if (pCol === '同行者') return { record: r, score: -1 };
        let score = 0;
        if (name.startsWith('看護師')) score = 2;
        else if (name.startsWith('准看護師')) score = 1;
        return { record: r, score };
      });
      // スコア降順ソート（同点は元の順序を維持）
      scored.sort((a, b) => b.score - a.score);

      // 最高スコアの1件以外をブロック
      const winner = scored[0].record;
      for (const { record } of scored) {
        if (record.recordId !== winner.recordId) {
          blocked.add(record.recordId);
        }
      }
      logger.debug(
        `重複グループ ${key}: ${group.length}件中「${winner.staffName}」(${winner.recordId}) を転記対象に選択`
      );
    }
    return blocked;
  }

  /**
   * 転記対象レコードかどうかを判定
   */
  isTranscriptionTarget(record: TranscriptionRecord): boolean {
    if (record.recordLocked) {
      const isTranscribed = record.transcriptionFlag === '転記済み' || record.transcriptionFlag === '修正あり';
      if (!isTranscribed) {
        logger.warn(
          `スキップ(要確認): recordId=${record.recordId} は未転記(flag='${record.transcriptionFlag}')なのに recordLocked=TRUE です`,
        );
      }
      return false;
    }
    // 完了ステータスフィルタ: "1"(日々チェック保留) と ""(空白) は転記対象外
    // 会議決定: "2","3","4" のみ転記対象
    const cs = record.completionStatus;
    if (cs === '' || cs === '1') return false;

    // N列「重複」かつ P列が空欄 → スキップ（事務員未判定 — ペアの役割が未確定）
    if (record.accompanyCheck.includes('重複') && !record.accompanyClerkCheck.trim()) return false;

    // O列「緊急支援あり」かつ R列が空欄 → スキップ（緊急時事務員未設定）
    if (record.emergencyFlag.includes('緊急支援あり') && !record.emergencyClerkCheck.trim()) return false;

    // 自費サービスは HAM 転記対象外
    if (record.serviceType1 === '自費') return false;

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
    if (record.serviceType1 === '介護') {
      if (!this.patientMaster) {
        logger.warn(
          `介護度判定スキップ: patientMaster 未設定（CSV ダウンロード失敗の可能性）` +
          ` — ${record.patientName}(${record.recordId}) が要支援の場合、誤ったサービスコードで登録されます`,
        );
      } else {
        const patient = this.patientMaster.findByAozoraId(record.aozoraId);
        if (!patient) {
          logger.warn(
            `介護度判定スキップ: ${record.patientName}(aozoraId=${record.aozoraId}) が利用者マスタに未登録` +
            ` — 要支援の場合、誤ったサービスコードで登録されます`,
          );
        } else {
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
          } else {
            logger.debug(`介護度判定: ${record.patientName} は${patient.careLevel} → 介護モード（変更なし）`);
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

    // リロード検出用 DOM マーカーを埋め込む
    // form.submit() 後にページがリロードされると、このマーカーは消滅する。
    // URL ベースの検出は同一月再検索で URL が変わらないため不確実。
    const preSearchFrame = await nav.getMainFrame('k2_1');
    await preSearchFrame.evaluate(() => {
      document.body.setAttribute('data-rpa-pre-search', '1');
    }).catch(() => {});

    // 全患者を検索
    await nav.submitForm({ action: 'act_search' });

    // Phase 1: DOM マーカー消滅 = ページリロード完了を確実に検出
    // マーカーが消えるまで最大 20 秒待機。消えたらフレームの DOM は新しいもの。
    let markerDisappeared = false;
    for (let waitIdx = 0; waitIdx < 40; waitIdx++) {
      if (waitIdx > 0 && waitIdx % 10 === 0) await this.assertPagesAlive(nav);
      await this.sleep(500);
      try {
        const f = await nav.getMainFrame();
        const markerStillExists = await f.evaluate(() =>
          document.body?.hasAttribute('data-rpa-pre-search')
        ).catch(() => false);
        if (!markerStillExists) { markerDisappeared = true; break; }
      } catch {
        markerDisappeared = true;
        break; // フレーム遷移中（Execution context destroyed）= リロード中
      }
    }
    if (!markerDisappeared) {
      await this.assertPagesAlive(nav); // タイムアウト前にクラッシュか確認
      throw new Error('DOM マーカーが20秒以内に消滅しませんでした — act_search の submit が未反映の可能性');
    }

    // Phase 2: k2_1 のフレームが完全にロードされるまで待機
    await nav.waitForMainFrame('k2_1', 15000);
    await this.sleep(500);

    // Phase 3: 検索結果の安定性チェック — 決定ボタン数が連続安定するまで待機
    // HAM サーバーが遅い場合、ページ構造は先にロードされるが
    // 利用者データのレンダリングが遅延することがある
    {
      let prevCount = -1;
      let stableRounds = 0;
      for (let stabilityIdx = 0; stabilityIdx < 10; stabilityIdx++) {
        const searchFrame = await nav.getMainFrame('k2_1');
        const currentCount = await searchFrame.evaluate(() =>
          document.querySelectorAll('input[name="act_result"][value="決定"]').length
        ).catch(() => 0);
        if (currentCount === prevCount && currentCount > 0) {
          stableRounds++;
          if (stableRounds >= 2) break; // 1秒間安定 → 完了
        } else {
          stableRounds = 0;
        }
        prevCount = currentCount;
        await this.sleep(500);
      }
      logger.debug(`Step 3: 患者検索実行 (${monthStart}), 決定ボタン=${prevCount}件`);
    }

    // k2_1 検索結果ロード後のエラーチェック
    // HAM サーバーが検索処理中に OOM/syserror を返した場合、検索結果ではなく
    // エラーページが表示される。この状態で findPatientId を呼ぶと「患者未検出」
    // として誤分類されるため、先にサーバーエラーを検出して適切にリトライさせる。
    await this.checkForSyserror(nav);

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

    // k2_2 のフレーム出現を待つ（hamerror.jsp ポップアップも並行検知）
    await nav.waitForMainFrame('k2_2', 15000);
    await this.sleep(1000);

    // エラーチェック（syserror + hamerror）
    await this.checkForHamError(nav);
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
      const dupStatus = await this.checkDuplicateOnK2_2(nav, visitDateHam, record.startTime, record.staffName, record.endTime);
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
      const deleted = await this.deleteExistingSchedule(nav, visitDateHam, record.startTime, record.staffName, record.hamAssignId);
      if (deleted) {
        logger.info(`既存スケジュール削除完了 → 再転記を続行`);
      } else if (record.hamAssignId) {
        // assignId ベースの削除が不完全 → 2つの可能性:
        //   A) 利用者変更 → 旧利用者側で削除を試みる
        //   B) 同一利用者だが一部 assignId が削除失敗 → 残存確認後に判断
        //
        // まず現利用者の k2_2 に残存エントリがあるか確認
        const assignIds = record.hamAssignId.split(',').map((s: string) => s.trim()).filter(Boolean);
        const verifyFrame = await nav.getMainFrame('k2_2');
        const remainingCount = await verifyFrame.evaluate((aids) => {
          let count = 0;
          const btns = document.querySelectorAll('input[name="act_delete"][value="削除"]');
          for (const btn of Array.from(btns)) {
            const onclick = btn.getAttribute('onclick') || '';
            for (const aid of aids) {
              if (onclick.includes(`confirmDelete('${aid}'`)) { count++; break; }
            }
          }
          return count;
        }, assignIds);

        if (remainingCount > 0) {
          // 同一利用者に旧エントリが残存 → 新規追加すると重複になるためエラー
          throw new Error(
            `修正削除不完全: assignId=${record.hamAssignId} のうち ${remainingCount}件が削除できませんでした。` +
            '手動で旧エントリを削除してから再実行してください。'
          );
        }

        // 現利用者に残存なし → 利用者変更の可能性
        logger.warn(`assignId=${record.hamAssignId} が現利用者で未検出 → 利用者変更を確認`);
        const deletedFromOld = await this.deleteFromOldPatient(nav, record, sheetId, tab);
        if (deletedFromOld) {
          logger.info(`旧利用者から削除完了 → 新利用者で再転記を続行`);
          // 新利用者のk2_2に再遷移
          await this.clickBackButtonOnK2_2(nav);
          const monthStart = toHamMonthStart(record.visitDate);
          await nav.setSelectValue('searchdate', monthStart);
          await nav.submitForm({ action: 'act_search' });
          await nav.waitForMainFrame('k2_1', 15000);
          await this.sleep(1000);
          const newPatientId = await this.findPatientId(nav, record);
          if (!newPatientId) throw new Error(`患者が見つかりません: ${record.patientName}`);
          const k2_1Frame = await nav.getMainFrame('k2_1');
          await k2_1Frame.evaluate((pid) => {
            const win = window as any; // eslint-disable-line @typescript-eslint/no-explicit-any
            const form = document.forms[0];
            if (typeof win.submitTargetFormEx === 'function') {
              win.submitTargetFormEx(form, 'k2_2', form.careuserid, pid);
            } else {
              win.submited = 0;
              form.careuserid.value = pid;
              form.doAction.value = 'k2_2';
              form.target = 'mainFrame';
              form.submit();
            }
          }, newPatientId);
          await nav.waitForMainFrame('k2_2', 15000);
          await this.sleep(1000);
        } else {
          logger.warn(`旧利用者からも削除不可 → 新規追加として続行`);
        }
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

    logger.debug(`Step 6: starttype 現在=${currentStartType}, 目標=${startPeriod} (時刻=${record.startTime})`);
    if (currentStartType !== startPeriod) {
      logger.debug(`Step 6: starttype 変更 ${currentStartType} → ${startPeriod}`);
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
    // k2_3a の showflag フィールドが存在するまで待機（フレーム遷移遅延対策）
    let k2_3aFrame: Frame | null = null;
    for (let retry = 0; retry < 20; retry++) {
      if (retry > 0 && retry % 5 === 0) await this.assertPagesAlive(nav);
      try {
        const f = await nav.getMainFrame('k2_3a');
        const hasShowflag = await f.evaluate(() => !!document.forms[0]?.showflag).catch(() => false);
        if (hasShowflag) { k2_3aFrame = f; break; }
      } catch { /* retry */ }
      await this.sleep(1000);
    }
    if (!k2_3aFrame) {
      await this.assertPagesAlive(nav);
      throw new Error('k2_3a ページの showflag フィールドが見つかりません（ページ遷移失敗）');
    }
    await nav.switchInsuranceType(codeResult.showflag, k2_3aFrame);
    await this.sleep(2000); // 保険種別切替後のリロード待ち

    // === Step 7.5: k2_3a でスタッフ資格選択（医療保険のみ）— サービスコード選択の前に実行 ===
    // 資格フィルタを先に適用することで、サービスコード一覧が准看護師用に絞り込まれる
    await this.selectQualificationCheckbox(nav, record, codeResult);
    await this.checkForSyserror(nav); // k2_3a 検索後の OOM チェック

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
    // Stage 0: 複数資格スタッフの jobtype 選択（配置ボタンクリック前に設定必須）
    const k2_2fFrame = await nav.getMainFrame('k2_2f');
    const hasJobtypeSelect = await k2_2fFrame.$('select[name="jobtype"]');
    if (hasJobtypeSelect) {
      // Sheet の資格プレフィックス（例: "看護師-冨迫広美" → "看護師"）を抽出
      const qualPrefix = this.extractQualificationPrefix(record.staffName);
      if (qualPrefix) {
        // 下拉框の選択肢テキストと照合して選択（value ではなくラベルでマッチ）
        const selected = await k2_2fFrame.evaluate((prefix: string) => {
          const sel = document.querySelector('select[name="jobtype"]') as HTMLSelectElement | null;
          if (!sel) return { ok: false, reason: 'select not found' };
          for (const opt of Array.from(sel.options)) {
            if (opt.value === '00') continue; // "--" スキップ
            if (opt.text.includes(prefix) || prefix.includes(opt.text)) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, reason: `${opt.text} (${opt.value})` };
            }
          }
          return { ok: false, reason: `"${prefix}" に一致する選択肢なし` };
        }, qualPrefix);
        if (selected.ok) {
          logger.info(`Step 10: jobtype 選択 → ${selected.reason} (スタッフ: ${record.staffName})`);
        } else {
          throw new Error(`Step 10: jobtype 選択失敗: ${selected.reason} (スタッフ: ${record.staffName}) — 誤った資格で提出されるリスクがあります`);
        }
      } else {
        throw new Error(`Step 10: 資格プレフィックスなし → jobtype 選択不可: ${record.staffName}`);
      }
    }

    // Stage 1: k2_2f の配置ボタンを Playwright native click
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
    // 開始前に即座にページ死活チェック（OOM が既に発生している場合を即座に検出）
    await this.assertPagesAlive(nav);
    for (let i = 0; i < 20; i++) {
      // 3回ごとにページ死活チェック（OOM で空転するのを早期検出）
      if (i > 0 && i % 3 === 0) {
        await this.assertPagesAlive(nav);
      }
      const allFrames = hamPage.frames();
      for (const f of allFrames) {
        // 短いタイムアウト（3秒）で evaluate — OOM ページではハングするため
        const hasList = await Promise.race([
          f.evaluate(() =>
            document.querySelectorAll('input[name="act_select"][value="選択"]').length > 0
          ).catch(() => false),
          new Promise<false>(resolve => setTimeout(() => resolve(false), 3000)),
        ]);
        if (hasList) { staffFrame = f; break; }
      }
      if (staffFrame) break;
      await this.sleep(1000);
    }
    if (!staffFrame) {
      // OOM/syserror が原因でリストが表示されない場合を先にチェック
      await this.checkForSyserror(nav);
      throw new Error('従業員選択リストが表示されません');
    }

    // Stage 3: スタッフ検索 + HAM choice() 呼び出し
    // CJK 異体字正規化 + エイリアス解決: 旧字体→新字体（眞→真, 﨑→崎）、旧姓→新姓（新盛→落合）
    // extractPlainName: "資格-姓名" 形式の場合、資格プレフィックスを除去して氏名のみ使用
    const staffSearchName = normalizeCjkName(resolveStaffAlias(extractPlainName(record.staffName)));
    const choiceResult = await staffFrame.evaluate((args: { searchName: string; variantMap: [string, string][] }) => {
      function normCjk(s: string): string {
        let r = s.normalize('NFKC');
        r = r.replace(/[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, '');
        r = r.replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g, '');
        for (const [old, rep] of args.variantMap) {
          if (r.includes(old)) r = r.replaceAll(old, rep);
        }
        r = r.replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
        r = r.replace(/\u30F2/g, '\u30AA'); // ヲ→オ（しをり→シオリ）
        r = r.replace(/\u30F1/g, '\u30A8'); // ヱ→エ（スミヱ→スミエ）
        return r.replace(/[\s\u3000\u00a0]+/g, '').trim();
      }
      const rows = Array.from(document.querySelectorAll('tr'));
      let foundButDisabled = false;
      let nameMatchedButRegexFailed = '';
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
        // choice() の引数パターンを複数対応（第4引数が数字/文字列/省略の場合がある）
        const m = onclick.match(/choice\(this,\s*'(\d+)',\s*'([^']+)'(?:,\s*(?:'[^']*'|\d+))?\)/);
        if (m) {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          (window as any).submited = 0;
          if (typeof (window as any).choice === 'function') {
            (window as any).choice(selectBtn, m[1], m[2], 1);
            return { found: true, disabled: false, helperId: m[1], staffName: m[2], debug: '' };
          }
          /* eslint-enable @typescript-eslint/no-explicit-any */
          selectBtn.click();
          return { found: true, disabled: false, helperId: m[1], staffName: m[2], debug: '' };
        }
        // regex 不一致でもスタッフ名が一致 → ボタン直接クリックでフォールバック
        nameMatchedButRegexFailed = onclick;
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (window as any).submited = 0;
        /* eslint-enable @typescript-eslint/no-explicit-any */
        selectBtn.click();
        return { found: true, disabled: false, helperId: '', staffName: args.searchName, debug: `regex不一致fallback onclick="${onclick}"` };
      }
      return { found: false, disabled: foundButDisabled, helperId: '', staffName: '', debug: nameMatchedButRegexFailed ? `名前一致但regex失敗: onclick="${nameMatchedButRegexFailed}"` : '' };
    }, { searchName: staffSearchName, variantMap: CJK_VARIANT_MAP_SERIALIZABLE });

    if (choiceResult.debug) {
      logger.warn(`スタッフ選択デバッグ: ${choiceResult.debug}`);
    }

    if (!choiceResult.found) {
      // デバッグ: 従業員リストに表示されている全スタッフ名を取得
      const visibleStaff = await staffFrame.evaluate((vm: [string, string][]) => {
        function normCjk(s: string): string {
          let r = s.normalize('NFKC');
          r = r.replace(/[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, '');
          r = r.replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g, '');
          for (const [old, rep] of vm) { if (r.includes(old)) r = r.replaceAll(old, rep); }
          return r.replace(/[\s\u3000\u00a0]+/g, '').trim();
        }
        const rows = Array.from(document.querySelectorAll('tr'));
        const names: string[] = [];
        for (const row of rows) {
          const btn = row.querySelector('input[name="act_select"][value="選択"]');
          if (!btn) continue;
          // 行テキストからスタッフ名を抽出（セル単位で取得）
          const cells = Array.from(row.querySelectorAll('td'));
          const cellTexts = cells.map(c => (c as HTMLElement).textContent?.trim() || '');
          const raw = cellTexts.filter(t => t && t !== '選択').join(' | ');
          const normalized = normCjk(row.textContent || '');
          names.push(`${raw} [norm: ${normalized}] [disabled: ${(btn as HTMLInputElement).disabled}]`);
        }
        // ページネーション情報
        const pageInfo = document.body?.innerText?.match(/全\d+件|(\d+)\/(\d+)ページ|\d+件中/)?.[0] || '';
        return { names, total: rows.length, pageInfo };
      }, CJK_VARIANT_MAP_SERIALIZABLE).catch(() => ({ names: [] as string[], total: 0, pageInfo: '' }));

      logger.warn(`スタッフ未検出デバッグ: 検索名="${staffSearchName}", 元名="${record.staffName}"`);
      logger.warn(`従業員リスト (${visibleStaff.names.length}名表示, 全${visibleStaff.total}行${visibleStaff.pageInfo ? ', ' + visibleStaff.pageInfo : ''}):`);
      for (const name of visibleStaff.names) {
        logger.warn(`  - ${name}`);
      }

      // スタッフ配置失敗: ここでは k2_2f/スタッフリスト画面にいるため、
      // schedule のロールバックは不可。残留した未配置行は次回の
      // checkDuplicateOnK2_2 で 'partial' として検出され、
      // schedule 再作成はスキップされる（配置ボタン検出対応済み）。
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
      if (retry > 0 && retry % 3 === 0) await this.assertPagesAlive(nav);
      const allFrames2 = hamPage.frames();
      for (const f of allFrames2) {
        try {
          const hasConfirm = await Promise.race([
            f.evaluate(() => {
              const body = document.body?.innerText || '';
              return body.includes('スタッフでよろしければ') || body.includes('決定');
            }).catch(() => false),
            new Promise<false>(resolve => setTimeout(() => resolve(false), 3000)),
          ]);
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
      // 確認画面失敗: k2_2f にいるためロールバック不可。
      // 残留行は次回 checkDuplicateOnK2_2 で 'partial' 検出される。
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
      if (i > 0 && i % 3 === 0) await this.assertPagesAlive(nav);
      const allF = hamPage.frames();
      for (const f of allF) {
        const hasAll1 = await Promise.race([
          f.evaluate(() =>
            !!document.querySelector('input[name="act_chooseall"]')
          ).catch(() => false),
          new Promise<false>(resolve => setTimeout(() => resolve(false), 3000)),
        ]);
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

    // リロード検出用 DOM マーカーを埋め込む（processRecord と同じ手法）
    const preSearchFrame = await nav.getMainFrame('k2_1');
    await preSearchFrame.evaluate(() => {
      document.body.setAttribute('data-rpa-pre-search', '1');
    }).catch(() => {});

    await nav.submitForm({ action: 'act_search' });

    // Phase 1: DOM マーカー消滅 = ページリロード完了を検出
    let i5MarkerDisappeared = false;
    for (let waitIdx = 0; waitIdx < 40; waitIdx++) {
      if (waitIdx > 0 && waitIdx % 10 === 0) await this.assertPagesAlive(nav);
      await this.sleep(500);
      try {
        const f = await nav.getMainFrame();
        const markerStillExists = await f.evaluate(() =>
          document.body?.hasAttribute('data-rpa-pre-search')
        ).catch(() => false);
        if (!markerStillExists) { i5MarkerDisappeared = true; break; }
      } catch {
        i5MarkerDisappeared = true;
        break; // フレーム遷移中
      }
    }
    if (!i5MarkerDisappeared) {
      throw new Error('I5: DOM マーカーが20秒以内に消滅しませんでした — act_search の submit が未反映の可能性');
    }

    // Phase 2: k2_1 フレーム完全ロード待ち
    await nav.waitForMainFrame('k2_1', 15000);
    await this.sleep(500);

    // Phase 3: 検索結果の安定性チェック
    {
      let prevCount = -1;
      let stableRounds = 0;
      for (let stabilityIdx = 0; stabilityIdx < 10; stabilityIdx++) {
        const searchFrame = await nav.getMainFrame('k2_1');
        const currentCount = await searchFrame.evaluate(() =>
          document.querySelectorAll('input[name="act_result"][value="決定"]').length
        ).catch(() => 0);
        if (currentCount === prevCount && currentCount > 0) {
          stableRounds++;
          if (stableRounds >= 2) break;
        } else {
          stableRounds = 0;
        }
        prevCount = currentCount;
        await this.sleep(500);
      }
      logger.debug(`I5 Step 3: 患者検索実行 (${monthStart}), 決定ボタン=${prevCount}件`);
    }

    // k2_1 検索結果ロード後のエラーチェック（OOM/syserror 検出）
    await this.checkForSyserror(nav);

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

    // エラーチェック（hamerror.jsp ポップアップ検知）
    await this.checkForHamError(nav);

    // 介護/予防判定 — showflag を決定し、act_i5 送信時に hiddenField として渡す。
    // k2_2 のデフォルト showflag が医療(3)になっている場合、I5 が医療コンテキストで
    // 作成されるバグを防止する（#122765: 介護リハビリが医療として登録される問題の修正）。
    let i5Showflag = '1'; // デフォルト: 介護
    if (!this.patientMaster) {
      logger.warn(
        `I5 介護度判定スキップ: patientMaster 未設定（CSV ダウンロード失敗の可能性）` +
        ` — ${record.patientName}(${record.recordId}) の servicetype 切替が正しく行われない可能性があります`,
      );
    } else {
      const patient = this.patientMaster.findByAozoraId(record.aozoraId);
      if (!patient) {
        logger.warn(
          `I5 介護度判定スキップ: ${record.patientName}(aozoraId=${record.aozoraId}) が利用者マスタに未登録`,
        );
      } else {
        const careType = PatientMasterService.determineCareType(patient.careLevel);
        if (careType === '予防') {
          i5Showflag = '2';
          logger.info(`I5フロー: 予防モード (${record.patientName}, 要介護度=${patient.careLevel})`);
        } else {
          logger.debug(`I5フロー: 介護モード (${record.patientName}, 要介護度=${patient.careLevel})`);
        }
      }
    }

    // 日付文字列（スタッフ配置時の行検索に使用）
    const visitDateHam = toHamDate(record.visitDate);

    // === 重複チェック — 同一日付+時刻のエントリ状態を確認 ===
    let skipI5Creation = false;
    let skipI5StaffAssignment = false;
    if (record.transcriptionFlag !== '修正あり') {
      // I5 は複数スロット分割（20分×N行）のため endTime を渡さない。
      // k2_2 の最初の行は startTime〜startTime+20min で、record.endTime とは異なる。
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
        // ★ I5 は複数スロット分割のため、1行目がスタッフ配置済みでも
        // 2行目以降が未配置の場合がある（前回実行が途中で失敗したケース）。
        // skipI5StaffAssignment を false のまま残し、assignStaffToAllUnassigned で
        // 残存する未配置行にもスタッフを配置する。(#172654)
        logger.info(`I5 実績未設定検出 → スケジュール作成スキップ・スタッフ未配置行があれば配置: ${record.recordId}`);
      }
      if (dupStatus === 'partial') {
        skipI5Creation = true;
        logger.info(`I5 部分登録検出 → スケジュール作成スキップ・スタッフ配置に進む: ${record.recordId}`);
      }
    }

    // I5 作成前の既存未配置 assignId を記録（作成後に差分で新規行を特定するため）
    let preExistingUnassignedIds = new Set<string>();
    let i5NewAssignIds: string[] = [];

    if (!skipI5Creation) {
    const preFrame = await nav.getMainFrame('k2_2');
    preExistingUnassignedIds = new Set(await preFrame.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[name="act_modify"][value="配置"]'));
      const ids: string[] = [];
      for (const btn of btns) {
        const tr = btn.closest('tr');
        const staffCell = tr?.querySelector('td[bgcolor="#DDEEFF"]');
        if (staffCell?.textContent?.trim()) continue;
        const onclick = btn.getAttribute('onclick') || '';
        const m = onclick.match(/assignid\s*,\s*'(\d+)'/) || onclick.match(/assignid\.value\s*=\s*'(\d+)'/);
        if (m) ids.push(m[1]);
      }
      return ids;
    }));
    if (preExistingUnassignedIds.size > 0) {
      logger.debug(`I5フロー: 作成前に未配置行 ${preExistingUnassignedIds.size}行 を検出（除外対象）`);
    }

    // === I5 修正レコードの場合 → 既存スケジュール先行削除 ===
    if (record.transcriptionFlag === '修正あり') {
      logger.info(`I5 修正レコード検出: ${record.recordId} — 既存スケジュールを削除します`);
      const deleted = await this.deleteExistingSchedule(nav, visitDateHam, record.startTime, record.staffName, record.hamAssignId);
      if (deleted) {
        logger.info(`I5 既存スケジュール削除完了 → 再作成を続行`);
      } else {
        logger.warn(`I5 既存スケジュールが見つからないか削除不可 → 新規追加として続行`);
      }
    }

    // Step 5: k2_2 で 訪看I5入力ボタン → k2_7_1
    // showflag を hiddenField で渡し、介護/予防コンテキストを明示的に設定する。
    // k2_2 が医療(showflag=3)をデフォルト表示している患者では、showflag 未指定だと
    // I5 が医療コンテキストで作成される問題がある（#122765）。
    await nav.submitForm({
      action: 'act_i5',
      setLockCheck: true,
      hiddenFields: { showflag: i5Showflag },
      waitForPageId: 'k2_7_1',
    });
    await this.sleep(1000);
    logger.debug(`I5フロー: k2_7_1に遷移 (showflag=${i5Showflag})`);

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
    if (!this.patientMaster) {
      logger.warn(
        `I5 6a: patientMaster 未設定 — servicetype はデフォルト(13=訪問看護)のまま。` +
        `${record.patientName} が要支援の場合、63(予防)への切替が行われません`,
      );
    } else {
      const patient = this.patientMaster.findByAozoraId(record.aozoraId);
      if (!patient) {
        logger.warn(
          `I5 6a: ${record.patientName}(aozoraId=${record.aozoraId}) が利用者マスタに未登録 — servicetype デフォルト(13)`,
        );
      } else {
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

    // --- 6d: 終了時刻 ---
    // I5 は setEndtime() が 20分単位で正確に自動計算するため、-1分補正は不要。
    // 通常フロー (k2_3) とは異なり、HAM 自動値をそのまま使用する。
    logger.debug(`I5フロー: 終了時刻は setEndtime() 自動計算値を使用（補正なし）`);

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
    // I5 作成前に取得した既存 assignId (preExistingUnassignedIds) と比較し、
    // 新規に作成された行のみを特定する（他レコードの残留行を誤配置しないため）。
    const k2_2FrameCheck = await nav.getMainFrame('k2_2');
    const postCreationIds: string[] = await k2_2FrameCheck.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[name="act_modify"][value="配置"]'));
      const ids: string[] = [];
      for (const btn of btns) {
        const tr = btn.closest('tr');
        const staffCell = tr?.querySelector('td[bgcolor="#DDEEFF"]');
        if (staffCell?.textContent?.trim()) continue;
        const onclick = btn.getAttribute('onclick') || '';
        const m = onclick.match(/assignid\s*,\s*'(\d+)'/) || onclick.match(/assignid\.value\s*=\s*'(\d+)'/);
        if (m) ids.push(m[1]);
      }
      return ids;
    });
    i5NewAssignIds = postCreationIds.filter(id => !preExistingUnassignedIds.has(id));

    if (i5NewAssignIds.length === 0) {
      throw new Error(
        `I5 転記失敗: 日付選択後にスケジュール行が生成されませんでした ` +
        `(${record.patientName}, ${record.visitDate}, ${record.startTime}-${record.endTime})`
      );
    }
    logger.info(`I5フロー: 新規スケジュール行 ${i5NewAssignIds.length}行 を確認 (既存未配置${preExistingUnassignedIds.size}行は除外)`);
    } // end if (!skipI5Creation)

    // === I5 スタッフ配置: 新規作成行のみに同一スタッフを配置 ===
    let i5AssignIds: string[] = [];
    if (!skipI5StaffAssignment) {
      i5AssignIds = await this.assignStaffToAllUnassigned(nav, record, i5NewAssignIds.length > 0 ? i5NewAssignIds : undefined);
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
      if (i > 0 && i % 3 === 0) await this.assertPagesAlive(nav);
      const ready = await Promise.race([
        h1_1aFrame.evaluate(() =>
          typeof (window as any).xinwork_searchKeyword === 'function' // eslint-disable-line @typescript-eslint/no-explicit-any
        ).catch(() => false),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 3000)),
      ]);
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
      // エイリアス解決: Sheet 上の旧姓 → HAM 上の新姓（例: 木村利愛 → 高山利愛）
      const normalized = normalizeCjkName(resolveStaffAlias(extractPlainName(staffName)));
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

    // emp_code 上書き: Sheet の emp_code が SmartHR/HAM と不一致のケースを補正
    // 不変性を保つため、上書き対象のみ新オブジェクトに置換する
    const empCodeOverrides = new Map<number, { staffName: string; staffNumber: string }>();
    for (let i = 0; i < missingStaff.length; i++) {
      const staff = missingStaff[i];
      const normalizedName = normalizeCjkName(extractPlainName(staff.staffName));
      const override = STAFF_EMPCODE_OVERRIDES[normalizedName];
      if (override && staff.staffNumber !== override) {
        logger.info(`emp_code 上書き: ${staff.staffName} ${staff.staffNumber} → ${override}`);
        empCodeOverrides.set(i, { ...staff, staffNumber: override });
      }
    }
    for (const [i, replacement] of empCodeOverrides) {
      missingStaff[i] = replacement;
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
    targetAssignIds?: string[],
  ): Promise<string[]> {
    const hamPage = nav.hamPage;
    // CJK 異体字正規化 + エイリアス解決: 旧字体→新字体、旧姓→新姓
    // extractPlainName: "資格-姓名" 形式の場合、資格プレフィックスを除去して氏名のみ使用
    const staffSearchName = normalizeCjkName(resolveStaffAlias(extractPlainName(record.staffName)));

    let unassignedIds: string[];
    if (targetAssignIds && targetAssignIds.length > 0) {
      // I5 新規作成行のみを対象とする（他レコードの残留行を誤配置しない）
      unassignedIds = targetAssignIds;
      logger.debug(`I5 スタッフ配置: 指定 assignId ${unassignedIds.length}件のみ対象`);
    } else {
      // フォールバック（skipI5Creation 時）: 指定日の未配置行のみ取得
      const dayNum = parseInt(toHamDate(record.visitDate).substring(6, 8));
      const frame = await nav.getMainFrame('k2_2');
      unassignedIds = await frame.evaluate(({ targetDay }) => {
        const dayPattern = /(?:^|[^0-9])(\d{1,2})日/;
        const allRows = Array.from(document.querySelectorAll('tr'));
        const rowDayMap = new Map<Element, number>();
        let currentDay = -1;
        for (const row of allRows) {
          const m = (row.textContent || '').match(dayPattern);
          if (m) currentDay = parseInt(m[1]);
          rowDayMap.set(row, currentDay);
        }

        const btns = Array.from(document.querySelectorAll('input[name="act_modify"][value="配置"]'));
        const ids: string[] = [];
        for (const btn of btns) {
          const tr = btn.closest('tr');
          if (!tr) continue;
          const staffCell = tr.querySelector('td[bgcolor="#DDEEFF"]');
          if (staffCell?.textContent?.trim()) continue;
          const rowDay = rowDayMap.get(tr) ?? -1;
          if (rowDay !== targetDay) continue; // 指定日以外を除外
          const onclick = btn.getAttribute('onclick') || '';
          const m = onclick.match(/assignid\s*,\s*'(\d+)'/) || onclick.match(/assignid\.value\s*=\s*'(\d+)'/);
          if (m) ids.push(m[1]);
        }
        return ids;
      }, { targetDay: dayNum });
      logger.debug(`I5 スタッフ配置: ${dayNum}日の未配置行 ${unassignedIds.length}件を対象`);
    }

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
      await this.checkForSyserror(nav);

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
      // 開始前に即座にページ死活チェック（OOM が既に発生している場合を即座に検出）
      await this.assertPagesAlive(nav);
      for (let i = 0; i < 20; i++) {
        // 3回ごとにページ死活チェック（OOM で空転するのを早期検出）
        if (i > 0 && i % 3 === 0) {
          await this.assertPagesAlive(nav);
        }
        for (const f of hamPage.frames()) {
          const hasList = await Promise.race([
            f.evaluate(() =>
              document.querySelectorAll('input[name="act_select"][value="選択"]').length > 0
            ).catch(() => false),
            new Promise<false>(resolve => setTimeout(() => resolve(false), 3000)),
          ]);
          if (hasList) { staffFrame = f; break; }
        }
        if (staffFrame) break;
        await this.sleep(1000);
      }
      if (!staffFrame) {
        await this.checkForSyserror(nav);
        throw new Error(`スタッフ選択リストが表示されません (assignId=${aid})`);
      }

      // HAM choice() でスタッフ選択（CJK 異体字正規化: NFKC + VS除去 + 旧字体→新字体 + ひらがな→カタカナ）
      // I5 結合サービスでは同一患者の隣接スロットに同じスタッフを配置するため、
      // HAM がボタンを disabled にしても choice() で強制配置を試みる
      const choiceResult = await staffFrame.evaluate((args: { searchName: string; variantMap: [string, string][] }) => {
        function normCjk(s: string): string {
          let r = s.normalize('NFKC');
          r = r.replace(/[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, '');
          r = r.replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g, '');
          for (const [old, rep] of args.variantMap) {
            if (r.includes(old)) r = r.replaceAll(old, rep);
          }
          r = r.replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
          r = r.replace(/\u30F2/g, '\u30AA'); // ヲ→オ
          r = r.replace(/\u30F1/g, '\u30A8'); // ヱ→エ
          return r.replace(/[\s\u3000\u00a0]+/g, '').trim();
        }
        const rows = Array.from(document.querySelectorAll('tr'));
        let disabledBtn: HTMLInputElement | null = null;
        let disabledOnclick = '';
        for (const row of rows) {
          const rowText = normCjk(row.textContent || '');
          if (!rowText.includes(args.searchName)) continue;
          const selectBtn = row.querySelector('input[name="act_select"][value="選択"]') as HTMLInputElement | null;
          if (!selectBtn) continue;
          // 選択ボタンが disabled → 記録して後でフォールバック（I5 隣接スロット対応）
          if (selectBtn.disabled) {
            disabledBtn = selectBtn;
            disabledOnclick = selectBtn.getAttribute('onclick') || '';
            continue;
          }
          const onclick = selectBtn.getAttribute('onclick') || '';
          const m = onclick.match(/choice\(this,\s*'(\d+)',\s*'([^']+)'(?:,\s*(?:'[^']*'|\d+))?\)/);
          if (m) {
            (window as any).submited = 0; // eslint-disable-line @typescript-eslint/no-explicit-any
            if (typeof (window as any).choice === 'function') { // eslint-disable-line @typescript-eslint/no-explicit-any
              (window as any).choice(selectBtn, m[1], m[2], 1); // eslint-disable-line @typescript-eslint/no-explicit-any
              return { found: true, disabled: false, staffName: m[2] };
            }
            selectBtn.click();
            return { found: true, disabled: false, staffName: m[2] };
          }
          // regex 不一致でもスタッフ名が一致 → ボタン直接クリックでフォールバック
          (window as any).submited = 0; // eslint-disable-line @typescript-eslint/no-explicit-any
          selectBtn.click();
          return { found: true, disabled: false, staffName: args.searchName };
        }
        // 有効なボタンが見つからなかったが disabled ボタンがある場合、
        // disabled を解除して choice() で強制配置（I5 同一患者の隣接スロット）
        if (disabledBtn) {
          const m = disabledOnclick.match(/choice\(this,\s*'(\d+)',\s*'([^']+)'(?:,\s*(?:'[^']*'|\d+))?\)/);
          if (m) {
            disabledBtn.disabled = false;
            (window as any).submited = 0; // eslint-disable-line @typescript-eslint/no-explicit-any
            if (typeof (window as any).choice === 'function') { // eslint-disable-line @typescript-eslint/no-explicit-any
              (window as any).choice(disabledBtn, m[1], m[2], 1); // eslint-disable-line @typescript-eslint/no-explicit-any
              return { found: true, disabled: false, staffName: m[2], forcedDisabled: true };
            }
            disabledBtn.click();
            return { found: true, disabled: false, staffName: m[2], forcedDisabled: true };
          }
        }
        return { found: false, disabled: !!disabledBtn, staffName: '' };
      }, { searchName: staffSearchName, variantMap: CJK_VARIANT_MAP_SERIALIZABLE });

      if ((choiceResult as any).forcedDisabled) {
        logger.warn(`I5 スタッフ配置: 「${record.staffName}」の選択ボタンが disabled だったため強制配置 (assignId=${aid}, 同一患者の隣接スロット)`);
      }

      if (!choiceResult.found) {
        // デバッグ: 従業員リストに表示されている全スタッフ名を取得
        const visibleStaff = await staffFrame.evaluate((vm: [string, string][]) => {
          function normCjk(s: string): string {
            let r = s.normalize('NFKC');
            r = r.replace(/[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, '');
            r = r.replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g, '');
            for (const [old, rep] of vm) { if (r.includes(old)) r = r.replaceAll(old, rep); }
            return r.replace(/[\s\u3000\u00a0]+/g, '').trim();
          }
          const rows = Array.from(document.querySelectorAll('tr'));
          const names: string[] = [];
          for (const row of rows) {
            const btn = row.querySelector('input[name="act_select"][value="選択"]');
            if (!btn) continue;
            const cells = Array.from(row.querySelectorAll('td'));
            const cellTexts = cells.map(c => (c as HTMLElement).textContent?.trim() || '');
            const raw = cellTexts.filter(t => t && t !== '選択').join(' | ');
            const normalized = normCjk(row.textContent || '');
            names.push(`${raw} [norm: ${normalized}] [disabled: ${(btn as HTMLInputElement).disabled}]`);
          }
          return { names, total: rows.length };
        }, CJK_VARIANT_MAP_SERIALIZABLE).catch(() => ({ names: [] as string[], total: 0 }));

        logger.warn(`I5 スタッフ未検出デバッグ: 検索名="${staffSearchName}", 元名="${record.staffName}"`);
        logger.warn(`従業員リスト (${visibleStaff.names.length}名表示):`);
        for (const name of visibleStaff.names) {
          logger.warn(`  - ${name}`);
        }
        if (choiceResult.disabled) {
          throw new Error(
            `スタッフ配置不可：担当スタッフ「${record.staffName}」が同時間帯に他利用者の予定と重複しHAMで選択不可（手動配置が必要）`
          );
        }
        throw new Error(`スタッフ「${record.staffName}」(検索名: ${staffSearchName}) が見つかりません（HAMに登録されていません）`);
      }
      await this.sleep(3000);

      // 確認画面の決定ボタン
      let confirmClicked = false;
      for (let retry = 0; retry < 10; retry++) {
        if (retry > 0 && retry % 3 === 0) await this.assertPagesAlive(nav);
        for (const f of hamPage.frames()) {
          try {
            const hasConfirm = await Promise.race([
              f.evaluate(() => {
                const body = document.body?.innerText || '';
                return body.includes('スタッフでよろしければ') || body.includes('決定');
              }).catch(() => false),
              new Promise<false>(resolve => setTimeout(() => resolve(false), 3000)),
            ]);
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
        if (i > 0 && i % 3 === 0) await this.assertPagesAlive(nav);
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
      if (i > 0 && i % 3 === 0) await this.assertPagesAlive(nav);
      await this.sleep(1000);
      const pageId = await nav.getCurrentPageId();
      if (pageId === 'k2_1') {
        logger.debug('k2_2 → k2_1 に戻った');
        return;
      }
    }

    await this.assertPagesAlive(nav);
    throw new Error('clickBackButtonOnK2_2: k2_1 への遷移が15秒以内に完了しませんでした');
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
      // 比較時にスペースを除去 + NFKC + Variation Selector 除去
      // + 旧字体→新字体（眞→真 等）+ ひらがな→カタカナ統一 で正規化する
      function normalize(s: string): string {
        let r = s.normalize('NFKC');
        // Variation Selectors を除去 (VS1-VS16: U+FE00-FE0F, VS17-VS256: U+E0100-E01EF)
        r = r.replace(/[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, '');
        // ゼロ幅文字・不可見制御文字を除去
        r = r.replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g, '');
        for (const [old, rep] of variantMap) {
          if (r.includes(old)) r = r.replaceAll(old, rep);
        }
        // ひらがな → カタカナ統一 (例: とも子 → トモ子)
        r = r.replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
        r = r.replace(/\u30F2/g, '\u30AA'); // ヲ→オ（しをり→シオリ）
        r = r.replace(/\u30F1/g, '\u30A8'); // ヱ→エ（スミヱ→スミエ）
        return r.replace(/[\s\u3000\u00a0]+/g, '').trim();
      }

      const normalizedName = normalize(name);

      // === 方法1: 被保険者番号で検索（最も正確・同名同姓対応） ===
      // (非表示) 行はスキップ（旧レコードには利用者番号が表示されないが念のため除外）
      if (useHihokensha && hihokensha) {
        const hButtons = Array.from(document.querySelectorAll('input[name="act_result"][value="決定"]'));
        for (const btn of hButtons) {
          const tr = btn.closest('tr');
          if (!tr) continue;
          const rowText = tr.textContent || '';
          if (rowText.includes('(非表示)')) continue;
          if (rowText.includes(hihokensha)) {
            const onclick = btn.getAttribute('onclick') || '';
            const id = extractCareUserId(onclick);
            if (id) return { id, diag: null };
          }
        }
      }

      // === 方法2: 決定ボタンの onclick から患者名でマッチ ===
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
          if (id) return { id, diag: null };
        }
      }

      // === 方法3: HTML 行分割でフォールバック ===
      // (非表示) 行はスキップ
      const body = document.body?.innerHTML || '';
      const rows = body.split('<tr');
      for (const row of rows) {
        if (row.includes('(非表示)')) continue;
        const rowTextNorm = normalize(row.replace(/<[^>]*>/g, ''));
        if (rowTextNorm.includes(normalizedName)) {
          const id = extractCareUserId(row);
          if (id) return { id, diag: null };
        }
      }

      // 未検出 → 診断情報を収集
      const diagNames: string[] = [];
      for (const btn of allButtons) {
        const tr = btn.closest('tr');
        if (!tr) continue;
        // 2列目（名前セル）のテキストを取得
        const cells = tr.querySelectorAll('td');
        if (cells.length >= 2) {
          const raw = (cells[1].textContent || '').trim();
          if (raw) diagNames.push(raw);
        }
      }
      return { id: null, diag: { total: allButtons.length, searchName: normalizedName, sampleNames: diagNames.slice(0, 10) } };
    }, { name: patientName, useHihokensha: searchByHihokensha, hihokensha: hihokenshaBangou, variantMap: CJK_VARIANT_MAP_SERIALIZABLE });

    if (result?.id) {
      logger.debug(`患者ID検出: ${patientName}${searchByHihokensha ? `(被保険者番号=${hihokenshaBangou})` : ''} → ${result.id}`);
      return result.id;
    }
    // 診断情報をログ出力
    if (result?.diag) {
      const d = result.diag;
      logger.warn(
        `患者未検出: 「${patientName}」(正規化: ${d.searchName}) — ` +
        `k2_1ページに決定ボタン=${d.total}件, ` +
        `先頭名: [${d.sampleNames.join(', ')}]`,
      );
    }
    return null;
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
      // 日付不一致・既配置の行は絶対に選択しない（誤配置防止）
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
    endTime?: string,
  ): Promise<'complete' | 'needs_jisseki' | 'partial' | 'none'> {
    const frame = await nav.getMainFrame('k2_2');
    const dayNum = parseInt(visitDateHam.substring(6, 8));
    const dayDisplay = `${dayNum}日`;

    // staffName から姓を抽出（"看護師-冨迫広美" → "冨迫"）
    // エイリアス解決 + normalizeCjkName で旧字体→新字体変換（例: 白澤→白沢, 新盛→落合）
    const staffSurname = staffName
      ? normalizeCjkName(resolveStaffAlias(extractPlainName(staffName))).substring(0, 3)
      : '';

    // 終了時刻の許容値を計算: HAM は介護保険で -1分補正するため、endTime と endTime-1分 の両方を許容する
    // 例: record.endTime='09:40' → '09:40' or '09:39' を許容
    const endTimeVariants: string[] = [];
    if (endTime) {
      endTimeVariants.push(endTime);
      // -1分バリアント（HAM の終了時刻 -1分補正対応）
      const m = endTime.match(/^(\d{1,2}):(\d{2})$/);
      if (m) {
        const totalMin = parseInt(m[1]) * 60 + parseInt(m[2]) - 1;
        if (totalMin >= 0) {
          const adjH = String(Math.floor(totalMin / 60)).padStart(2, '0');
          const adjM = String(totalMin % 60).padStart(2, '0');
          endTimeVariants.push(`${adjH}:${adjM}`);
        }
      }
    }

    const result = await frame.evaluate(({ dd, st, surname, variantMap, endVariants }) => {
      // ブラウザ内 CJK 正規化（VS除去 + 旧字体→新字体 + ひらがな→カタカナ）
      function normalizeCjk(s: string): string {
        let r = s.normalize('NFKC');
        r = r.replace(/[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, '');
        r = r.replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g, '');
        for (const [old, rep] of variantMap) { r = r.replaceAll(old, rep); }
        r = r.replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
        r = r.replace(/\u30F2/g, '\u30AA'); // ヲ→オ
        r = r.replace(/\u30F1/g, '\u30A8'); // ヱ→エ
        return r.replace(/[\s\u3000\u00a0]+/g, '');
      }
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
        // 開始時刻チェック: st が「開始時刻」として出現しているか（endTime との誤マッチ防止）。
        // HAM k2_2 の表示形式 "HH:MM ～ HH:MM" で、開始時刻の後に ～ が続く。
        // text.includes(st) だと "13:20 ～ 13:40" が st="13:40" にマッチしてしまう (#132871)。
        // st+"～" または st+" ～" パターンで開始時刻のみマッチさせる。
        const stRegex = new RegExp(st.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*～');
        if (!stRegex.test(text)) continue;
        // 終了時刻チェック: endVariants が指定されている場合、いずれかの終了時刻が含まれていることを確認。
        // 一致しない場合は別の訪問エントリ（異なる訪問時間）なのでスキップする。
        // (#122730: 同一開始時刻の別エントリを誤って重複判定する問題の修正)
        if (endVariants.length > 0 && !endVariants.some(et => text.includes(et))) continue;
        // 編集ボタン or 配置ボタンがある → スケジュール存在
        const hasEdit = row.querySelector('input[value="編集"]');
        const hasHaichi = row.querySelector('input[name="act_modify"][value="配置"]');
        if (hasEdit || hasHaichi) {
          // スタッフ配置済みかチェック（td[bgcolor="#DDEEFF"] = 担当スタッフ欄）
          const staffCell = row.querySelector('td[bgcolor="#DDEEFF"]');
          const rawStaffText = (staffCell?.textContent || '').replace(/[\s\u3000]+/g, '');
          const hasStaff = !!rawStaffText;
          // HAM 側のスタッフ名も CJK 正規化してから比較
          const staffText = hasStaff ? normalizeCjk(rawStaffText) : '';

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
    }, { dd: dayDisplay, st: startTime, surname: staffSurname, variantMap: CJK_VARIANT_MAP_SERIALIZABLE, endVariants: endTimeVariants });

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
   *
   * hamAssignId を指定すると、日付・時刻に依存せず assignId で直接行を特定する。
   * 修正レコード（日付・時刻変更あり）では、Sheet 上の値が既に新しい値に上書きされているため、
   * 旧スケジュールを日付+時刻で検索できない。assignId は不変のため確実に特定可能。
   * I5 レコードの場合はカンマ区切りで複数 assignId が格納されている。
   */
  private async deleteExistingSchedule(
    nav: HamNavigator,
    visitDateHam: string,
    startTime: string,
    staffName?: string,
    hamAssignId?: string,
  ): Promise<boolean> {
    // === assignId 直接検索モード（修正レコード用） ===
    if (hamAssignId) {
      // I5 はカンマ区切りで複数 assignId を持つ場合がある
      const assignIds = hamAssignId.split(',').map(s => s.trim()).filter(Boolean);
      logger.info(`修正レコード: assignId で既存スケジュールを削除 (${assignIds.length}件: ${assignIds.join(', ')})`);

      let deletedCount = 0;
      for (const aid of assignIds) {
        const deleted = await this.deleteScheduleByAssignId(nav, aid);
        if (deleted) {
          deletedCount++;
        } else {
          // "not found" = 既に削除済み（手動削除 or I5 ペア連動削除の可能性）
          logger.warn(`assignId=${aid} の削除ボタン未検出（既に削除済みの可能性）`);
        }
      }

      // 最終検証: 対象 assignId がまだ k2_2 に残存しているか確認
      const verifyFrame = await nav.getMainFrame('k2_2');
      const remainingIds = await verifyFrame.evaluate((aids) => {
        const remaining: string[] = [];
        const btns = document.querySelectorAll('input[name="act_delete"][value="削除"]');
        for (const btn of Array.from(btns)) {
          const onclick = btn.getAttribute('onclick') || '';
          for (const aid of aids) {
            if (onclick.includes(`confirmDelete('${aid}'`)) {
              remaining.push(aid);
              break;
            }
          }
        }
        return remaining;
      }, assignIds);

      if (remainingIds.length > 0) {
        logger.error(`assignId 削除後に ${remainingIds.length}件が残存: ${remainingIds.join(', ')}`);
        return false;
      }

      logger.info(`assignId 削除完了: ${deletedCount}件削除, ${assignIds.length - deletedCount}件は既に削除済み`);
      return true;
    }

    // === 従来の日付+時刻検索モード ===
    const frame = await nav.getMainFrame('k2_2');
    const dayNum = parseInt(visitDateHam.substring(6, 8));
    const dayDisplay = `${dayNum}日`;

    // staffName から姓を抽出（"看護師-白澤英幸" → "白沢英"）
    // エイリアス解決 + normalizeCjkName で旧字体→新字体変換 + ひらがな→カタカナ統一
    const staffSurname = staffName
      ? normalizeCjkName(resolveStaffAlias(extractPlainName(staffName))).substring(0, 3)
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
   * assignId を指定して k2_2 上の単一スケジュール行を削除する。
   * 日付・時刻に依存しないため、修正レコード（日付・時刻変更あり）に対応。
   */
  private async deleteScheduleByAssignId(nav: HamNavigator, targetAssignId: string): Promise<boolean> {
    const frame = await nav.getMainFrame('k2_2');

    // assignId を含む削除ボタンを検索
    const deleteInfo = await frame.evaluate((aid) => {
      const rows = Array.from(document.querySelectorAll('tr'));
      for (const row of rows) {
        const delBtns = row.querySelectorAll('input[name="act_delete"][value="削除"]');
        for (const btn of Array.from(delBtns)) {
          const onclick = btn.getAttribute('onclick') || '';
          const m = onclick.match(/confirmDelete\(\s*'(\d+)'\s*,\s*'(\d+)'\s*\)/);
          if (m && m[1] === aid) {
            return {
              found: true,
              assignid: m[1],
              record2flag: m[2],
              rowText: (row.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 120),
            };
          }
        }
      }
      return { found: false, assignid: '', record2flag: '', rowText: '' };
    }, targetAssignId);

    if (!deleteInfo.found) {
      logger.debug(`assignId=${targetAssignId} の行が見つかりません（既に削除済みの可能性）`);
      return false;
    }

    logger.info(`assignId 指定削除: ${deleteInfo.rowText} (assignid=${deleteInfo.assignid})`);

    if (deleteInfo.record2flag === '1') {
      throw new Error(`record2flag=1: 記録書IIにより削除不可 (assignid=${deleteInfo.assignid})`);
    }

    // confirmDelete を実行
    const delBtn = await frame.$(`input[name="act_delete"][onclick*="confirmDelete('${targetAssignId}'"]`);
    if (delBtn) {
      await frame.evaluate(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (window as any).submited = 0;
        /* eslint-enable @typescript-eslint/no-explicit-any */
      });
      await delBtn.click();
      await this.sleep(2000);
    } else {
      await frame.evaluate((aid) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const win = window as any;
        win.submited = 0;
        if (typeof win.confirmDelete === 'function') {
          win.confirmDelete(aid, '0');
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
      }, targetAssignId);
      await this.sleep(2000);
    }

    // ページリロード待ち
    await nav.waitForMainFrame('k2_2', 15000);
    await this.sleep(2000);

    // form.doAction の復元を待つ
    for (let waitIdx = 0; waitIdx < 10; waitIdx++) {
      const f = await nav.getMainFrame('k2_2');
      const ready = await f.evaluate(() => {
        const form = document.forms[0];
        return !!(form && (form as HTMLFormElement & { doAction?: unknown }).doAction);
      }).catch(() => false);
      if (ready) break;
      await this.sleep(1000);
    }

    // 削除検証: assignId の行がまだ存在するか
    const verifyFrame = await nav.getMainFrame('k2_2');
    const stillExists = await verifyFrame.evaluate((aid) => {
      const btns = document.querySelectorAll('input[name="act_delete"][value="削除"]');
      for (const btn of Array.from(btns)) {
        const onclick = btn.getAttribute('onclick') || '';
        if (onclick.includes(`confirmDelete('${aid}'`)) return true;
      }
      return false;
    }, targetAssignId);

    if (!stillExists) {
      logger.info(`assignId 指定削除完了: assignid=${targetAssignId}`);
      return true;
    }

    // 上書き保存で永続化
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
        `assignId 指定削除の上書き保存に失敗: assignid=${targetAssignId}, ${(saveErr as Error).message}`
      );
    }

    // 上書き保存後の再検証
    const verifyFrame2 = await nav.getMainFrame('k2_2');
    const stillExists2 = await verifyFrame2.evaluate((aid) => {
      const btns = document.querySelectorAll('input[name="act_delete"][value="削除"]');
      for (const btn of Array.from(btns)) {
        const onclick = btn.getAttribute('onclick') || '';
        if (onclick.includes(`confirmDelete('${aid}'`)) return true;
      }
      return false;
    }, targetAssignId);

    if (stillExists2) {
      throw new Error(`assignId 指定削除に失敗: assignid=${targetAssignId}（上書き保存後もレコードが残存）`);
    }

    logger.info(`assignId 指定削除完了（上書き保存で永続化）: assignid=${targetAssignId}`);
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
    // エイリアス解決: Sheet名とHAM登録名が異なる場合（例: 新盛→落合）
    const searchName = resolveStaffAlias(extractPlainName(staffName).replace(/[\s\u3000]+/g, ''));

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
  /**
   * 軽量ページ死活チェック — wait ループ内で定期的に呼ぶ。
   * URL チェック + evaluate ping のみ。フレーム内スキャンはしない（高速）。
   * ページが死んでいれば即座に throw する。
   */
  private async assertPagesAlive(nav: HamNavigator): Promise<void> {
    const EVAL_TIMEOUT = 5000; // 5秒タイムアウト（OOM ページでは evaluate がハングするため）
    const pagesToCheck: Array<{ page: Page; label: string }> = [];
    try { pagesToCheck.push({ page: nav.tritrusPage, label: 'TRITRUS' }); } catch { /* not available */ }
    try { pagesToCheck.push({ page: nav.hamPage, label: 'HAM' }); } catch { /* not available */ }
    for (const { page: p, label } of pagesToCheck) {
      const url = (() => { try { return p.url(); } catch { return ''; } })();
      if (url.startsWith('chrome-error://') || url === 'about:blank') {
        throw new Error(`ページ死亡検出 (OOM): ${label} が ${url} — ブラウザ再起動が必要です`);
      }
      // evaluate は OOM 時にハングするため、短いタイムアウトで保護
      const alive = await Promise.race([
        p.evaluate(() => true).catch(() => false),
        new Promise<false>(resolve => setTimeout(() => resolve(false), EVAL_TIMEOUT)),
      ]);
      if (!alive) {
        throw new Error(`ページ応答なし (OOM): ${label} ${url} — ブラウザ再起動が必要です`);
      }
      // body text チェック（OOM キーワード検出）— タイムアウト付き
      // Chrome OOM ページは Shadow DOM を使用するため innerText が空になる場合がある。
      // document.title + エラー要素のテキストも取得して確認する。
      const bodyText = await Promise.race([
        p.evaluate(() => {
          const title = document.title || '';
          const inner = document.body?.innerText || '';
          const errorDiv = document.querySelector('#main-frame-error')
            || document.querySelector('.interstitial-wrapper')
            || document.querySelector('[jstcache]');
          const errorText = errorDiv?.textContent || '';
          return `${title}\n${inner}\n${errorText}`;
        }).catch(() => '__EVAL_FAILED__'),
        new Promise<string>(resolve => setTimeout(() => resolve('__EVAL_TIMEOUT__'), EVAL_TIMEOUT)),
      ]);
      if (bodyText === '__EVAL_FAILED__' || bodyText === '__EVAL_TIMEOUT__') {
        throw new Error(`ページ応答異常 (OOM): ${label} body取得${bodyText === '__EVAL_TIMEOUT__' ? 'タイムアウト' : '失敗'} ${url} — ブラウザ再起動が必要です`);
      }
      const oomHit = PAGE_DEATH_KEYWORDS.find(kw => bodyText.includes(kw));
      if (oomHit) {
        throw new Error(`ページ死亡検出 (OOM): ${label} に "${oomHit}" — ブラウザ再起動が必要です`);
      }
      // Chrome エラーページ追加検出: body がほぼ空の場合
      if (bodyText.replace(/\s/g, '').length < 20) {
        const titlePart = bodyText.split('\n')[0] || '';
        const titleLower = titlePart.toLowerCase();
        if (titleLower.includes('error') || titleLower.includes('エラー') || titlePart === '') {
          throw new Error(`空ページ検出 (OOM): ${label} 空ページ (title="${titlePart}") ${url} — ブラウザ再起動が必要です`);
        }
      }
    }

    // === HAM フレーム応答チェック ===
    // 顶层 hamfromout.go (frameset) は生きていても、内部 frame が全て死亡/加载中の場合がある。
    // mainFrame (goPageAction.go / Action.go) で evaluate が通るか確認。
    try {
      const hamPage = nav.hamPage;
      const allFrames = hamPage.frames();
      // mainFrame 候補を探す（URL に Action.go を含む or kanamicmain の子フレーム）
      const actionFrame = allFrames.find(f =>
        f.url().includes('Action.go') || f.url().includes('goPageAction.go')
      );
      if (actionFrame) {
        const frameAlive = await Promise.race([
          actionFrame.evaluate(() => true).catch(() => false),
          new Promise<false>(resolve => setTimeout(() => resolve(false), EVAL_TIMEOUT)),
        ]);
        if (!frameAlive) {
          throw new Error(`HAM フレーム応答なし: mainFrame (${actionFrame.url().substring(0, 80)}) の evaluate がタイムアウト — ブラウザ再起動が必要です`);
        }
      } else {
        // Action.go フレームが存在しない = HAM が正常にロードされていない
        // ただしログイン直後など初期状態では存在しない場合もあるため、
        // フレーム数が少なすぎる場合のみ警告（kanamicmain すら無い場合は異常）
        const hasKanamicmain = allFrames.some(f => f.name() === 'kanamicmain');
        if (hasKanamicmain) {
          // kanamicmain は存在するが Action.go フレームが無い = フレーム構造崩壊
          const childFrames = hamPage.frame('kanamicmain')?.childFrames() || [];
          if (childFrames.length === 0) {
            throw new Error(`HAM フレーム構造崩壊: kanamicmain に子フレームなし — ブラウザ再起動が必要です`);
          }
          // 子フレームの応答チェック
          let anyChildAlive = false;
          for (const cf of childFrames) {
            const cfAlive = await Promise.race([
              cf.evaluate(() => true).catch(() => false),
              new Promise<false>(resolve => setTimeout(() => resolve(false), EVAL_TIMEOUT)),
            ]);
            if (cfAlive) { anyChildAlive = true; break; }
          }
          if (!anyChildAlive) {
            throw new Error(`HAM 全フレーム応答なし: kanamicmain の全子フレームが応答しません — ブラウザ再起動が必要です`);
          }
        }
      }
    } catch (e) {
      const msg = (e as Error).message || '';
      // assertPagesAlive 自身が throw したエラーはそのまま伝播
      if (msg.includes('ブラウザ再起動が必要です')) throw e;
      // HAM ページ未検出等は無視（ログインフロー中等）
    }
  }

  /**
   * ページ/フレーム異常検出。
   *
   * 検出時は即座に throw — reload は試みない。
   * 上位の onRetry → ensureLoggedIn → relaunchIfAnyPageDead が
   * ブラウザ再起動 → 再ログインを統一的に処理する。
   */
  private async checkForSyserror(nav: HamNavigator): Promise<void> {
    try {
      // === 全ページ死活チェック（TRITRUS + HAM 両方） ===
      // ページレベルの OOM / クラッシュを即座に検出
      await this.assertPagesAlive(nav);

      // === フレーム内エラーチェック ===
      const hamPage = nav.hamPage;
      const allFrames = hamPage.frames();
      for (const frame of allFrames) {
        const url = frame.url();
        if (url.startsWith('chrome-error://')) {
          throw new Error(`HAM フレームクラッシュ検出 (OOM): ${url} — ブラウザ再起動が必要です`);
        }
        if (url.includes('syserror.jsp') || url.includes('error/syserror')) {
          const content = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
          throw new Error(
            `HAM システムエラー検出 (syserror.jsp): ${content.substring(0, 200)}`
          );
        }
        // フレーム内の OOM テキスト / evaluate 失敗
        let frameEvalFailed = false;
        const frameText = await frame.evaluate(() => document.body?.innerText || '').catch((err) => {
          const errMsg = String(err.message);
          if (errMsg.includes('Execution context was destroyed') ||
              errMsg.includes('Target closed') || isPageCrashError(errMsg)) {
            frameEvalFailed = true;
          }
          return '';
        });
        const oomMatch = PAGE_DEATH_KEYWORDS.find(k => frameText.includes(k));
        if (frameEvalFailed || oomMatch) {
          throw new Error(`HAM フレーム内異常検出 (OOM): "${oomMatch || 'evaluate失敗'}" — ブラウザ再起動が必要です`);
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      // checkForSyserror 自身が throw したエラーは上位に伝播
      const isOwnError = msg.includes('syserror.jsp') ||
        msg.includes('OOM') ||
        msg.includes('ブラウザ再起動') ||
        PAGE_DEATH_KEYWORDS.some(kw => msg.includes(kw));
      if (isOwnError) throw e;

      // Playwright レベルのページクラッシュ信号
      if (isPageCrashError(msg)) {
        throw new Error(`ページクラッシュ検出 (OOM): ${msg}`);
      }
      // フレームアクセスエラー（遷移中等）は無視
    }
  }

  /**
   * staffName から資格プレフィックスを抽出する
   *
   * 例:
   *   "看護師-冨迫広美" → "看護師"
   *   "理学療法士-上村謙太" → "理学療法士"
   *   "冨迫広美" → null (プレフィックスなし)
   */
  private extractQualificationPrefix(staffName: string): string | null {
    for (const prefix of QUALIFICATION_PREFIXES) {
      if (staffName.startsWith(prefix)) {
        return prefix.slice(0, -1); // 末尾の "-" を除去
      }
    }
    return null;
  }

  /**
   * hamerror.jsp ポップアップウィンドウを検知して閉じる
   *
   * HAM で存在しない careuserid を送信すると、別ウィンドウで
   * hamerror.jsp (「該当する利用者が存在しません」) が開く。
   * これを放置すると後続操作がブロックされるため、検知して閉じる。
   */
  private async checkForHamError(nav: HamNavigator): Promise<void> {
    try {
      const pages = nav.hamPage.context().pages();
      for (const page of pages) {
        const url = page.url();
        if (url.includes('hamerror.jsp') || url.includes('error/hamerror')) {
          const content = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
          logger.warn(`HAM エラーポップアップ検出: ${content.substring(0, 200).trim()}`);
          // ポップアップウィンドウを閉じる
          await page.close().catch(() => {});
          throw new Error(
            `HAM エラーポップアップ (hamerror.jsp): ${content.substring(0, 200).trim()}`
          );
        }
      }
    } catch (e) {
      if ((e as Error).message.includes('hamerror.jsp')) throw e;
      // ページアクセスエラーは無視
    }
  }

  /**
   * エラー後にメインメニューへ復帰を試みる
   */
  private async tryRecoverToMainMenu(nav: HamNavigator): Promise<HamNavigator> {
    try {
      // hamerror.jsp ポップアップウィンドウを閉じる（別ウィンドウで開くためフレームではなくページを検索）
      try {
        const pages = nav.hamPage.context().pages();
        for (const page of pages) {
          if (page.url().includes('hamerror.jsp') || page.url().includes('error/hamerror')) {
            logger.info('tryRecoverToMainMenu: hamerror.jsp ポップアップを閉じます');
            await page.close().catch(() => {});
          }
        }
      } catch { /* ignore */ }

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
        return nav;
      }
      if (pageId === 'k2_1') {
        // getCurrentPageId が k2_1 を返す = searchdate が実際に存在する
        logger.debug('tryRecoverToMainMenu: k2_1 にいるためそのまま続行');
        return nav;
      }

      // pageId が null（異常ページ）またはその他のページ → メインメニュー経由で完全復帰
      // navigateToMainMenu は forceNavigateToMainMenu まで含むため、
      // 異常ページからでも t1-2 に戻れる
      logger.info(`tryRecoverToMainMenu: pageId=${pageId} → メインメニューへ復帰`);
      await this.auth.navigateToMainMenu();
    } catch {
      logger.warn('メインメニューへの復帰に失敗。次のレコードで再ログインを試みます');
      try {
        // ensureLoggedIn が返す新しい navigator を必ず受け取る
        nav = await this.auth.ensureLoggedIn();
      } catch {
        logger.error('再ログインにも失敗');
      }
    }
    return nav;
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
    const plainName = extractPlainName(record.staffName).replace(/[\s\u3000]+/g, '');
    const lookupName = resolveStaffAlias(plainName);
    const normalizedLookup = normalizeCjkName(lookupName);
    let staffQuals = this.staffQualifications.get(lookupName)
      || this.staffQualifications.get(plainName)
      || this.staffQualifications.get(normalizedLookup)
      || this.staffQualifications.get(normalizeCjkName(plainName))
      || [];

    // SmartHR に資格情報がない場合、staffName の資格プレフィックスから取得（フォールバック）
    // 例: "准看護師-冨迫広美" → ['准看護師'], "理学療法士等-阪本大樹" → ['理学療法士']
    if (staffQuals.length === 0) {
      const nameStr = record.staffName.trim();
      const dashIdx = nameStr.indexOf('-');
      if (dashIdx > 0) {
        const prefix = nameStr.substring(0, dashIdx);
        // 資格プレフィックスとして認識できるか確認
        const knownQuals = QUALIFICATION_PREFIXES.map(p => p.slice(0, -1)); // 末尾 '-' 除去
        if (knownQuals.includes(prefix)) {
          staffQuals = [prefix];
          logger.debug(`資格フォールバック: ${record.staffName} → staffName から "${prefix}" を取得`);
        }
      }
      if (staffQuals.length === 0) {
        throw new Error(`資格情報なし: ${record.staffName} (lookup="${lookupName}") — SmartHR にも staffName プレフィックスにも資格データがありません`);
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

    let frame = await nav.getMainFrame('k2_3a');

    // searchKbn ラジオボタンを選択 + チェックボックスを設定
    await frame.evaluate((args: { searchKbnValue: string; cbs: { flag2?: boolean; pluralnurseflag1?: boolean; pluralnurseflag2?: boolean } }) => {
      // searchKbn ラジオボタン — click() で HAM の onclick ハンドラも確実に発火させる
      const radios = document.querySelectorAll('input[name="searchKbn"]');
      for (const radio of Array.from(radios)) {
        const r = radio as HTMLInputElement;
        if (r.value === args.searchKbnValue) {
          r.click();  // checked=true だけでは HAM の onclick が発火しない
          // 念のため DOM 状態も直接設定
          r.checked = true;
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

    // ラジオ設定を検証
    const actualValue = await frame.evaluate((expected: string) => {
      const checked = document.querySelector('input[name="searchKbn"]:checked') as HTMLInputElement | null;
      return checked?.value || 'none';
    }, targetValue);
    if (actualValue !== targetValue) {
      logger.warn(`searchKbn 設定不一致: 期待=${targetValue}, 実際=${actualValue} → 強制設定`);
      // フォームフィールドを直接操作（最終手段）
      await frame.evaluate((val: string) => {
        const form = document.forms[0];
        if (form) {
          // hidden field があれば直接書き換え、なければ radio を再設定
          const radios = form.querySelectorAll('input[name="searchKbn"]');
          for (const r of Array.from(radios)) {
            (r as HTMLInputElement).checked = (r as HTMLInputElement).value === val;
          }
        }
      }, targetValue);
    }

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

    // ページリロード待ち — searchKbn が正しく反映されるまで確認
    for (let i = 0; i < 10; i++) {
      await this.sleep(500);
      if (i > 0 && i % 3 === 0) await this.assertPagesAlive(nav);
      try {
        frame = await nav.getMainFrame('k2_3a');
        const postValue = await Promise.race([
          frame.evaluate((expected: string) => {
            const checked = document.querySelector('input[name="searchKbn"]:checked') as HTMLInputElement | null;
            return checked?.value || 'none';
          }, targetValue),
          new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 3000)),
        ]);
        if (postValue === targetValue) {
          logger.debug(`searchKbn 検索後確認: ${postValue} (正常)`);
          return;
        }
      } catch { /* frame 遷移中 */ }
    }
    logger.warn(`searchKbn 検索後の確認タイムアウト（targetValue=${targetValue}）`);
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

  /**
   * 利用者変更を伴う修正レコードの旧スケジュール削除。
   * 修正管理Sheetから旧あおぞらIDを取得し、旧利用者のk2_2に遷移して
   * assignId指定で削除する。
   */
  private async deleteFromOldPatient(
    nav: HamNavigator,
    record: TranscriptionRecord,
    sheetId: string,
    tab?: string,
  ): Promise<boolean> {
    try {
      // 修正管理Sheetから旧あおぞらIDを取得
      const corrections = await this.sheets.getCorrectionRecords(sheetId);
      const correction = corrections.find(c =>
        c.recordId === record.recordId && c.changeDetail.includes('あおぞらID')
      );
      if (!correction) {
        logger.warn(`修正管理Sheetに利用者変更レコードが見つかりません: ${record.recordId}`);
        return false;
      }

      // changeDetail から旧あおぞらID を抽出: 【あおぞらID】7754→7029
      const idMatch = correction.changeDetail.match(/あおぞらID[】\]]\s*(\d+)\s*→/);
      if (!idMatch) {
        logger.warn(`旧あおぞらIDをパースできません: ${correction.changeDetail}`);
        return false;
      }
      const oldAozoraId = idMatch[1];
      logger.info(`利用者変更検出: 旧あおぞらID=${oldAozoraId} → 新あおぞらID=${record.aozoraId}`);

      // k2_1に戻る
      await this.clickBackButtonOnK2_2(nav);

      // 旧利用者を検索
      const monthStart = toHamMonthStart(record.visitDate);
      await nav.setSelectValue('searchdate', monthStart);
      await nav.submitForm({ action: 'act_search' });
      await nav.waitForMainFrame('k2_1', 15000);
      await this.sleep(1000);

      // 旧あおぞらIDで患者を検索
      const k2_1Frame = await nav.getMainFrame('k2_1');
      const oldPatientId = await k2_1Frame.evaluate(({ aozoraId, variantMap }) => {
        function normCjk(s: string): string {
          let r = s.normalize('NFKC');
          r = r.replace(/[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, '');
          r = r.replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g, '');
          for (const [o, n] of variantMap) {
            if (r.includes(o)) r = r.replaceAll(o, n);
          }
          r = r.replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
          r = r.replace(/\u30F2/g, '\u30AA'); // ヲ→オ
          r = r.replace(/\u30F1/g, '\u30A8'); // ヱ→エ
          return r.replace(/[\s\u3000\u00a0]+/g, '');
        }
        const btns = document.querySelectorAll('input[name="act_result"][value="決定"]');
        for (const btn of Array.from(btns)) {
          const onclick = btn.getAttribute('onclick') || '';
          const row = btn.closest('tr');
          if (!row) continue;
          const cells = row.querySelectorAll('td');
          for (const cell of Array.from(cells)) {
            const text = normCjk(cell.textContent || '');
            if (text.includes(aozoraId)) {
              const m = onclick.match(/careuserid\s*,\s*'(\d+)'/);
              if (m) return m[1];
            }
          }
        }
        return null;
      }, { aozoraId: oldAozoraId, variantMap: CJK_VARIANT_MAP_SERIALIZABLE });

      if (!oldPatientId) {
        logger.warn(`旧利用者(あおぞらID=${oldAozoraId})がHAMで見つかりません`);
        return false;
      }

      logger.info(`旧利用者検出: あおぞらID=${oldAozoraId}, HAM患者ID=${oldPatientId}`);

      // 旧利用者のk2_2に遷移
      await k2_1Frame.evaluate((pid) => {
        const win = window as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const form = document.forms[0];
        if (typeof win.submitTargetFormEx === 'function') {
          win.submitTargetFormEx(form, 'k2_2', form.careuserid, pid);
        } else {
          win.submited = 0;
          form.careuserid.value = pid;
          form.doAction.value = 'k2_2';
          form.target = 'mainFrame';
          form.submit();
        }
      }, oldPatientId);
      await nav.waitForMainFrame('k2_2', 15000);
      await this.sleep(1000);

      // 旧利用者のk2_2でassignId指定削除
      const assignIds = record.hamAssignId!.split(',').map(s => s.trim()).filter(Boolean);
      let allDeleted = true;
      for (const aid of assignIds) {
        const deleted = await this.deleteScheduleByAssignId(nav, aid);
        if (!deleted) {
          logger.warn(`旧利用者 k2_2 でも assignId=${aid} の削除失敗`);
          allDeleted = false;
        }
      }
      return allDeleted;
    } catch (error) {
      logger.error(`旧利用者スケジュール削除エラー: ${(error as Error).message}`);
      return false;
    }
  }

  static classifyError(err: Error): {
    status: TranscriptionStatus;
    category: 'master' | 'system' | 'network';
    detail: string;
  } {
    const msg = err.message;

    // スタッフ配置不可（同時間帯重複）— schedule は作成済みだが手動配置が必要
    // 自動再試行では解決できない（HAM 上の時間重複を手動調整する必要がある）ため master 扱い
    if (msg.includes('スタッフ配置不可')) {
      return {
        status: 'エラー：マスタ不備',
        category: 'master',
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
    if (msg.includes('資格情報なし')) {
      return { status: 'エラー：マスタ不備', category: 'master', detail: `スタッフ資格情報なし（SmartHR未登録）: ${msg.substring(0, 100)}` };
    }
    if (msg.includes('精神科複数人資格制限')) {
      return { status: 'エラー：マスタ不備', category: 'master', detail: '精神科複数人(主)：看護師のみ可（准看護師/理学療法士等は不可）' };
    }
    if (msg.includes('医療リハビリ資格制限')) {
      return { status: 'エラー：マスタ不備', category: 'master', detail: '医療リハビリ：看護師/准看護師は対応不可（理学療法士等のみ）' };
    }
    if (msg.includes('不明なサービス種別')) {
      return { status: 'エラー：マスタ不備', category: 'master', detail: msg.substring(0, 100) };
    }
    if (msg.includes('サービスコード未検出')) {
      return { status: 'エラー：システム', category: 'system', detail: 'サービスコードが見つかりません。HAM設定を確認してください' };
    }

    // HAM サーバー接続不可（全リトライ失敗）— 即座に処理中止すべき
    if (msg.includes('HAM サーバー接続不可')) {
      return { status: 'エラー：システム', category: 'network', detail: 'HAMサーバーに接続できません。サーバー復旧後に再実行してください' };
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
