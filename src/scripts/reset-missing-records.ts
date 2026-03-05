/**
 * B2: 漏登録12件の転記フラグリセットスクリプト
 *
 * 12件の漏登録レコードを患者名+訪問日+開始時間で特定し、
 * T列（転記フラグ）を空白にリセットして転記ワークフローが再処理できるようにする。
 *
 * 実行: npx tsx src/scripts/reset-missing-records.ts [--dry-run]
 */
import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

// C1 挿入後の列インデックス（0-based）
const COL_A = 0;  // 記録ID
const COL_E = 4;  // スタッフ名
const COL_G = 6;  // 患者名
const COL_H = 7;  // 訪問日
const COL_I = 8;  // 開始時間
const COL_T = 19; // 転記フラグ（C1 挿入後）
const COL_V = 21; // エラー詳細（C1 挿入後）

// 漏登録12件のターゲット（患者名 + 訪問日 + 開始時間）
// 訪問日は YYYY/MM/DD または YYYY-MM-DD 形式でシートに格納されている可能性あり
const TARGETS = [
  { patientName: '窪田正浩',    visitDate: '2026/02/01', startTime: '09:00', staff: '荒垣久美子' },
  { patientName: '西之園喜美子', visitDate: '2026/02/02', startTime: '12:20', staff: '乾真子' },
  { patientName: '谷本久子',    visitDate: '2026/02/02', startTime: '11:00', staff: '永森健大' },
  { patientName: '横山宜子',    visitDate: '2026/02/02', startTime: '14:20', staff: '川原珠萌' },
  { patientName: '上枝眞由美',  visitDate: '2026/02/02', startTime: '16:00', staff: '乾真子' },
  { patientName: '八汐征男',    visitDate: '2026/02/03', startTime: '10:00', staff: '阪本大樹' },
  { patientName: '鎌田良弘',    visitDate: '2026/02/03', startTime: '12:40', staff: '阪本大樹' },
  { patientName: '小濱泉',      visitDate: '2026/02/03', startTime: '15:00', staff: '阪本大樹' },
  { patientName: '宇都ノブ子',  visitDate: '2026/02/04', startTime: '15:00', staff: '大迫晋也' },
  { patientName: '窪田正浩',    visitDate: '2026/02/06', startTime: '07:30', staff: '川口千尋' },
  { patientName: '藤﨑公強',    visitDate: '2026/02/06', startTime: '11:00', staff: '永森健大' },
  { patientName: '窪田正浩',    visitDate: '2026/02/08', startTime: '06:20', staff: '川口千尋' },
];

function normalizeDate(d: string): string {
  // Normalize to YYYY/MM/DD
  return d.replace(/-/g, '/');
}

function normalizeTime(t: string): string {
  // Normalize to HH:MM (strip seconds if present)
  return t.slice(0, 5);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('=== DRY RUN モード ===');

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 全行取得（A〜Z列）
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A2:Z`,
  });
  const rows = response.data.values || [];

  console.log(`\nシート行数: ${rows.length}`);
  console.log(`ターゲット: ${TARGETS.length}件\n`);

  const found: Array<{
    target: typeof TARGETS[0];
    rowNum: number;
    recordId: string;
    transcriptionFlag: string;
  }> = [];

  for (const target of TARGETS) {
    const normalizedDate = normalizeDate(target.visitDate);
    const normalizedTime = normalizeTime(target.startTime);

    const matches = rows
      .map((row, index) => ({ row, rowNum: index + 2 }))
      .filter(({ row }) => {
        const patientName = (row[COL_G] || '').trim();
        const visitDate = normalizeDate((row[COL_H] || '').trim());
        const startTime = normalizeTime((row[COL_I] || '').trim());
        return patientName === target.patientName &&
               visitDate === normalizedDate &&
               startTime === normalizedTime;
      });

    if (matches.length === 0) {
      console.log(`❌ NOT FOUND: ${target.patientName} ${target.visitDate} ${target.startTime} (${target.staff})`);
    } else if (matches.length > 1) {
      console.log(`⚠️  MULTIPLE (${matches.length}): ${target.patientName} ${target.visitDate} ${target.startTime}`);
      for (const m of matches) {
        const flag = (m.row[COL_T] || '').trim();
        const staff = (m.row[COL_E] || '').trim();
        console.log(`   row ${m.rowNum}: recordId=${m.row[COL_A]}, flag="${flag}", staff="${staff}"`);
      }
    } else {
      const { row, rowNum } = matches[0];
      const recordId = (row[COL_A] || '').trim();
      const transcriptionFlag = (row[COL_T] || '').trim();
      const staffInSheet = (row[COL_E] || '').trim();
      console.log(`✅ FOUND: ${target.patientName} ${target.visitDate} ${target.startTime} → row ${rowNum}, id=${recordId}, flag="${transcriptionFlag}", staff="${staffInSheet}"`);
      found.push({ target, rowNum, recordId, transcriptionFlag });
    }
  }

  console.log(`\n--- 結果 ---`);
  console.log(`見つかった: ${found.length}/${TARGETS.length}件`);

  const needsReset = found.filter(f => f.transcriptionFlag !== '');
  const alreadyPending = found.filter(f => f.transcriptionFlag === '');
  console.log(`転記フラグリセット必要: ${needsReset.length}件`);
  console.log(`既に空白（リセット不要）: ${alreadyPending.length}件`);

  if (needsReset.length > 0) {
    console.log('\nリセット対象:');
    for (const f of needsReset) {
      console.log(`  row ${f.rowNum}: ${f.target.patientName} ${f.target.visitDate} ${f.target.startTime} (flag="${f.transcriptionFlag}")`);
    }
  }

  if (dryRun) {
    console.log('\n[DRY RUN] 実際の更新はスキップ');
    return;
  }

  if (needsReset.length === 0) {
    console.log('\n全件既に空白 — リセット不要');
    return;
  }

  console.log('\n転記フラグをリセット中...');
  for (const f of needsReset) {
    // T列（転記フラグ）をクリア
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!T${f.rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['']] },
    });
    // V列（エラー詳細）もクリア
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!V${f.rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['']] },
    });
    console.log(`  ✅ row ${f.rowNum} (${f.target.patientName} ${f.target.visitDate} ${f.target.startTime}): T列・V列 → 空白`);
  }

  console.log('\n完了');
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
