/**
 * 転記実行スクリプト
 *
 * 複数事業所の Google Sheets データを HAM に転記する。
 *
 * 前提条件:
 *   1. スタッフ同期が完了していること (run-staff-sync.ts)
 *   2. .env に全環境変数が設定されていること
 *
 * CSV 読み込み優先順位:
 *   1. --csv= で明示指定 → ローカルファイルを読み込み
 *   2. --auto-csv → HAM から自動ダウンロード（デフォルト）
 *   3. デフォルトパスにファイルが存在すれば読み込み
 *
 * 使用方法:
 *   npx tsx src/scripts/run-transcription.ts                    # HAM から CSV 自動ダウンロード
 *   npx tsx src/scripts/run-transcription.ts --dry-run
 *   npx tsx src/scripts/run-transcription.ts --csv=./4664590280_userallfull_202602.csv  # ローカル CSV 指定
 *   npx tsx src/scripts/run-transcription.ts --limit=10
 *   npx tsx src/scripts/run-transcription.ts --tab=2026年02月   # 前月タブを指定して処理
 */
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { logger } from '../core/logger';
import { loadConfig } from '../config/app.config';

// Ctrl+C で即座に終了（async chain が SIGINT を飲み込むのを防止）
process.on('SIGINT', () => {
  logger.warn('SIGINT 受信 — 強制終了します');
  process.exit(130);
});
import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { SmartHRService } from '../services/smarthr.service';
import { PatientMasterService } from '../services/patient-master.service';
import { PatientCsvDownloaderService } from '../services/patient-csv-downloader.service';
import { TranscriptionWorkflow } from '../workflows/transcription/transcription.workflow';
import { DeletionWorkflow } from '../workflows/deletion/deletion.workflow';
import { StaffSyncService } from '../workflows/staff-sync/staff-sync.workflow';
import { ReconciliationService } from '../services/reconciliation.service';
import { NotificationService } from '../services/notification.service';
import type { WorkflowContext } from '../types/workflow.types';
import type { NotificationConfig, DailyReport } from '../types/notification.types';
import type { WorkflowResult } from '../types/workflow.types';
import { extractPlainName, resolveStaffAlias, STAFF_EMPCODE_OVERRIDES } from '../core/cjk-normalize';

/** 通知サービス（main 内外で共有） */
function createNotificationService(): NotificationService {
  const config: NotificationConfig = {
    webhookUrl: process.env.NOTIFICATION_WEBHOOK_URL || '',
    to: (process.env.NOTIFICATION_TO || '').split(',').filter(Boolean),
  };
  return new NotificationService(config);
}

/** 結果レポートからメール送信 */
async function sendNotification(results: WorkflowResult[]): Promise<void> {
  const notificationService = createNotificationService();
  if (!notificationService.isEnabled() || results.length === 0) return;

  const totalProcessed = results.reduce((sum, r) => sum + r.processedRecords, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errorRecords, 0);
  const today = new Date().toISOString().split('T')[0];

  const dailyReport: DailyReport = {
    date: today,
    reports: results.map(r => ({
      workflowName: r.workflowName,
      locationName: r.locationName,
      success: r.success,
      totalRecords: r.totalRecords,
      processedRecords: r.processedRecords,
      errorRecords: r.errorRecords,
      errors: r.errors.map((e: { recordId: string; message: string; category: string }) => ({
        recordId: e.recordId,
        message: e.message,
        category: e.category,
      })),
      duration: r.duration,
      executedAt: new Date().toISOString(),
    })),
    overallSuccess: totalErrors === 0,
    totalProcessed,
    totalErrors,
  };
  await notificationService.sendDailyReport(dailyReport);
  logger.info('メール通知送信完了');
}

/** エラーメッセージからメール送信（異常終了時） */
async function sendErrorNotification(errorMessage: string): Promise<void> {
  const notificationService = createNotificationService();
  if (!notificationService.isEnabled()) return;

  const today = new Date().toISOString().split('T')[0];
  const dailyReport: DailyReport = {
    date: today,
    reports: [{
      workflowName: 'transcription',
      locationName: 'system',
      success: false,
      totalRecords: 0,
      processedRecords: 0,
      errorRecords: 1,
      errors: [{ recordId: '-', message: errorMessage, category: 'FATAL' }],
      duration: 0,
      executedAt: new Date().toISOString(),
    }],
    overallSuccess: false,
    totalProcessed: 0,
    totalErrors: 1,
  };
  await notificationService.sendDailyReport(dailyReport);
  logger.info('エラー通知メール送信完了');
}

