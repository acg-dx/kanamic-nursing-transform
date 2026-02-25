import cron from 'node-cron';
import { loadConfig } from './config/app.config';
import { logger } from './core/logger';
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
import type { WorkflowContext, WorkflowResult } from './types/workflow.types';
import type { NotificationConfig, DailyReport, WorkflowReport } from './types/notification.types';
import type { SmartHRConfig } from './types/smarthr.types';

const config = loadConfig();

// Notification config (graceful degradation if not set)
const notificationConfig: NotificationConfig = {
  enabled: process.env.NOTIFICATION_EMAIL_ENABLED === 'true',
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  from: process.env.NOTIFICATION_FROM || '',
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
  const auth = new KanamickAuthService(
    browser,
    config.kanamick.url,
    config.kanamick.username,
    config.kanamick.password
  );
  return { browser, selectorEngine, sheets, auth };
}

async function runWorkflow(workflowName: 'transcription' | 'deletion' | 'building'): Promise<WorkflowResult[]> {
  const { browser, selectorEngine, sheets, auth } = createServices();

  try {
    await browser.launch();
    await auth.login(workflowName);

    const context: WorkflowContext = {
      workflowName,
      startedAt: new Date(),
      dryRun: process.env.DRY_RUN === 'true',
      locations: config.sheets.locations,
      buildingMgmtSheetId: config.sheets.buildingMgmtSheetId,
    };

    let results: WorkflowResult[];

    if (workflowName === 'transcription') {
      const workflow = new TranscriptionWorkflow(browser, selectorEngine, sheets, auth);
      results = await workflow.run(context);
    } else if (workflowName === 'deletion') {
      const workflow = new DeletionWorkflow(browser, selectorEngine, sheets, auth);
      results = await workflow.run(context);
    } else {
      const workflow = new BuildingManagementWorkflow(browser, selectorEngine, sheets, auth);
      results = await workflow.run(context);
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
        try {
          const smarthr = new SmartHRService(smarthrConfig);
          const staffSync = new StaffSyncService(smarthr, browser, selectorEngine, auth);
          const syncResult = await staffSync.syncStaff();
          logger.info(`スタッフ同期: 登録=${syncResult.synced}, スキップ=${syncResult.skipped}, エラー=${syncResult.errors}`);
        } finally {
          await browser.close();
        }
      } catch (error) {
        logger.error(`スタッフ同期エラー（転記は続行）: ${(error as Error).message}`);
      }
    }

    // Step 2: 転記ワークフロー
    try {
      const transcriptionResults = await runWorkflow('transcription');
      allResults.push(...transcriptionResults);
    } catch (error) {
      logger.error(`転記ワークフローエラー: ${(error as Error).message}`);
    }

    // Step 3: 削除ワークフロー
    try {
      const deletionResults = await runWorkflow('deletion');
      allResults.push(...deletionResults);
    } catch (error) {
      logger.error(`削除ワークフローエラー: ${(error as Error).message}`);
    }

    // Step 4: メール通知
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

  if (workflowArg) {
    // 手動実行モード
    if (!['transcription', 'deletion', 'building'].includes(workflowArg)) {
      logger.error(`不明なワークフロー: ${workflowArg}`);
      process.exit(1);
    }
    try {
      await runWorkflow(workflowArg as 'transcription' | 'deletion' | 'building');
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
