/**
 * B2: 12件の漏登録レコードの転記フラグ確認スクリプト
 */
import dotenv from 'dotenv';
dotenv.config();
import { google } from 'googleapis';
import fs from 'fs';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

// 12件の漏登録対象（患者名、日付、開始時刻）
const TARGETS = [
  { patientName: '窪田正浩', date: '2026/02/01', startTime: '09:00', staffName: '荒垣久美子' },
  { patientName: '西之園喜美子', date: '2026/02/02', startTime: '12:20', staffName: '乾真子' },
  { patientName: '谷本久子', date: '2026/02/02', startTime: '11:00', staffName: '永森健大' },
  { patientName: '横山宜子', date: '2026/02/02', startTime: '14:20', staffName: '川原珠萌' },
  { patientName: '上枝眞由美', date: '2026/02/02', startTime: '16:00', staffName: '乾真子' },
  { patientName: '八汐征男', date: '2026/02/03', startTime: '10:00', staffName: '阪本大樹' },
  { patientName: '鎌田良弘', date: '2026/02/03', startTime: '12:40', staffName: '阪本大樹' },
  { patientName: '小濱泉', date: '2026/02/03', startTime: '15:00', staffName: '阪本大樹' },
  { patientName: '宇都ノブ子', date: '2026/02/04', startTime: '15:00', staffName: '大迫晋也' },
  { patientName: '窪田正浩', date: '2026/02/06', startTime: '07:30', staffName: '川口千尋' },
  { patientName: '藤﨑公強', date: '2026/02/06', startTime: '11:00', staffName: '永森健大' },
  { patientName: '窪田正浩', date: '2026/02/08', startTime: '06:20', staffName: '川口千尋' },
];

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // A列からZ列まで全データ取得
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A1:Z`,
  });
  const rows = response.data.values || [];
  
  // ヘッダー行を確認
  const header = rows[0] || [];
  console.log('Header (A-Z):', header.slice(0, 26).join(' | '));
  
  // 正しい列マッピング
  const COL_RECORD_ID = 0;   // A
  const COL_VISIT_DATE = 7;  // H (日付)
  const COL_START_TIME = 8;  // I (開始時刻)
  const COL_PATIENT = 6;     // G (利用者=患者名)
  const COL_STAFF = 4;       // E (記録者=スタッフ名)
  const COL_TRANSCRIPTION_FLAG = 19; // T (転記フラグ)
  
  const lines: string[] = [
    `=== B2: 12件漏登録 転記フラグ確認 ===`,
    `Date: ${new Date().toISOString()}`,
    `Tab: ${TAB}`,
    `Total rows: ${rows.length - 1}`,
    '',
  ];
  
  let pendingCount = 0;
  let doneCount = 0;
  
  for (const target of TARGETS) {
    // 日付・時刻・患者名でマッチング
    const found = rows.slice(1).find(row => {
      const visitDate = (row[COL_VISIT_DATE] || '').trim();
      const startTime = (row[COL_START_TIME] || '').trim();
      const patientName = (row[COL_PATIENT] || '').trim();
      
      // 日付フォーマット正規化: 2026-02-01 → 2026/02/01
      const normalizedDate = visitDate.replace(/-/g, '/');
      const dateMatch = normalizedDate === target.date;
      const timeMatch = startTime === target.startTime;
      const patientMatch = patientName.includes(target.patientName) || target.patientName.includes(patientName);
      
      return dateMatch && timeMatch && patientMatch;
    });
    
    if (found) {
      const recordId = found[COL_RECORD_ID] || '';
      const transcriptionFlag = found[COL_TRANSCRIPTION_FLAG] || '';
      const staffName = found[COL_STAFF] || '';
      const status = transcriptionFlag === '' ? 'PENDING' : `DONE(${transcriptionFlag})`;
      
      if (transcriptionFlag === '') pendingCount++;
      else doneCount++;
      
      const line = `${status}: ${target.patientName} ${target.date} ${target.startTime} (${staffName}) [recordId=${recordId}]`;
      console.log(line);
      lines.push(line);
    } else {
      const line = `NOT_FOUND: ${target.patientName} ${target.date} ${target.startTime}`;
      console.log(line);
      lines.push(line);
    }
  }
  
  lines.push('');
  lines.push(`Summary: PENDING=${pendingCount}, DONE=${doneCount}`);
  console.log(`\nSummary: PENDING=${pendingCount}, DONE=${doneCount}`);
  
  fs.writeFileSync('.sisyphus/evidence/B2-check.txt', lines.join('\n'));
  console.log('\n証拠ファイル保存: .sisyphus/evidence/B2-check.txt');
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
