import cron from 'node-cron';
import { loadConfig } from './config/app.config';
import { logger } from './core/logger';

// Ctrl+C で即座に終了（async chain が SIGINT を飲み込むのを防止）
process.on('SIGINT', () => {
  logger.warn('SIGINT 受信 — 強制終了します');
  process.exit(130);
});
import { BrowserManager } from './core/browser-manager';
import { SelectorEngine } from './core/selector-engine';
import { AIHealingService } from './core/ai-healing-service';
import { SpreadsheetService } from './services/spreadsheet.service';
import { KanamickAuthService } from './services/kanamick-auth.service';
import { TranscriptionWorkflow } from './workflows/transcription/transcription.workflow';
import { DeletionWorkflow } from './workflows/deletion/deletion.workflow';
import { BuildingManagementWorkflow } from './workflows/building-management/building.workflow';
import { NotificationService } from './services/notification.service';
import { SmartHRService } from './services/smarthr.service';
import { StaffSyncService } from './workflows/staff-sync/staff-sync.workflow';
import { CorrectionDetector } from './workflows/correction/correction-detection';
// PatientMasterService / PatientCsvDownloaderService は processLocation 内で事業所ごとに読み込み
import { ReconciliationService } from './services/reconciliation.service';
import type { WorkflowContext, WorkflowResult } from './types/workflow.types';
import type { NotificationConfig, DailyReport, WorkflowReport } from './types/notification.types';
import type { SmartHRConfig } from './types/smarthr.types';

const config = loadConfig();

// Notification config (graceful degradation if not set)
const notificationConfig: NotificationConfig = {
  webhookUrl: process.env.NOTIFICATION_WEBHOOK_URL || '',
  to: (process.env.NOTIFICATION_TO || '').split(',').filter(Boolean),
};

// SmartHR config (optional, graceful degradation if not set)
const smarthrConfig: SmartHRConfig | null = process.env.SMARTHR_ACCESS_TOKEN
  ? {
      baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
      accessToken: process.env.SMARTHR_ACCESS_TOKEN,
    }
  : null;

// 防重入ロック
let isRunning = false;

function createServices() {
  const aiHealing = new AIHealingService(config.aiHealing.apiKey, config.aiHealing.model);
  const selectorEngine = new SelectorEngine(aiHealing);
  const sheets = new SpreadsheetService(config.sheets.serviceAccountKeyPath);
  const browser = new BrowserManager(selectorEngine);

  // RUN_LOCATIONS で絞り込まれた最初の事業所の情報で HAM にログイン
  const primaryLocation = config.sheets.locations[0];
  const auth = new KanamickAuthService({
    url: config.kanamick.url,
    username: config.kanamick.username,
    password: config.kanamick.password,
    stationName: primaryLocation?.stationName || '訪問看護ステーションあおぞら姶良',
    hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
    hamOfficeCode: primaryLocation?.hamOfficeCode || '400021814',
  });
  return { browser, selectorEngine, sheets, auth };
}

