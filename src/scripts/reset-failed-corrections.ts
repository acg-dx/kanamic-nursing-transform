/**
 * 失敗した修正レコードのフラグをリセット
 *
 * selectServiceCode の exact match が textRequire を無視するバグにより、
 * 修正あり → 転記したが誤った結果になったレコードを再度「修正あり」に戻す。
 * 漏登録レコード（121911）は空白にリセット。
 *
 * Usage: npx tsx src/scripts/reset-failed-corrections.ts [--dry-run]
 */
import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';
const DRY_RUN = process.argv.includes('--dry-run');

// 前田清子 (row 98) は正常 → 除外
// 121911 (row 750) は漏登録 → 空白にリセット
const RECORDS_TO_RESET = [
  { row: 16,  recordId: '121034', name: '榮博造',     target: '修正あり' },
  { row: 80,  recordId: '121109', name: '福谷昭治',   target: '修正あり' },
  { row: 88,  recordId: '121144', name: '八汐征男',   target: '修正あり' },
  // row 98 (121125 前田清子) — SKIP (正常)
  { row: 111, recordId: '121137', name: '新福廣實',   target: '修正あり' },
  { row: 146, recordId: '121214', name: '八汐征男',   target: '修正あり' },
  { row: 175, recordId: '121212', name: '福谷昭治',   target: '修正あり' },
  { row: 196, recordId: '121223', name: '川畑シゲ子', target: '修正あり' },
  { row: 221, recordId: '121301', name: '八汐征男',   target: '修正あり' },
  { row: 286, recordId: '121368', name: '八汐征男',   target: '修正あり' },
  { row: 341, recordId: '121403', name: '福谷昭治',   target: '修正あり' },
  { row: 346, recordId: '121443', name: '八汐征男',   target: '修正あり' },
  { row: 417, recordId: '121492', name: '川畑シゲ子', target: '修正あり' },
  { row: 492, recordId: '121603', name: '八汐征男',   target: '修正あり' },
  { row: 551, recordId: '121642', name: '福谷昭治',   target: '修正あり' },
  { row: 632, recordId: '121728', name: '川畑シゲ子', target: '修正あり' },
  { row: 750, recordId: '121911', name: '小濵士郎',   target: ''         },  // 漏登録 → 空白
];

async function main() {
  console.log(`=== 修正失敗レコードのリセット ===`);
  console.log(`モード: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);
  console.log(`対象: ${RECORDS_TO_RESET.length} 件 (前田清子を除く)\n`);

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Read current state
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A2:T`,
  });
  const rows = res.data.values || [];

  const batchData: Array<{ range: string; values: string[][] }> = [];
  const skipped: string[] = [];

  for (const rec of RECORDS_TO_RESET) {
    const rowIdx = rec.row - 2;
    const currentRow = rows[rowIdx];
    if (!currentRow) {
      skipped.push(`Row ${rec.row}: 行が見つかりません`);
      continue;
    }

    const actualId = (currentRow[0] || '').trim();
    if (actualId !== rec.recordId) {
      skipped.push(`Row ${rec.row}: ID不一致 (expected=${rec.recordId}, actual=${actualId})`);
      continue;
    }

    const currentFlag = (currentRow[19] || '').trim();
    console.log(`  Row ${rec.row} | ${rec.recordId} | ${rec.name} | current="${currentFlag}" → "${rec.target}"`);

    if (currentFlag === rec.target) {
      skipped.push(`Row ${rec.row}: 既に "${rec.target}"`);
      continue;
    }

    batchData.push({
      range: `'${TAB}'!T${rec.row}`,
      values: [[rec.target]],
    });
  }

  if (skipped.length > 0) {
    console.log(`\nスキップ: ${skipped.length} 件`);
    for (const s of skipped) console.log(`  ${s}`);
  }

  if (batchData.length === 0) {
    console.log('\n更新対象なし。');
    return;
  }

  console.log(`\n更新対象: ${batchData.length} 件`);

  if (DRY_RUN) {
    console.log('[DRY-RUN] 実行するには --dry-run を外してください。');
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: batchData,
    },
  });

  console.log(`\n✅ ${batchData.length} 件のフラグをリセットしました。`);
}

main().catch(e => { console.error(e); process.exit(1); });
