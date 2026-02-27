/**
 * 転記実行スクリプト
 *
 * 姶良事業所の Google Sheets データを HAM に転記する。
 *
 * 前提条件:
 *   1. スタッフ同期が完了していること (run-staff-sync.ts)
 *   2. userallfull CSV がプロジェクトルートにあること
 *   3. .env に全環境変数が設定されていること
 *
 * 使用方法:
 *   npx tsx src/scripts/run-transcription.ts
 *   npx tsx src/scripts/run-transcription.ts --dry-run
 *   npx tsx src/scripts/run-transcription.ts --csv=./4664590280_userallfull_202602.csv
 *   npx tsx src/scripts/run-transcription.ts --limit=10
 */
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { logger } from '../core/logger';
import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { SmartHRService } from '../services/smarthr.service';
import { PatientMasterService } from '../services/patient-master.service';
import { TranscriptionWorkflow } from '../workflows/transcription/transcription.workflow';
import { NotificationService } from '../services/notification.service';
import type { WorkflowContext } from '../types/workflow.types';
import type { NotificationConfig, DailyReport } from '../types/notification.types';

/** 姶良事業所 Sheet ID */
const AIRA_SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';

/** デフォルト CSV ファイルパス */
const DEFAULT_CSV = './4664590280_userallfull_202602.csv';

async function main(): Promise<void> {
  // コマンドライン引数
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const csvPath = args.find(a => a.startsWith('--csv='))?.split('=')[1] || DEFAULT_CSV;
  const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? parseInt(limitArg, 10) : 0;

  logger.info('========================================');
  logger.info('  転記実行');
  logger.info(`  事業所: 姶良`);
  logger.info(`  Sheet ID: ${AIRA_SHEET_ID}`);
  logger.info(`  CSV: ${csvPath}`);
  logger.info(`  ドライラン: ${dryRun}`);
  if (limit > 0) logger.info(`  レコード上限: ${limit}`);
  logger.info('========================================');

  // === Step 0: 利用者マスタ CSV 読み込み ===
  const patientMaster = new PatientMasterService();
  const resolvedCsvPath = path.resolve(csvPath);
  await patientMaster.loadFromCsv(resolvedCsvPath);
  logger.info(`利用者マスタ: ${patientMaster.count}名読み込み完了`);

  // === Step 0.5: SmartHR からスタッフ資格マップ構築 ===
  const smarthrToken = process.env.SMARTHR_ACCESS_TOKEN;
  const staffQualifications = new Map<string, string[]>();

  if (smarthrToken) {
    const smarthr = new SmartHRService({
      baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
      accessToken: smarthrToken,
    });

    const allCrews = await smarthr.getAllCrews();
    const activeCrews = smarthr.filterActive(allCrews);
    const airaCrews = smarthr.filterByDepartment(activeCrews, '姶良');

    for (const crew of airaCrews) {
      const entry = smarthr.toStaffMasterEntry(crew);
      if (entry.staffName && entry.qualifications.length > 0) {
        staffQualifications.set(entry.staffName, entry.qualifications);
      }
    }

    logger.info(`スタッフ資格マップ: ${staffQualifications.size}名分構築完了`);
    for (const [name, quals] of staffQualifications) {
      logger.debug(`  ${name}: [${quals.join(', ')}]`);
    }
  } else {
    logger.warn('SMARTHR_ACCESS_TOKEN 未設定: スタッフ資格チェックはスキップされます');
  }

  // 環境変数チェック
  const kanamickUrl = process.env.KANAMICK_URL;
  const kanamickUser = process.env.KANAMICK_USERNAME;
  const kanamickPass = process.env.KANAMICK_PASSWORD;
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
  const sheets = new SpreadsheetService(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json'
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

    // ワークフロー作成 + マスタ設定
    const workflow = new TranscriptionWorkflow(browser, selectorEngine, sheets, auth);
    workflow.setPatientMaster(patientMaster);
    workflow.setStaffQualifications(staffQualifications);

    // コンテキスト作成
    const context: WorkflowContext = {
      workflowName: 'transcription',
      startedAt: new Date(),
      dryRun,
      locations: [{ name: '姶良', sheetId: AIRA_SHEET_ID }],
    };

    // 転記実行
    const startTime = Date.now();
    const results = await workflow.run(context);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // 結果レポート
    const totalProcessed = results.reduce((sum, r) => sum + r.processedRecords, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errorRecords, 0);
    const totalRecords = results.reduce((sum, r) => sum + r.totalRecords, 0);

    logger.info('========================================');
    logger.info('  転記結果');
    logger.info(`  対象レコード: ${totalRecords}`);
    logger.info(`  処理完了: ${totalProcessed}`);
    logger.info(`  エラー: ${totalErrors}`);
    logger.info(`  所要時間: ${elapsed}秒`);
    logger.info('========================================');

    // エラー詳細
    for (const r of results) {
      if (r.errors.length > 0) {
        logger.info(`--- ${r.locationName} エラー詳細 ---`);
        for (const e of r.errors) {
          logger.info(`  ${e.recordId}: [${e.category}] ${e.message}`);
        }
      }
    }

    // メール通知
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

    const notificationService = new NotificationService(notificationConfig);
    if (notificationService.isEnabled() && results.length > 0) {
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
      logger.info('メール通知送信完了');
    }

    if (totalErrors > 0) {
      process.exit(1);
    }
  } catch (error) {
    logger.error(`転記異常終了: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  logger.error(`致命的エラー: ${(error as Error).message}`);
  process.exit(1);
});