async function runWorkflow(workflowName: 'transcription' | 'deletion' | 'building', tab?: string): Promise<WorkflowResult[]> {
  const { browser, selectorEngine, sheets, auth } = createServices();

  try {
    await browser.launch();
    auth.setContext(browser.browserContext, browser);
    await auth.login();

    const context: WorkflowContext = {
      workflowName,
      startedAt: new Date(),
      dryRun: process.env.DRY_RUN === 'true',
      locations: config.sheets.locations,
      buildingMgmtSheetId: config.sheets.buildingMgmtSheetId,
      tab,
    };

    let results: WorkflowResult[];

    if (workflowName === 'transcription') {
      const workflow = new TranscriptionWorkflow(browser, selectorEngine, sheets, auth);

      // 利用者マスタ CSV は各事業所の processLocation 内で個別にダウンロード・読み込み

      // SmartHR が設定されている場合、転記前スタッフ自動補登を有効化
      if (smarthrConfig) {
        const smarthr = new SmartHRService(smarthrConfig);
        const staffSync = new StaffSyncService(smarthr, auth);
        workflow.setStaffAutoRegister(smarthr, staffSync);
      }
      results = await workflow.run(context);
    } else if (workflowName === 'deletion') {
      const workflow = new DeletionWorkflow(browser, selectorEngine, sheets, auth);
      results = await workflow.run(context);
    } else {
      // 同一建物管理は独立した run-building.ts スクリプトで実行するため、
      // ここでは簡易版として呼び出す。
      const tab = context.tab || (() => {
        const now = new Date();
        const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        return `${prev.getFullYear()}/${String(prev.getMonth() + 1).padStart(2, '0')}`;
      })();
      const buildingWorkflow = new BuildingManagementWorkflow(sheets, auth, {
        buildingMgmtSheetId: context.buildingMgmtSheetId || config.sheets.buildingMgmtSheetId,
        tab,
        dryRun: context.dryRun,
      });
      const result = await buildingWorkflow.run();
      results = [result];
    }

    const totalErrors = results.reduce((sum, r) => sum + r.errorRecords, 0);
    const totalProcessed = results.reduce((sum, r) => sum + r.processedRecords, 0);
    logger.info(`${workflowName}ワークフロー完了: 処理=${totalProcessed}, エラー=${totalErrors}`);

    return results;
  } catch (error) {
    logger.error(`${workflowName}ワークフロー異常終了: ${(error as Error).message}`);
    throw error;
  } finally {
    await browser.close();
  }
}