/** デフォルト CSV ファイルパス（現在の年月で自動生成） */
const DEFAULT_CSV = `./4664590280_userallfull_${PatientCsvDownloaderService.getCurrentMonth()}.csv`;

/**
 * タブ名（YYYY年MM月）をパースして { year, month } を返す
 */
function parseTab(tab: string): { year: number; month: number } {
  const m = tab.match(/^(\d{4})年(\d{2})月$/);
  if (!m) throw new Error(`無効なタブ形式: ${tab} (期待: YYYY年MM月)`);
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
}

/**
 * { year, month } → タブ名（YYYY年MM月）
 */
function formatTab(year: number, month: number): string {
  return `${year}年${String(month).padStart(2, '0')}月`;
}

/**
 * 現在の月のタブ名を返す
 */
function currentMonthTab(): string {
  const now = new Date();
  return formatTab(now.getFullYear(), now.getMonth() + 1);
}

/**
 * START_FROM_TAB から当月までのタブ一覧を生成
 * 例: START_FROM_TAB=2026年03月, 現在=2026年04月 → ['2026年03月', '2026年04月']
 */
function buildTargetTabs(startFrom: string): string[] {
  const start = parseTab(startFrom);
  const now = new Date();
  const endYear = now.getFullYear();
  const endMonth = now.getMonth() + 1;

  const tabs: string[] = [];
  let y = start.year;
  let m = start.month;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    tabs.push(formatTab(y, m));
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return tabs;
}

