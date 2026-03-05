/**
 * 転記実行スクリプト
 *
 * 姶良事業所の Google Sheets データを HAM に転記する。
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
import { StaffSyncService } from '../workflows/staff-sync/staff-sync.workflow';
import { NotificationService } from '../services/notification.service';
import type { WorkflowContext } from '../types/workflow.types';
import type { NotificationConfig, DailyReport } from '../types/notification.types';
import type { WorkflowResult } from '../types/workflow.types';

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
      locationName: '姶良',
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

/** 姶良事業所 Sheet ID */
const AIRA_SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';

/** デフォルト CSV ファイルパス（現在の年月で自動生成） */
const DEFAULT_CSV = `./4664590280_userallfull_${PatientCsvDownloaderService.getCurrentMonth()}.csv`;

async function main(): Promise<void> {
  // コマンドライン引数
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const explicitCsv = args.find(a => a.startsWith('--csv='))?.split('=')[1];
  const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? parseInt(limitArg, 10) : 0;
  const tabArg = args.find(a => a.startsWith('--tab='))?.split('=')[1] || undefined;
  const csvMode = explicitCsv ? 'local' : 'auto';

  logger.info('========================================');
  logger.info('  転記実行');
  logger.info(`  事業所: 姶良`);
  logger.info(`  Sheet ID: ${AIRA_SHEET_ID}`);
  logger.info(`  CSV モード: ${csvMode === 'local' ? `ローカル (${explicitCsv})` : 'HAM 自動ダウンロード'}`);
  logger.info(`  ドライラン: ${dryRun}`);
  if (tabArg) logger.info(`  対象タブ: ${tabArg}`);
  if (limit > 0) logger.info(`  レコード上限: ${limit}`);
  logger.info('========================================');

  // === Step 0: 利用者マスタ CSV (ローカル指定時は先に読み込み) ===
  const patientMaster = new PatientMasterService();
  if (csvMode === 'local') {
    const resolvedCsvPath = path.resolve(explicitCsv!);
    await patientMaster.loadFromCsv(resolvedCsvPath);
    logger.info(`利用者マスタ: ${patientMaster.count}名読み込み完了（ローカル CSV）`);
  } else {
    // ローカルにデフォルト CSV がある場合はフォールバックとして先に読み込む
    const defaultCsvPath = path.resolve(DEFAULT_CSV);
    const fs = await import('fs');
    if (fs.existsSync(defaultCsvPath)) {
      await patientMaster.loadFromCsv(defaultCsvPath);
      logger.info(`利用者マスタ: ${patientMaster.count}名読み込み完了（デフォルト CSV フォールバック）`);
    }
    // HAM からの自動ダウンロードはブラウザ起動後に実行
  }

  // === Step 0.5: SmartHR からスタッフ資格マップ構築 ===
  // 注意: 部署フィルタは使わない。Sheet 内の全スタッフを emp_code で直接検索する。
  // SmartHR は資格情報の参照元であり、部署に関係なく全スタッフの資格が必要。
  const smarthrToken = process.env.SMARTHR_ACCESS_TOKEN;
  const staffQualifications = new Map<string, string[]>();
  let smarthr: SmartHRService | null = null;

  const sheets = new SpreadsheetService(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json'
  );

  if (smarthrToken) {
    smarthr = new SmartHRService({
      baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
      accessToken: smarthrToken,
    });

    // Sheet から全スタッフの従業員番号を取得（部署フィルタなし）
    const sheetRecords = await sheets.getTranscriptionRecords(AIRA_SHEET_ID, tabArg);
    const empCodes = [...new Set(sheetRecords.map(r => r.staffNumber).filter(Boolean))];
    logger.info(`Sheet 内ユニークスタッフ: ${empCodes.length}名 → SmartHR で資格検索`);

    // emp_code で直接 SmartHR 検索（部署フィルタなし）
    const crewMap = await smarthr.getCrewsByEmpCodes(empCodes);
    logger.info(`SmartHR 検索結果: ${crewMap.size}/${empCodes.length}名`);

    for (const [, crew] of crewMap) {
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
    logger.warn('SMARTHR_ACCESS_TOKEN 未設定: スタッフ資格チェック＋自動補登はスキップされます');
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

    // === CSV 自動取得 (ローカルキャッシュ優先、なければ HAM からダウンロード) ===
    if (csvMode === 'auto') {
      try {
        const csvDownloader = new PatientCsvDownloaderService(auth);
        const targetMonth = PatientCsvDownloaderService.getCurrentMonth();
        // ローカルにあればそのまま使う（HAM ログイン不要）
        const localCsv = csvDownloader.findLocalCsv(targetMonth);
        if (localCsv) {
          await patientMaster.loadFromCsv(localCsv);
          logger.info(`利用者マスタ: ${patientMaster.count}名読み込み完了（ローカルキャッシュ）`);
        } else {
          // ローカルにないので HAM からダウンロード
          await auth.login();
          const csvPath = await csvDownloader.downloadPatientCsv({ targetMonth });
          await patientMaster.loadFromCsv(csvPath);
          logger.info(`利用者マスタ: ${patientMaster.count}名読み込み完了（HAM ダウンロード）`);
        }
      } catch (csvError) {
        if (patientMaster.count === 0) {
          throw new Error(`利用者マスタ CSV の取得に失敗しました: ${(csvError as Error).message}`);
        }
        logger.warn(`CSV 自動ダウンロード失敗、デフォルト CSV で続行: ${(csvError as Error).message}`);
      }
    }

    // ワークフロー作成 + マスタ設定
    const workflow = new TranscriptionWorkflow(browser, selectorEngine, sheets, auth);
    workflow.setPatientMaster(patientMaster);
    workflow.setStaffQualifications(staffQualifications);

    // SmartHR 自動補登を有効化（部署を問わず Sheet スタッフを登録）
    if (smarthr) {
      const staffSync = new StaffSyncService(smarthr, auth);
      workflow.setStaffAutoRegister(smarthr, staffSync);
      logger.info('スタッフ自動補登: 有効（SmartHR 経由）');
    }

    // コンテキスト作成
    const context: WorkflowContext = {
      workflowName: 'transcription',
      startedAt: new Date(),
      dryRun,
      locations: [{ name: '姶良', sheetId: AIRA_SHEET_ID }],
      tab: tabArg,
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
    await sendNotification(results);

    if (totalErrors > 0) {
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
