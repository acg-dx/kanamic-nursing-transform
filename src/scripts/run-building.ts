/**
 * 同一建物管理 カナミック登録スクリプト
 *
 * 連携スプレッドシートの月度タブから新規利用者を読み取り、
 * TRITRUS 同一建物管理画面に自動登録する。
 *
 * 前提条件:
 *   1. run-building-data.ts でデータ取得済み（連携シートに月度タブが存在すること）
 *   2. .env に KANAMICK_URL, KANAMICK_USERNAME, KANAMICK_PASSWORD が設定されていること
 *
 * 使用方法:
 *   npx tsx src/scripts/run-building.ts                     # 前月データを登録
 *   npx tsx src/scripts/run-building.ts --tab=2026/02       # 指定月のデータを登録
 *   npx tsx src/scripts/run-building.ts --dry-run           # 書き込みせずに結果を表示
 *   npx tsx src/scripts/run-building.ts --tab=2026/02 --dry-run
 *   npx tsx src/scripts/run-building.ts --nursing-office=訪問看護ステーションあおぞら姶良  # 事業所フィルタ
 */
import dotenv from 'dotenv';
dotenv.config();

import { logger } from '../core/logger';
import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { NotificationService } from '../services/notification.service';
import { BuildingManagementWorkflow } from '../workflows/building-management/building.workflow';
import type { NotificationConfig, DailyReport } from '../types/notification.types';

// Ctrl+C で即座に終了
process.on('SIGINT', () => {
  logger.warn('SIGINT 受信 — 強制終了します');
  process.exit(130);
});

function parseArgs() {
  const args = process.argv.slice(2);
  let tab: string | undefined;
  let dryRun = false;
  let limit: number | undefined;
  let facility: string | undefined;
  let nursingOffice: string | undefined;

  for (const arg of args) {
    if (arg.startsWith('--tab=')) {
      tab = arg.slice('--tab='.length);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--limit=')) {
      limit = parseInt(arg.slice('--limit='.length));
    } else if (arg.startsWith('--facility=')) {
      facility = arg.slice('--facility='.length);
    } else if (arg.startsWith('--nursing-office=')) {
      nursingOffice = arg.slice('--nursing-office='.length);
    }
  }
  return { tab, dryRun, limit, facility, nursingOffice };
}

/**
 * デフォルトの前月タブ名を計算
 * 例: 2026年3月実行 → "2026/02"
 */
function getDefaultTab(): string {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}/${String(prev.getMonth() + 1).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const { tab: tabArg, dryRun, limit, facility, nursingOffice } = parseArgs();
  const tab = tabArg || getDefaultTab();

  logger.info('========================================');
  logger.info('  同一建物管理 カナミック登録');
  logger.info(`  対象タブ: ${tab}`);
  logger.info(`  ドライラン: ${dryRun}`);
  if (limit) logger.info(`  処理上限: ${limit}件`);
  if (facility) logger.info(`  施設フィルタ: ${facility}`);
  if (nursingOffice) logger.info(`  事業所フィルタ: ${nursingOffice}`);
  logger.info('========================================');

  // 環境変数チェック
  const kanamickUrl = process.env.KANAMICK_URL;
  const kanamickUser = process.env.KANAMICK_USERNAME;
  const kanamickPass = process.env.KANAMICK_PASSWORD;
  if (!kanamickUrl || !kanamickUser || !kanamickPass) {
    logger.error('KANAMICK_URL, KANAMICK_USERNAME, KANAMICK_PASSWORD が必要です');
    process.exit(1);
  }

  const buildingMgmtSheetId = process.env.BUILDING_MGMT_SHEET_ID
    || '18DueDsYPsNmePiYIp9hVpD1rIWWMCyPX5SdWzXOnZBY';

  // サービス初期化
  const aiHealing = new AIHealingService(
    process.env.OPENAI_API_KEY || '',
    process.env.AI_HEALING_MODEL || 'gpt-4o',
  );
  const selectorEngine = new SelectorEngine(aiHealing);
  const browser = new BrowserManager(selectorEngine);
  const sheets = new SpreadsheetService(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json',
  );
  const auth = new KanamickAuthService({
    url: kanamickUrl,
    username: kanamickUser,
    password: kanamickPass,
    stationName: process.env.KANAMICK_STATION_NAME || '訪問看護ステーションあおぞら姶良',
    hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
    hamOfficeCode: process.env.KANAMICK_HAM_OFFICE_CODE || '400021814',
  });

  try {
    // ブラウザ起動
    await browser.launch();
    auth.setContext(browser.browserContext);

    // ワークフロー実行
    const workflow = new BuildingManagementWorkflow(sheets, auth, {
      buildingMgmtSheetId,
      tab,
      dryRun,
      limit,
      facility,
      nursingOffice,
    });

    const result = await workflow.run();

    // 結果レポート
    const elapsed = Math.round(result.duration / 1000);
    logger.info('========================================');
    logger.info('  登録結果');
    logger.info(`  対象レコード: ${result.totalRecords}`);
    logger.info(`  処理完了: ${result.processedRecords}`);
    logger.info(`  エラー: ${result.errorRecords}`);
    logger.info(`  所要時間: ${elapsed}秒`);
    logger.info('========================================');

    // エラー詳細
    if (result.errors.length > 0) {
      logger.info('--- エラー詳細 ---');
      for (const e of result.errors) {
        logger.info(`  ${e.recordId}: [${e.category}] ${e.message}`);
      }
    }

    // メール通知
    const notificationConfig: NotificationConfig = {
      webhookUrl: process.env.NOTIFICATION_WEBHOOK_URL || '',
      to: (process.env.NOTIFICATION_TO || '').split(',').filter(Boolean),
    };

    const notificationService = new NotificationService(notificationConfig);
    if (notificationService.isEnabled()) {
      const today = new Date().toISOString().split('T')[0];
      const dailyReport: DailyReport = {
        date: today,
        reports: [{
          workflowName: result.workflowName,
          locationName: '同一建物管理',
          success: result.success,
          totalRecords: result.totalRecords,
          processedRecords: result.processedRecords,
          errorRecords: result.errorRecords,
          errors: result.errors.map(e => ({
            recordId: e.recordId,
            message: e.message,
            category: e.category,
          })),
          duration: result.duration,
          executedAt: new Date().toISOString(),
        }],
        overallSuccess: result.success,
        totalProcessed: result.processedRecords,
        totalErrors: result.errorRecords,
      };
      await notificationService.sendDailyReport(dailyReport);
      logger.info('メール通知送信完了');
    }

    if (result.errorRecords > 0) {
      process.exit(1);
    }
  } catch (error) {
    logger.error(`同一建物管理 異常終了: ${(error as Error).message}`);
    logger.error((error as Error).stack || '');
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  logger.error(`致命的エラー: ${(error as Error).message}`);
  process.exit(1);
});
