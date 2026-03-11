/**
 * 予実突合の修正実行スクリプト
 *
 * 1. 先に Google Sheets へ書き込み（削除Sheet追加 + 転記フラグリセット）
 * 2. その後 削除 → 転記 を順次実行
 *
 * Usage:
 *   npx tsx src/scripts/run-reconciliation-fix.ts --csv=./schedule.csv --month=202602
 *   npx tsx src/scripts/run-reconciliation-fix.ts --csv=./schedule.csv --month=202602 --sheet-only  # Sheet 書き込みのみ
 *   npx tsx src/scripts/run-reconciliation-fix.ts --csv=./schedule.csv --month=202602 --dry-run
 *   npx tsx src/scripts/run-reconciliation-fix.ts --month=202602 --reset-master-error  # エラー：マスタ不備を空白にリセット＋待登录サマリー
 *   npx tsx src/scripts/run-reconciliation-fix.ts --month=202602 --count-pending  # 待登录件数のみ取得（変更なし）
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

dotenv.config();

import { logger } from '../core/logger';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { ReconciliationService } from '../services/reconciliation.service';
import { ScheduleCsvDownloaderService } from '../services/schedule-csv-downloader.service';
import { getQualificationMismatchesFromVerify } from './verify-service-content';
import type { ReconciliationResult, ReconciliationMismatch } from '../services/reconciliation.service';
import type { TranscriptionRecord } from '../types/spreadsheet.types';

const AIRA_SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';

function normalize(s: string): string {
  return (s || '').normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '').trim();
}

function normalizeDate(d: string): string {
  if (!d) return '';
  const c = d.trim().replace(/-/g, '/');
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(c)) return c;
  if (/^\d{8}$/.test(c)) return `${c.slice(0, 4)}/${c.slice(4, 6)}/${c.slice(6, 8)}`;
  return c;
}

function normalizeTime(t: string): string {
  if (!t) return '';
  const c = t.trim();
  if (/^\d{1,2}:\d{2}$/.test(c)) return c;
  if (/^\d{4}$/.test(c)) return `${c.slice(0, 2)}:${c.slice(2, 4)}`;
  return c;
}

/** 転記対象かどうか（transcription.workflow と同様の判定） */
function isTranscriptionTarget(r: TranscriptionRecord): boolean {
  if (r.recordLocked) return false;
  const cs = r.completionStatus;
  if (cs === '' || cs === '1') return false;
  if (r.accompanyCheck.includes('重複') && !r.accompanyClerkCheck.trim()) return false;
  if (r.emergencyFlag.includes('緊急支援あり') && !r.emergencyClerkCheck.trim()) return false;
  if (r.transcriptionFlag === '転記済み') return false;
  if (r.transcriptionFlag === '') return true;
  if (r.transcriptionFlag === 'エラー：システム') return true;
  if (r.transcriptionFlag === 'エラー：マスタ不備' && r.masterCorrectionFlag) return true;
  if (r.transcriptionFlag === '修正あり') return true;
  return false;
}