async function runDailyJob(): Promise<void> {
  if (isRunning) {
    logger.warn('前回の処理が完了していないためスキップします');
    return;
  }

  isRunning = true;
  logger.info('=== 日次処理開始 ===');

  const allResults: WorkflowResult[] = [];
  const notificationService = new NotificationService(notificationConfig);

  try {
    // Step 1: SmartHR スタッフ同期（失敗しても転記は続行）
    if (smarthrConfig) {
      try {
        const { browser, selectorEngine, auth } = createServices();
        await browser.launch();
        auth.setContext(browser.browserContext, browser);
        try {
          const smarthr = new SmartHRService(smarthrConfig);
          const staffSync = new StaffSyncService(smarthr, auth);
          const syncResult = await staffSync.syncStaff();
          logger.info(`スタッフ同期: 登録=${syncResult.synced}, スキップ=${syncResult.skipped}, エラー=${syncResult.errors}`);
        } finally {
          await browser.close();
        }
      } catch (error) {
        logger.error(`スタッフ同期エラー（転記は続行）: ${(error as Error).message}`);
      }
    }

    // Step 2: 前月未登録チェック（pre-flight）
    try {
      const preflight_sheets = new SpreadsheetService(config.sheets.serviceAccountKeyPath);
      const reconciliation = new ReconciliationService(preflight_sheets);
      for (const location of config.sheets.locations) {
        const prevResult = await reconciliation.checkPreviousMonthUnregistered(location.sheetId);
        if (prevResult.hasPending) {
          logger.warn(`[${location.name}] 前月に未登録レコード ${prevResult.pendingCount} 件を検出！ 先に前月分を処理してください。`);
        }
      }
    } catch (error) {
      logger.warn(`前月未登録チェックエラー（転記は続行）: ${(error as Error).message}`);
    }

    // Step 3: 転記ワークフロー
    try {
      const transcriptionResults = await runWorkflow('transcription');
      allResults.push(...transcriptionResults);
    } catch (error) {
      logger.error(`転記ワークフローエラー: ${(error as Error).message}`);
    }

    // Step 4: 削除ワークフロー
    try {
      const deletionResults = await runWorkflow('deletion');
      allResults.push(...deletionResults);
    } catch (error) {
      logger.error(`削除ワークフローエラー: ${(error as Error).message}`);
    }

    // Step 5: メール通知
    if (notificationService.isEnabled() && allResults.length > 0) {
      const today = new Date().toISOString().split('T')[0];
      const totalProcessed = allResults.reduce((sum, r) => sum + r.processedRecords, 0);
      const totalErrors = allResults.reduce((sum, r) => sum + r.errorRecords, 0);

      const dailyReport: DailyReport = {
        date: today,
        reports: allResults.map(r => ({
          workflowName: r.workflowName,
          locationName: r.locationName,
          success: r.success,
          totalRecords: r.totalRecords,
          processedRecords: r.processedRecords,
          errorRecords: r.errorRecords,
          errors: r.errors.map(e => ({
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
    }
  } finally {
    isRunning = false;
    logger.info('=== 日次処理完了 ===');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const workflowArg = args.find(a => a.startsWith('--workflow='))?.split('=')[1]
    || (args.includes('--workflow') ? args[args.indexOf('--workflow') + 1] : null);
  const tabArg = args.find(a => a.startsWith('--tab='))?.split('=')[1] || undefined;

  if (workflowArg) {
    // 手動実行モード
    if (!['transcription', 'deletion', 'building'].includes(workflowArg)) {
      logger.error(`不明なワークフロー: ${workflowArg}`);
      process.exit(1);
    }
    if (tabArg) {
      logger.info(`対象タブ: ${tabArg}`);
    }
    try {
      const allResults: WorkflowResult[] = [];

      // 転記ワークフローの場合、前月未登録を自動処理
      if (workflowArg === 'transcription' && !tabArg) {
        const preflight_sheets = new SpreadsheetService(config.sheets.serviceAccountKeyPath);
        const reconciliation = new ReconciliationService(preflight_sheets);
        const now = new Date();
        const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const prevTab = `${prev.getFullYear()}年${String(prev.getMonth() + 1).padStart(2, '0')}月`;

        let hasPrevPending = false;
        for (const location of config.sheets.locations) {
          const prevResult = await reconciliation.checkPreviousMonthUnregistered(location.sheetId);
          if (prevResult.hasPending) {
            logger.warn(`[${location.name}] 前月(${prevTab})に未登録レコード ${prevResult.pendingCount} 件を検出`);
            hasPrevPending = true;
          }
        }

        if (hasPrevPending) {
          logger.info(`=== 前月(${prevTab})の未登録分を先に転記します ===`);
          const prevResults = await runWorkflow('transcription', prevTab);
          allResults.push(...prevResults);
          logger.info(`=== 前月(${prevTab})転記完了。当月に進みます ===`);
        }
      }

      const results = await runWorkflow(workflowArg as 'transcription' | 'deletion' | 'building', tabArg);
      allResults.push(...results);

      // 手動実行でもメール通知を送信
      const notifService = new NotificationService(notificationConfig);
      if (notifService.isEnabled() && allResults.length > 0) {
        const today = new Date().toISOString().split('T')[0];
        const totalProcessed = allResults.reduce((sum, r) => sum + r.processedRecords, 0);
        const totalErrors = allResults.reduce((sum, r) => sum + r.errorRecords, 0);
        const dailyReport: DailyReport = {
          date: today,
          reports: allResults.map(r => ({
            workflowName: r.workflowName,
            locationName: r.locationName,
            success: r.success,
            totalRecords: r.totalRecords,
            processedRecords: r.processedRecords,
            errorRecords: r.errorRecords,
            errors: r.errors.map(e => ({ recordId: e.recordId, message: e.message, category: e.category })),
            duration: r.duration,
            executedAt: new Date().toISOString(),
          })),
          overallSuccess: totalErrors === 0,
          totalProcessed,
          totalErrors,
        };
        await notifService.sendDailyReport(dailyReport);
        logger.info('メール通知送信完了');
      }

      process.exit(0);
    } catch (error) {
      logger.error(`手動実行エラー: ${(error as Error).message}`);
      process.exit(1);
    }
  } else {
    // cronモード
    logger.info('cronモードで起動');
    logger.info(`転記cron: ${config.scheduling.transcriptionCron}`);
    logger.info(`建物管理cron: ${config.scheduling.buildingMgmtCron}`);

    cron.schedule(config.scheduling.transcriptionCron, () => {
      runDailyJob().catch(err => logger.error(`cronエラー: ${err.message}`));
    });

    cron.schedule(config.scheduling.buildingMgmtCron, () => {
      runWorkflow('building').catch(err => logger.error(`建物管理cronエラー: ${err.message}`));
    });

    logger.info('スケジューラー起動完了。待機中...');
  }
}

main().catch(error => {
  logger.error(`致命的エラー: ${(error as Error).message}`);
  process.exit(1);
});
