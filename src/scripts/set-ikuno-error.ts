/**
 * 生野由美子 5件のレコードをエラー状態に設定
 *
 * 5件とも HAM にスケジュールは存在するが、担当スタッフが他利用者と同時間帯に重複しているため
 * スタッフ配置が不可。手動配置が必要。
 *
 * 対象: 121479, 121487, 121567, 121711, 121786
 * T列(19) = "エラー"
 * V列(21) = "スタッフ配置不可：担当スタッフが同時間帯に他利用者の予定と重複しHAMで選択不可（手動配置が必要）"
 *
 * 実行:
 *   npx tsx src/scripts/set-ikuno-error.ts --dry-run
 *   npx tsx src/scripts/set-ikuno-error.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

// Column layout after C1 insertion:
// T(19) = 転記フラグ, V(21) = エラー詳細
const COL_T = 'T'; // 転記フラグ
const COL_V = 'V'; // エラー詳細

const TARGET_IDS = ['121479', '121487', '121567', '121711', '121786'];
const ERROR_STATUS = 'エラー';
const ERROR_DETAIL = 'スタッフ配置不可：担当スタッフが同時間帯に他利用者の予定と重複しHAMで選択不可（手動配置が必要）';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('=== DRY RUN ===\n');

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Read A:V columns to check current state
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A2:V`,
  });
  const rows = response.data.values || [];
  console.log(`シート行数: ${rows.length}\n`);

  // Check current status of all 5 records
  console.log('=== 対象5件の現在状態 ===');
  const toUpdate: Array<{ id: string; rowNum: number; currentFlag: string; currentError: string }> = [];

  for (const id of TARGET_IDS) {
    const idx = rows.findIndex(r => (r[0] || '').trim() === id);
    if (idx === -1) {
      console.log(`  ${id}: ❌ NOT FOUND`);
      continue;
    }
    const row = rows[idx];
    const rowNum = idx + 2;
    const currentFlag = (row[19] || '').trim(); // T列 (0-indexed 19)
    const currentError = (row[21] || '').trim(); // V列 (0-indexed 21)
    const patientName = (row[6] || '').trim(); // G列
    const staffName = (row[4] || '').trim(); // E列
    const visitDate = (row[7] || '').trim(); // H列

    const alreadySet = currentFlag === ERROR_STATUS && currentError === ERROR_DETAIL;
    const marker = alreadySet ? '✅ 既にエラー設定済み' : `→ UPDATE (現在: flag="${currentFlag}", error="${currentError}")`;
    console.log(`  ${id} row${rowNum}: ${patientName} (${staffName}) ${visitDate} ${marker}`);

    if (!alreadySet) {
      toUpdate.push({ id, rowNum, currentFlag, currentError });
    }
  }

  if (toUpdate.length === 0) {
    console.log('\n全件既にエラー状態。更新不要。');
    return;
  }

  console.log(`\n${toUpdate.length}件を更新${dryRun ? '予定' : '中'}...`);

  if (dryRun) {
    for (const item of toUpdate) {
      console.log(`  [DRY] ${item.id} row${item.rowNum}:`);
      console.log(`    ${COL_T}: "${item.currentFlag}" → "${ERROR_STATUS}"`);
      console.log(`    ${COL_V}: "${item.currentError}" → "${ERROR_DETAIL}"`);
    }
    console.log(`\n[DRY RUN] ${toUpdate.length}件を更新予定`);
    return;
  }

  for (const item of toUpdate) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!${COL_T}${item.rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[ERROR_STATUS]] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!${COL_V}${item.rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[ERROR_DETAIL]] },
    });
    console.log(`  ✅ ${item.id} row${item.rowNum}: flag="${ERROR_STATUS}", error="${ERROR_DETAIL}"`);
  }

  console.log(`\n完了: ${toUpdate.length}件更新`);
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