function matchRecord(
  sheet: TranscriptionRecord,
  patientName: string,
  visitDate: string,
  startTime: string,
  staffName?: string
): boolean {
  if (normalize(sheet.patientName) !== normalize(patientName)) return false;
  if (normalizeDate(sheet.visitDate) !== normalizeDate(visitDate)) return false;
  if (normalizeTime(sheet.startTime) !== normalizeTime(startTime)) return false;
  if (staffName && normalize(sheet.staffName) !== normalize(staffName)) return false;
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const csvArg = args.find(a => a.startsWith('--csv='))?.split('=')[1];
  const monthArg = args.find(a => a.startsWith('--month='))?.split('=')[1] || '202602';
  const dryRun = args.includes('--dry-run');
  const sheetOnly = args.includes('--sheet-only');
  const resetMasterErrorOnly = args.includes('--reset-master-error');
  const countPendingOnly = args.includes('--count-pending');

  const year = monthArg.substring(0, 4);
  const month = monthArg.substring(4, 6);
  const tab = `${year}年${month}月`;

  const sheets = new SpreadsheetService(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json'
  );

  // --count-pending のみ: 待登录件数を取得（変更なし）
  if (countPendingOnly) {
    logger.info('========================================');
    logger.info('  待登录件数取得');
    logger.info(`  対象: 姶良 ${tab}`);
    logger.info('========================================');
    const records = await sheets.getTranscriptionRecords(AIRA_SHEET_ID, tab);
    const pendingCount = records.filter(isTranscriptionTarget).length;
    logger.info('');
    logger.info(`タブ: ${tab}`);
    logger.info(`総レコード数: ${records.length} 件`);
    logger.info(`転記対象（待登录）: ${pendingCount} 件`);
    return;
  }

  // --reset-master-error のみ: エラー：マスタ不備を空白にリセット＋待登录サマリー
  if (resetMasterErrorOnly) {
    logger.info('========================================');
    logger.info('  エラー：マスタ不備 リセット＋待登录サマリー');
    logger.info(`  対象: 姶良 ${tab}`);
    logger.info('========================================');
    const allRecords = await sheets.getTranscriptionRecords(AIRA_SHEET_ID, tab);
    const toReset = allRecords.filter(r => r.transcriptionFlag === 'エラー：マスタ不備');
    if (toReset.length > 0) {
      for (const r of toReset) {
        await sheets.updateTranscriptionStatus(AIRA_SHEET_ID, r.rowIndex, '', undefined, tab);
      }
      logger.info(`エラー：マスタ不備 → 空白 リセット: ${toReset.length} 件`);
    }
    const after = await sheets.getTranscriptionRecords(AIRA_SHEET_ID, tab);
    const pendingCount = after.filter(isTranscriptionTarget).length;
    logger.info('');
    logger.info('--- 待登录サマリー ---');
    logger.info(`  タブ: ${tab}`);
    logger.info(`  総レコード数: ${after.length} 件`);
    logger.info(`  転記対象（待登录）: ${pendingCount} 件`);
    return;
  }

  let csvPath: string;
  if (csvArg) {
    csvPath = path.resolve(csvArg);
    if (!fs.existsSync(csvPath)) {
      logger.error(`CSV が見つかりません: ${csvPath}`);
      process.exit(1);
    }
  } else {
    const downloader = new ScheduleCsvDownloaderService(null as unknown as never);
    const local = downloader.findLocalCsv(monthArg);
    if (!local) {
      logger.error(`ローカルに ${monthArg} の CSV が見つかりません。--csv= で指定してください`);
      process.exit(1);
    }
    csvPath = local;
  }

  logger.info('========================================');
  logger.info('  予実突合 修正実行');
  logger.info(`  CSV: ${csvPath}`);
  logger.info(`  対象: 姶良 ${tab}`);
  if (dryRun) logger.info('  [DRY RUN] 実際の変更は行いません');
  logger.info('========================================');

  const reconciliation = new ReconciliationService(sheets);

  // Step 1: 突合実行
  const result = await reconciliation.reconcile(csvPath, AIRA_SHEET_ID, tab);

  // 資格不一致は verify-service-content（SmartHR 準拠）を優先
  const qualArg = args.find(a => a.startsWith('--qualifications='))?.split('=')[1];
  let qualificationMismatches = result.qualificationMismatches;
  if (process.env.SMARTHR_ACCESS_TOKEN || qualArg) {
    try {
      const verifyQuals = await getQualificationMismatchesFromVerify(csvPath, { qualPath: qualArg });
      qualificationMismatches = verifyQuals;
      logger.info(`資格不一致: verify-service-content 準拠（SmartHR）→ ${verifyQuals.length} 件`);
    } catch (e) {
      logger.warn(`verify-service-content 取得失敗、reconciliation 結果を使用: ${(e as Error).message}`);
    }
  }

  logger.info('');
  logger.info(`突合結果: extraInHam=${result.extraInHam.length}, missingFromHam=${result.missingFromHam.length}, qualMismatch=${qualificationMismatches.length}`);

  if (result.extraInHam.length === 0 && result.missingFromHam.length === 0 && qualificationMismatches.length === 0) {
    logger.info('差異なし。修正不要です。');
    return;
  }

  // Step 2: 削除Sheetに追加（extraInHam + qualificationMismatches）
  const toDelete: Array<{
    patientName: string;
    visitDate: string;
    startTime: string;
    endTime?: string;
    staffName?: string;
    serviceType1?: string;
    serviceType2?: string;
  }> = [];

  for (const m of result.extraInHam) {
    const [st, et] = (m.endTime || '').includes('-') ? m.endTime.split('-') : [m.startTime, m.endTime];
    toDelete.push({
      patientName: m.patientName,
      visitDate: m.visitDate.replace(/\//g, '-'),
      startTime: m.startTime,
      endTime: et || m.endTime,
      staffName: m.staffName || undefined,
      serviceType1: m.serviceType?.split('/')[0],
      serviceType2: m.serviceType?.split('/')[1],
    });
  }

  for (const q of qualificationMismatches) {
    const [st1, st2] = q.sheetsServiceType.split('/');
    toDelete.push({
      patientName: q.patientName,
      visitDate: q.visitDate.replace(/\//g, '-'),
      startTime: q.startTime,
      staffName: q.staffName,
      serviceType1: st1,
      serviceType2: st2,
    });
  }

  if (!dryRun && toDelete.length > 0) {
    await sheets.appendDeletionRecords(AIRA_SHEET_ID, toDelete);
    logger.info(`削除Sheetに ${toDelete.length} 件追加`);
  } else if (dryRun && toDelete.length > 0) {
    logger.info(`[DRY RUN] 削除Sheetに追加予定: ${toDelete.length} 件`);
  }

  // Step 3: 転記フラグリセット（missingFromHam + qualificationMismatches）
  const allRecords = await sheets.getTranscriptionRecords(AIRA_SHEET_ID, tab);
  const toReset: TranscriptionRecord[] = [];

  for (const m of result.missingFromHam) {
    const found = allRecords.find(r =>
      matchRecord(r, m.patientName, m.visitDate, m.startTime.split('-')[0] || m.startTime, m.staffName)
    );
    if (found && found.transcriptionFlag === '転記済み') {
      toReset.push(found);
    }
  }

  for (const q of qualificationMismatches) {
    const found = allRecords.find(r =>
      matchRecord(r, q.patientName, q.visitDate, q.startTime, q.staffName)
    );
    if (found && found.transcriptionFlag === '転記済み') {
      if (!toReset.some(r => r.rowIndex === found.rowIndex)) toReset.push(found);
    }
  }

  // エラー：マスタ不備 も空白にリセット（転記対象にする）
  for (const r of allRecords) {
    if (r.transcriptionFlag === 'エラー：マスタ不備' && !toReset.some(x => x.rowIndex === r.rowIndex)) {
      toReset.push(r);
    }
  }

  if (!dryRun && toReset.length > 0) {
    for (const r of toReset) {
      await sheets.updateTranscriptionStatus(AIRA_SHEET_ID, r.rowIndex, '', undefined, tab);
    }
    logger.info(`転記フラグリセット: ${toReset.length} 件`);
  } else if (dryRun && toReset.length > 0) {
    logger.info(`[DRY RUN] 転記フラグリセット予定: ${toReset.length} 件`);
  }

  // 待登录サマリー（リセット後は再取得してカウント）
  const recordsForCount = !dryRun && toReset.length > 0
    ? await sheets.getTranscriptionRecords(AIRA_SHEET_ID, tab)
    : allRecords;
  const pendingCount = recordsForCount.filter(isTranscriptionTarget).length;
  const totalInTab = recordsForCount.length;
  logger.info('');
  logger.info('--- 待登录サマリー ---');
  logger.info(`  タブ: ${tab}`);
  logger.info(`  総レコード数: ${totalInTab} 件`);
  logger.info(`  転記対象（待登录）: ${pendingCount} 件`);

  if (dryRun) {
    logger.info('');
    logger.info('--- DRY RUN 完了。実際の修正は行っていません。---');
    logger.info('本実行するには --dry-run を外してください。');
    return;
  }

  logger.info('');
  logger.info('========================================');
  logger.info('  Sheet 更新完了');
  logger.info('========================================');

  if (sheetOnly) {
    logger.info('--sheet-only のため、削除・転記は実行しません。');
    logger.info('手動実行: RUN_LOCATIONS=姶良 npm run dev -- --workflow=deletion');
    logger.info('手動実行: npm run dev -- --workflow=transcription --tab=' + tab);
    return;
  }

  if (toDelete.length > 0 || toReset.length > 0) {
    logger.info('');
    logger.info('--- 削除ワークフロー実行 ---');
    try {
      execSync('npx tsx src/index.ts --workflow=deletion', {
        stdio: 'inherit',
        env: { ...process.env, RUN_LOCATIONS: '姶良' },
      });
    } catch (e) {
      logger.error('削除ワークフロー異常終了');
      process.exit(1);
    }

    logger.info('');
    logger.info('--- 転記ワークフロー実行 ---');
    try {
      execSync('npx tsx src/index.ts --workflow=transcription --tab=' + tab, {
        stdio: 'inherit',
      });
    } catch (e) {
      logger.error('転記ワークフロー異常終了');
      process.exit(1);
    }

    logger.info('');
    logger.info('========================================');
    logger.info('  修正処理 完了');
    logger.info('========================================');
  }
}

main().catch(e => {
  logger.error((e as Error).message);
  process.exit(1);
});
