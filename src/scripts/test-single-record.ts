/**
 * 単一レコードテスト用スクリプト
 *
 * 指定レコードを「修正あり」に変更し、転記ワークフローを実行する。
 * 修正ありフラグにより、既存 HAM スケジュールの削除 → 再作成が行われる。
 *
 * 使用方法:
 *   npx tsx src/scripts/test-single-record.ts --record-id=122194
 */
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { logger } from '../core/logger';

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
import type { WorkflowContext } from '../types/workflow.types';

const AIRA_SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const DEFAULT_CSV = `./4664590280_userallfull_${PatientCsvDownloaderService.getCurrentMonth()}.csv`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const recordIdArg = args.find(a => a.startsWith('--record-id='))?.split('=')[1];
  const tabArg = args.find(a => a.startsWith('--tab='))?.split('=')[1] || undefined;

  if (!recordIdArg) {
    logger.error('使用方法: npx tsx src/scripts/test-single-record.ts --record-id=122194');
    process.exit(1);
  }

  logger.info(`========== 単一レコードテスト: ${recordIdArg} ==========`);

  const sheets = new SpreadsheetService(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json'
  );

  // === Step 1: レコード検索＋修正ありフラグ設定 ===
  const records = await sheets.getTranscriptionRecords(AIRA_SHEET_ID, tabArg);
  const target = records.find(r => r.recordId === recordIdArg);
  if (!target) {
    logger.error(`レコード ${recordIdArg} が見つかりません`);
    process.exit(1);
  }
  logger.info(`レコード検出: row=${target.rowIndex}, patient=${target.patientName}, ` +
    `time=${target.startTime}-${target.endTime}, status=${target.transcriptionFlag}`);

  if (target.transcriptionFlag !== '修正あり') {
    logger.info(`ステータスを「修正あり」に変更 → 既存スケジュール削除＋再作成を強制`);
    await sheets.updateTranscriptionStatus(AIRA_SHEET_ID, target.rowIndex, '修正あり', undefined, tabArg);
  }

  // === Step 2: SmartHR 資格マップ構築 ===
  const staffQualifications = new Map<string, string[]>();
  let smarthr: SmartHRService | null = null;
  const smarthrToken = process.env.SMARTHR_ACCESS_TOKEN;

  if (smarthrToken) {
    smarthr = new SmartHRService({
      baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
      accessToken: smarthrToken,
    });
    const empCodes = [target.staffNumber].filter(Boolean);
    const crewMap = await smarthr.getCrewsByEmpCodes(empCodes);
    for (const [, crew] of crewMap) {
      const entry = smarthr.toStaffMasterEntry(crew);
      if (entry.staffName && entry.qualifications.length > 0) {
        staffQualifications.set(entry.staffName, entry.qualifications);
      }
    }
    logger.info(`スタッフ資格: ${staffQualifications.size}名分`);
  }

  // === Step 3: 利用者マスタ CSV ===
  const patientMaster = new PatientMasterService();
  const defaultCsvPath = path.resolve(DEFAULT_CSV);
  const fs = await import('fs');
  if (fs.existsSync(defaultCsvPath)) {
    await patientMaster.loadFromCsv(defaultCsvPath);
    logger.info(`利用者マスタ: ${patientMaster.count}名`);
  }

  // === Step 4: ブラウザ起動＋転記実行 ===
  const kanamickUrl = process.env.KANAMICK_URL;
  const kanamickUser = process.env.KANAMICK_USERNAME;
  const kanamickPass = process.env.KANAMICK_PASSWORD;
  if (!kanamickUrl || !kanamickUser || !kanamickPass) {
    logger.error('KANAMICK_URL, KANAMICK_USERNAME, KANAMICK_PASSWORD が必要です');
    process.exit(1);
  }

  const aiHealing = new AIHealingService(process.env.OPENAI_API_KEY || '', 'gpt-4o');
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
    await browser.launch();
    auth.setContext(browser.browserContext);

    // CSV 自動取得
    if (patientMaster.count === 0) {
      try {
        const csvDownloader = new PatientCsvDownloaderService(auth);
        const targetMonth = PatientCsvDownloaderService.getCurrentMonth();
        const localCsv = csvDownloader.findLocalCsv(targetMonth);
        if (localCsv) {
          await patientMaster.loadFromCsv(localCsv);
        } else {
          await auth.login();
          const csvPath = await csvDownloader.downloadPatientCsv({ targetMonth });
          await patientMaster.loadFromCsv(csvPath);
        }
        logger.info(`利用者マスタ: ${patientMaster.count}名（CSV）`);
      } catch (e) {
        logger.warn(`CSV 取得失敗: ${(e as Error).message}`);
      }
    }

    const workflow = new TranscriptionWorkflow(browser, selectorEngine, sheets, auth);
    workflow.setPatientMaster(patientMaster);
    workflow.setStaffQualifications(staffQualifications);
    if (smarthr) {
      const staffSync = new StaffSyncService(smarthr, auth);
      workflow.setStaffAutoRegister(smarthr, staffSync);
    }

    const context: WorkflowContext = {
      workflowName: 'transcription',
      startedAt: new Date(),
      dryRun: false,
      locations: [{ name: '姶良', sheetId: AIRA_SHEET_ID, stationName: '訪問看護ステーションあおぞら姶良', hamOfficeCode: '400021814' }],
      tab: tabArg,
      targetRecordIds: [recordIdArg],
    };

    const startTime = Date.now();
    const results = await workflow.run(context);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    const totalProcessed = results.reduce((sum, r) => sum + r.processedRecords, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errorRecords, 0);

    logger.info('========================================');
    logger.info(`  テスト結果: record=${recordIdArg}`);
    logger.info(`  処理完了: ${totalProcessed}, エラー: ${totalErrors}`);
    logger.info(`  所要時間: ${elapsed}秒`);
    logger.info('========================================');

    for (const r of results) {
      for (const e of r.errors) {
        logger.error(`  ${e.recordId}: [${e.category}] ${e.message}`);
      }
    }

    if (totalErrors > 0) process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  logger.error(`致命的エラー: ${(error as Error).message}`);
  process.exit(1);
});
