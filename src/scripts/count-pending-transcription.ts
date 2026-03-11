/**
 * Google Sheets から転記対象（待登录）件数を取得
 * SmartHR 不要。Sheets API のみ。
 *
 * Usage: npx tsx src/scripts/count-pending-transcription.ts --month=202602
 */
import dotenv from 'dotenv';
dotenv.config();

import { SpreadsheetService } from '../services/spreadsheet.service';
import type { TranscriptionRecord } from '../types/spreadsheet.types';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';

function isPending(r: TranscriptionRecord): boolean {
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

async function main() {
  const monthArg = process.argv.find(a => a.startsWith('--month='))?.split('=')[1] || '202602';
  const tab = `${monthArg.slice(0, 4)}年${monthArg.slice(4, 6)}月`;

  const sheets = new SpreadsheetService(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json'
  );

  const records = await sheets.getTranscriptionRecords(SHEET_ID, tab);
  const pending = records.filter(isPending);
  const blankCount = records.filter(r => r.transcriptionFlag === '' && (r.completionStatus === '2' || r.completionStatus === '3' || r.completionStatus === '4')).length;

  // 诊断：解释 66 vs 227 的差异
  const transcribed = records.filter(r => r.transcriptionFlag === '転記済み').length;
  const cs234 = records.filter(r => r.completionStatus === '2' || r.completionStatus === '3' || r.completionStatus === '4');
  const cs234NotDone = cs234.filter(r => r.transcriptionFlag !== '転記済み');
  const cs1OrBlank = records.filter(r => r.completionStatus === '' || r.completionStatus === '1');
  const cs1OrBlankNotDone = cs1OrBlank.filter(r => r.transcriptionFlag !== '転記済み');

  console.log(`\n--- ${tab} 待登录统计 ---`);
  console.log(`总记录数: ${records.length} 件`);
  console.log(`転記済み: ${transcribed} 件`);
  console.log(`転記フラグ空白（且 completionStatus 2/3/4）: ${blankCount} 件`);
  console.log(`転記対象（待登录）: ${pending.length} 件`);
  console.log(`\n--- 诊断（66 vs 227 差异分析）---`);
  console.log(`completionStatus 2/3/4 且 非転記済み: ${cs234NotDone.length} 件`);
  console.log(`completionStatus 1 或 空白 且 非転記済み: ${cs1OrBlankNotDone.length} 件`);
  console.log(`总非転記済み（785 - 転記済み）: ${records.length - transcribed} 件`);
}

main().catch(e => {
  console.error((e as Error).message);
  process.exit(1);
});
