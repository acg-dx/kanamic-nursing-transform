/**
 * 诊断: 检查9条A类记录为什么只有8条被选为转记对象
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

const IDS = ['121032','121077','121245','121195','121477','121347','121711','121851','121945'];

// Column indices (0-based, post-C1)
const COL_A = 0;   // 記録ID
const COL_E = 4;   // スタッフ名
const COL_G = 6;   // 患者名
const COL_M = 12;  // 完了状態 (completionStatus)
const COL_N = 13;  // 同行チェック
const COL_O = 14;  // 緊急フラグ
const COL_P = 15;  // 同行事務員チェック
const COL_R = 17;  // 緊急時事務員チェック
const COL_T = 19;  // 転記フラグ
const COL_U = 20;  // マスタ修正フラグ
const COL_V = 21;  // エラー詳細
const COL_Z = 25;  // 実績ロック

function parseBoolean(val: string | undefined): boolean {
  return val === 'TRUE' || val === 'true' || val === '1' || val === 'はい';
}

function isTranscriptionTarget(row: string[]): { result: boolean; reason: string } {
  const recordLocked = parseBoolean(row[COL_Z]);
  if (recordLocked) return { result: false, reason: 'recordLocked=true' };

  const cs = (row[COL_M] || '').trim();
  if (cs === '' || cs === '1') return { result: false, reason: `completionStatus="${cs}" (要2/3/4)` };

  const accompany = (row[COL_N] || '').trim();
  const accompanyClerk = (row[COL_P] || '').trim();
  if (accompany.includes('重複') && !accompanyClerk) return { result: false, reason: '重複+事務員未設定' };

  const emergency = (row[COL_O] || '').trim();
  const emergencyClerk = (row[COL_R] || '').trim();
  if (emergency.includes('緊急支援あり') && !emergencyClerk) return { result: false, reason: '緊急+事務員未設定' };

  const flag = (row[COL_T] || '').trim();
  const masterCorr = parseBoolean(row[COL_U]);

  if (flag === '転記済み') return { result: false, reason: 'flag=転記済み' };
  if (flag === '') return { result: true, reason: 'flag=空 → 対象' };
  if (flag === 'エラー：システム') return { result: true, reason: 'flag=エラー：システム → 対象' };
  if (flag === 'エラー：マスタ不備' && masterCorr) return { result: true, reason: 'flag=マスタ不備+修正フラグ → 対象' };
  if (flag === '修正あり') return { result: true, reason: 'flag=修正あり → 対象' };
  return { result: false, reason: `flag="${flag}" (対象外)` };
}

async function main() {
  const auth = new google.auth.GoogleAuth({ keyFile: KEY_PATH, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A2:Z` });
  const rows = resp.data.values || [];

  console.log('=== 9条A类记录诊断 ===\n');
  let targetCount = 0;
  for (const id of IDS) {
    const idx = rows.findIndex(r => (r[0] || '').trim() === id);
    if (idx === -1) { console.log(`${id}: ❌ NOT FOUND`); continue; }
    const row = rows[idx];
    const check = isTranscriptionTarget(row);
    const patient = (row[COL_G] || '').trim();
    const staff = (row[COL_E] || '').trim();
    const flag = (row[COL_T] || '').trim();
    const cs = (row[COL_M] || '').trim();
    const marker = check.result ? '✅ 対象' : '❌ 除外';
    console.log(`${id} | ${patient} | ${staff} | cs="${cs}" flag="${flag}" | ${marker}: ${check.reason}`);
    if (check.result) targetCount++;
  }
  console.log(`\n対象: ${targetCount}/9件`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
