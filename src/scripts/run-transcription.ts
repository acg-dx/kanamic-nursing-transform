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

async function main(): Promise<void> {
  // コマンドライン引数
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const explicitCsv = args.find(a => a.startsWith('--csv='))?.split('=')[1];
  const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? parseInt(limitArg, 10) : 0;
  const tabArg = args.find(a => a.startsWith('--tab='))?.split('=')[1] || undefined;
  const csvMode = explicitCsv ? 'local' : 'auto';
  const config = loadConfig();
  const locations = config.sheets.locations;

  if (locations.length === 0) {
    throw new Error('処理対象の事業所が設定されていません（config.sheets.locations）');
  }

  logger.info('========================================');
  logger.info('  転記実行');
  logger.info(`  対象事業所: ${locations.map(loc => loc.name).join(', ')}`);
  logger.info(`  事業所数: ${locations.length}`);
  logger.info(`  CSV モード: ${csvMode === 'local' ? `ローカル (${explicitCsv})` : 'HAM 自動ダウンロード'}`);
  logger.info(`  ドライラン: ${dryRun}`);
  if (tabArg) logger.info(`  対象タブ: ${tabArg}`);
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
      auth.setContext(browser.browserContext);

      // === Step 0.5: SmartHR からスタッフ資格マップ構築（事業所ごと） ===
      // 注意: 部署フィルタは使わない。Sheet 内の全スタッフを emp_code で直接検索する。
      // SmartHR は資格情報の参照元であり、部署に関係なく全スタッフの資格が必要。
      const staffQualifications = new Map<string, string[]>();
      if (smarthr) {
        const sheetRecords = await sheets.getTranscriptionRecords(loc.sheetId, tabArg);
        const empCodes = [...new Set(sheetRecords.map(r => r.staffNumber).filter(Boolean))];
        logger.info(`[${loc.name}] Sheet 内ユニークスタッフ: ${empCodes.length}名 → SmartHR で資格検索`);

        if (empCodes.length > 0) {
          const crewMap = await smarthr.getCrewsByEmpCodes(empCodes);
          logger.info(`[${loc.name}] SmartHR 検索結果: ${crewMap.size}/${empCodes.length}名`);

          for (const [, crew] of crewMap) {
            const entry = smarthr.toStaffMasterEntry(crew);
            if (entry.staffName && entry.qualifications.length > 0) {
              staffQualifications.set(entry.staffName, entry.qualifications);
            }
          }
        }

        logger.info(`[${loc.name}] スタッフ資格マップ: ${staffQualifications.size}名分構築完了`);
        for (const [name, quals] of staffQualifications) {
          logger.debug(`  ${name}: [${quals.join(', ')}]`);
        }
      }

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

      // === 前月未登録チェック → 未登録があれば前月を先に転記 ===
      if (!tabArg) {
        try {
          const reconciliation = new ReconciliationService(sheets);
          const prevResult = await reconciliation.checkPreviousMonthUnregistered(loc.sheetId);
          if (prevResult.hasPending) {
            const now = new Date();
            const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const prevTab = `${prev.getFullYear()}年${String(prev.getMonth() + 1).padStart(2, '0')}月`;
            logger.warn(`[${loc.name}] 前月(${prevTab})に未登録レコード ${prevResult.pendingCount} 件を検出 → 前月を先に転記します`);

            const prevWorkflow = new TranscriptionWorkflow(browser, selectorEngine, sheets, auth);
            prevWorkflow.setPatientMaster(patientMaster);
            prevWorkflow.setStaffQualifications(staffQualifications);
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

      // ワークフロー作成 + マスタ設定
      const workflow = new TranscriptionWorkflow(browser, selectorEngine, sheets, auth);
      workflow.setPatientMaster(patientMaster);
      workflow.setStaffQualifications(staffQualifications);

      // SmartHR 自動補登を有効化（部署を問わず Sheet スタッフを登録）
      if (smarthr) {
        const staffSync = new StaffSyncService(smarthr, auth, {
          cd: loc.tritrusOfficeCd,  // TRITRUS 事業所コード（Phase2 事業所設定で使用）
          name: loc.stationName,
        });
        workflow.setStaffAutoRegister(smarthr, staffSync);
        logger.info(`[${loc.name}] スタッフ自動補登: 有効（SmartHR 経由, 事業所=${loc.stationName}）`);
      }

      // コンテキスト作成
      const context: WorkflowContext = {
        workflowName: 'transcription',
        startedAt: new Date(),
        dryRun,
        locations: [loc],
        tab: tabArg,
      };

      // 転記実行
      const startTime = Date.now();
      const results = await workflow.run(context);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      allResults.push(...results);

      // 結果レポート（事業所単位）
      const totalProcessed = results.reduce((sum, r) => sum + r.processedRecords, 0);
      const totalErrors = results.reduce((sum, r) => sum + r.errorRecords, 0);
      const totalRecords = results.reduce((sum, r) => sum + r.totalRecords, 0);
      logger.info(`[${loc.name}] 転記結果: 対象=${totalRecords}, 完了=${totalProcessed}, エラー=${totalErrors}, 所要=${elapsed}秒`);

      // エラー詳細
      for (const r of results) {
        if (r.errors.length > 0) {
          logger.info(`--- ${r.locationName} エラー詳細 ---`);
          for (const e of r.errors) {
            logger.info(`  ${e.recordId}: [${e.category}] ${e.message}`);
          }
        }
      }

      // === 削除ワークフロー ===
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