async function main(): Promise<void> {
  // コマンドライン引数
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const explicitCsv = args.find(a => a.startsWith('--csv='))?.split('=')[1];
  const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? parseInt(limitArg, 10) : 0;
  const tabArg = args.find(a => a.startsWith('--tab='))?.split('=')[1]
    || process.env.TARGET_TAB
    || undefined;
  const startFromTab = args.find(a => a.startsWith('--start-from='))?.split('=')[1]
    || process.env.START_FROM_TAB
    || undefined;
  const csvMode = explicitCsv ? 'local' : 'auto';
  const config = loadConfig();
  const locations = config.sheets.locations;

  // 処理対象タブを決定
  // 優先順位: --tab (単一月固定) > --start-from / START_FROM_TAB (範囲) > 当月のみ
  const targetTabs: string[] = tabArg
    ? [tabArg]
    : startFromTab
      ? buildTargetTabs(startFromTab)
      : [currentMonthTab()];

  if (locations.length === 0) {
    throw new Error('処理対象の事業所が設定されていません（config.sheets.locations）');
  }

  logger.info('========================================');
  logger.info('  転記実行');
  logger.info(`  対象事業所: ${locations.map(loc => loc.name).join(', ')}`);
  logger.info(`  事業所数: ${locations.length}`);
  logger.info(`  対象タブ: ${targetTabs.join(' → ')}`);
  logger.info(`  CSV モード: ${csvMode === 'local' ? `ローカル (${explicitCsv})` : 'HAM 自動ダウンロード'}`);
  logger.info(`  ドライラン: ${dryRun}`);
  if (limit > 0) logger.info(`  レコード上限: ${limit}`);
  logger.info('========================================');

  // === 共有サービス初期化 ===
  const smarthrToken = process.env.SMARTHR_ACCESS_TOKEN;
  let smarthr: SmartHRService | null = null;

  const sheets = new SpreadsheetService(
    config.sheets.serviceAccountKeyPath
  );

  if (smarthrToken) {
    smarthr = new SmartHRService({
      baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
      accessToken: smarthrToken,
    });
  } else {
    logger.warn('SMARTHR_ACCESS_TOKEN 未設定: スタッフ資格チェック＋自動補登はスキップされます');
  }

  // 環境変数チェック
  const kanamickUrl = process.env.KANAMICK_URL || config.kanamick.url;
  const kanamickUser = process.env.KANAMICK_USERNAME || config.kanamick.username;
  const kanamickPass = process.env.KANAMICK_PASSWORD || config.kanamick.password;
  if (!kanamickUrl || !kanamickUser || !kanamickPass) {
    logger.error('KANAMICK_URL, KANAMICK_USERNAME, KANAMICK_PASSWORD が必要です');
    process.exit(1);
  }

  // サービス初期化
  const aiHealing = new AIHealingService(
    process.env.OPENAI_API_KEY || '',
    process.env.AI_HEALING_MODEL || 'gpt-4o'
  );
  const selectorEngine = new SelectorEngine(aiHealing);
  const browser = new BrowserManager(selectorEngine);

  try {
    // ブラウザ起動（全事業所で共有）
    await browser.launch();
    BrowserManager.logMemoryUsage('ブラウザ起動後');

    const allResults: WorkflowResult[] = [];

    for (const [index, loc] of locations.entries()) {
      const isFirstLocation = index === 0;
      logger.info(`=== ${loc.name} 処理開始 ===`);

      const auth = new KanamickAuthService({
        url: kanamickUrl,
        username: kanamickUser,
        password: kanamickPass,
        stationName: loc.stationName,
        hamOfficeKey: '6',
        hamOfficeCode: loc.hamOfficeCode,
      });
      auth.setContext(browser.browserContext, browser);

      // === Step 0: 利用者マスタ CSV（事業所ごと） ===
      const patientMaster = new PatientMasterService();

      if (csvMode === 'local' && isFirstLocation) {
        // --csv= 明示指定は最初の事業所のみ（後方互換）
        const resolvedCsvPath = path.resolve(explicitCsv!);
        await patientMaster.loadFromCsv(resolvedCsvPath);
        logger.info(`[${loc.name}] 利用者マスタ: ${patientMaster.count}名読み込み完了（ローカル CSV）`);
      } else {
        // CSV 自動取得 (ローカルキャッシュ優先、なければ HAM からダウンロード)
        try {
          const csvDownloader = new PatientCsvDownloaderService(auth);
          const targetMonth = PatientCsvDownloaderService.getCurrentMonth();
          const localCsv = csvDownloader.findLocalCsv(targetMonth);
          if (localCsv) {
            await patientMaster.loadFromCsv(localCsv);
            logger.info(`[${loc.name}] 利用者マスタ: ${patientMaster.count}名読み込み完了（ローカルキャッシュ）`);
          } else {
            await auth.login();
            const csvPath = await csvDownloader.downloadPatientCsv({ targetMonth });
            await patientMaster.loadFromCsv(csvPath);
            logger.info(`[${loc.name}] 利用者マスタ: ${patientMaster.count}名読み込み完了（HAM ダウンロード）`);
          }
        } catch (csvError) {
          logger.warn(`[${loc.name}] CSV 自動ダウンロード失敗（転記は続行）: ${(csvError as Error).message}`);
        }
      }

      // === 事業所ごと HAM ログイン ===
      await auth.login();

      // === 前月未登録チェック（START_FROM_TAB 未使用 & TARGET_TAB 未使用の場合のみ） ===
      const skipPrevMonth = process.env.SKIP_PREV_MONTH === 'true' || startFromTab !== undefined;
      if (skipPrevMonth) {
        logger.info(`[${loc.name}] 前月チェックをスキップ（${startFromTab ? 'START_FROM_TAB で範囲指定中' : 'SKIP_PREV_MONTH=true'}）`);
      }
      if (!tabArg && !startFromTab && !skipPrevMonth) {
        try {
          const reconciliation = new ReconciliationService(sheets);
          const prevResult = await reconciliation.checkPreviousMonthUnregistered(loc.sheetId);
          if (prevResult.hasPending) {
            const now = new Date();
            const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const prevTab = `${prev.getFullYear()}年${String(prev.getMonth() + 1).padStart(2, '0')}月`;
            logger.warn(`[${loc.name}] 前月(${prevTab})に未登録レコード ${prevResult.pendingCount} 件を検出 → 前月を先に転記します`);

            // 前月用スタッフ資格マップ
            const prevStaffQualifications = new Map<string, string[]>();
            if (smarthr) {
              const sheetRecords = await sheets.getTranscriptionRecords(loc.sheetId, prevTab);
              const empCodes = [...new Set(sheetRecords.map(r => r.staffNumber).filter(Boolean))];
              if (empCodes.length > 0) {
                const crewMap = await smarthr.getCrewsByEmpCodes(empCodes);
                for (const [, crew] of crewMap) {
                  const entry = smarthr.toStaffMasterEntry(crew);
                  if (entry.staffName && entry.qualifications.length > 0) {
                    prevStaffQualifications.set(entry.staffName, entry.qualifications);
                  }
                }
              }
            }

            const prevWorkflow = new TranscriptionWorkflow(browser, selectorEngine, sheets, auth);
            prevWorkflow.setPatientMaster(patientMaster);
            prevWorkflow.setStaffQualifications(prevStaffQualifications);
            if (smarthr) {
              prevWorkflow.setStaffAutoRegister(smarthr);
            }
            const prevContext: WorkflowContext = {
              workflowName: 'transcription',
              startedAt: new Date(),
              dryRun,
              locations: [loc],
              tab: prevTab,
            };
            const prevResults = await prevWorkflow.run(prevContext);
            allResults.push(...prevResults);
            const prevProcessed = prevResults.reduce((sum, r) => sum + r.processedRecords, 0);
            const prevErrors = prevResults.reduce((sum, r) => sum + r.errorRecords, 0);
            logger.info(`[${loc.name}] 前月(${prevTab})転記完了: 処理=${prevProcessed}, エラー=${prevErrors}`);
          } else {
            logger.info(`[${loc.name}] 前月未登録チェック: 問題なし`);
          }
        } catch (error) {
          logger.warn(`[${loc.name}] 前月未登録チェックエラー（転記は続行）: ${(error as Error).message}`);
        }
      }

      // === 各対象月タブを順番に転記 ===
      for (const currentTab of targetTabs) {
        logger.info(`[${loc.name}] === タブ: ${currentTab} 転記開始 ===`);

        // SmartHR からスタッフ資格マップ構築（タブごと）
        const staffQualifications = new Map<string, string[]>();
        if (smarthr) {
          const sheetRecords = await sheets.getTranscriptionRecords(loc.sheetId, currentTab);
          const empCodes = [...new Set(sheetRecords.map(r => r.staffNumber).filter(Boolean))];
          logger.info(`[${loc.name}][${currentTab}] Sheet 内ユニークスタッフ: ${empCodes.length}名 → SmartHR で資格検索`);

          if (empCodes.length > 0) {
            const crewMap = await smarthr.getCrewsByEmpCodes(empCodes);
            logger.info(`[${loc.name}][${currentTab}] SmartHR 検索結果: ${crewMap.size}/${empCodes.length}名`);

            for (const [, crew] of crewMap) {
              const entry = smarthr.toStaffMasterEntry(crew);
              if (entry.staffName && entry.qualifications.length > 0) {
                staffQualifications.set(entry.staffName, entry.qualifications);
              }
            }
          }

          // emp_code 上書き対象のスタッフを補完検索
          const overrideEmpCodes: string[] = [];
          for (const r of sheetRecords) {
            const plainName = extractPlainName(r.staffName).replace(/[\s\u3000\u00a0]+/g, '');
            const override = STAFF_EMPCODE_OVERRIDES[plainName];
            if (override && !empCodes.includes(override)) {
              overrideEmpCodes.push(override);
            }
          }
          if (overrideEmpCodes.length > 0) {
            const overrideCodes = [...new Set(overrideEmpCodes)];
            const overrideCrewMap = await smarthr.getCrewsByEmpCodes(overrideCodes);
            for (const [, crew] of overrideCrewMap) {
              const entry = smarthr.toStaffMasterEntry(crew);
              if (entry.staffName && entry.qualifications.length > 0) {
                staffQualifications.set(entry.staffName, entry.qualifications);
                const aliasName = resolveStaffAlias(entry.staffName);
                if (aliasName !== entry.staffName) {
                  staffQualifications.set(aliasName, entry.qualifications);
                }
                logger.info(`[${loc.name}][${currentTab}] emp_code 上書き補完: ${entry.staffName} → [${entry.qualifications.join(', ')}]`);
              }
            }
          }

          logger.info(`[${loc.name}][${currentTab}] スタッフ資格マップ: ${staffQualifications.size}名分構築完了`);
          for (const [name, quals] of staffQualifications) {
            logger.debug(`  ${name}: [${quals.join(', ')}]`);
          }
        }

        // ワークフロー作成 + マスタ設定
        const workflow = new TranscriptionWorkflow(browser, selectorEngine, sheets, auth);
        workflow.setPatientMaster(patientMaster);
        workflow.setStaffQualifications(staffQualifications);

        // SmartHR 自動補登を有効化
        if (smarthr) {
          const staffSync = new StaffSyncService(smarthr, auth, {
            cd: loc.tritrusOfficeCd,
            name: loc.stationName,
          });
          workflow.setStaffAutoRegister(smarthr, staffSync);
          logger.info(`[${loc.name}][${currentTab}] スタッフ自動補登: 有効（SmartHR 経由, 事業所=${loc.stationName}）`);
        }

        // コンテキスト作成
        const context: WorkflowContext = {
          workflowName: 'transcription',
          startedAt: new Date(),
          dryRun,
          locations: [loc],
          tab: currentTab,
        };

        // 転記実行
        const startTime = Date.now();
        const results = await workflow.run(context);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        allResults.push(...results);

        // 結果レポート
        const totalProcessed = results.reduce((sum, r) => sum + r.processedRecords, 0);
        const totalErrors = results.reduce((sum, r) => sum + r.errorRecords, 0);
        const totalRecords = results.reduce((sum, r) => sum + r.totalRecords, 0);
        logger.info(`[${loc.name}][${currentTab}] 転記結果: 対象=${totalRecords}, 完了=${totalProcessed}, エラー=${totalErrors}, 所要=${elapsed}秒`);

        // エラー詳細
        for (const r of results) {
          if (r.errors.length > 0) {
            logger.info(`--- ${r.locationName} [${currentTab}] エラー詳細 ---`);
            for (const e of r.errors) {
              logger.info(`  ${e.recordId}: [${e.category}] ${e.message}`);
            }
          }
        }
      }

      // === 削除ワークフロー（事業所ごと1回、当月分のみ） ===
      try {
        logger.info('========================================');
        logger.info(`  ${loc.name} 削除処理開始`);
        logger.info('========================================');
        const deletionWorkflow = new DeletionWorkflow(browser, selectorEngine, sheets, auth);
        const deletionContext: WorkflowContext = {
          workflowName: 'deletion',
          startedAt: new Date(),
          dryRun,
          locations: [loc],
        };
        const deletionResults = await deletionWorkflow.run(deletionContext);
        allResults.push(...deletionResults);

        const delProcessed = deletionResults.reduce((sum, r) => sum + r.processedRecords, 0);
        const delErrors = deletionResults.reduce((sum, r) => sum + r.errorRecords, 0);
        logger.info(`[${loc.name}] 削除結果: 処理=${delProcessed}, エラー=${delErrors}`);
      } catch (delError) {
        logger.error(`[${loc.name}] 削除ワークフローエラー（転記は完了済み）: ${(delError as Error).message}`);
      }

      // 次事業所へ向けた軽いクリーンアップ
      try {
        await auth.navigateToMainMenu();
      } catch (navError) {
        logger.warn(`[${loc.name}] メインメニュー復帰に失敗（次事業所で再ログイン継続）: ${(navError as Error).message}`);
      }

      await browser.closeExtraPages();
      BrowserManager.logMemoryUsage(`${loc.name} 処理後`);

      logger.info(`=== ${loc.name} 処理終了 ===`);
    }

    const aggregatedProcessed = allResults.reduce((sum, r) => sum + r.processedRecords, 0);
    const aggregatedErrors = allResults.reduce((sum, r) => sum + r.errorRecords, 0);
    const aggregatedRecords = allResults.reduce((sum, r) => sum + r.totalRecords, 0);

    logger.info('========================================');
    logger.info('  全事業所 処理結果');
    logger.info(`  対象レコード: ${aggregatedRecords}`);
    logger.info(`  処理完了: ${aggregatedProcessed}`);
    logger.info(`  エラー: ${aggregatedErrors}`);
    logger.info('========================================');

    // メール通知（全事業所の転記+削除結果をまとめて送信）
    await sendNotification(allResults);

    if (aggregatedErrors > 0) {
      process.exit(1);
    }
  } catch (error) {
    const msg = (error as Error).message;
    logger.error(`転記異常終了: ${msg}`);
    // 異常終了時もメール通知を送信
    await sendErrorNotification(msg).catch(notifyErr => {
      logger.error(`エラー通知送信失敗: ${(notifyErr as Error).message}`);
    });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  logger.error(`致命的エラー: ${(error as Error).message}`);
  process.exit(1);
});
