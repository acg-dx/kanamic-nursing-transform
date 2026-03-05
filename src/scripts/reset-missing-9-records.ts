/**
 * Step 3準備: A類9件の漏登録レコードの転記フラグリセット
 *
 * 9件中3件のフラグをリセットして、転記ワークフローが処理できるようにする:
 *   - 121032 (転記済み → 空白): HAMに実在しないため再転記が必要
 *   - 121077 (転記済み → 空白): HAMに実在しないため再転記が必要
 *   - 121851 (エラー：マスタ不備 → 空白): 片平和彦をスタッフ登録済みのため再試行可能
 *
 * 残り6件 (121245, 121195, 121477, 121347, 121711, 121945) は既に未転記なのでリセット不要。
 *
 * リセット後、run-transcription.ts を実行して9件を転記する:
 *   npx tsx src/scripts/run-transcription.ts --tab=2026年02月
 *
 * 実行:
 *   npx tsx src/scripts/reset-missing-9-records.ts --dry-run
 *   npx tsx src/scripts/reset-missing-9-records.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

const COL_A = 0;   // 記録ID
const COL_T = 19;  // 転記フラグ
const COL_V = 21;  // エラー詳細

// リセットが必要な記録ID (転記済み or エラー → 空白)
const RESET_IDS = ['121032', '121077', '121851'];

// 確認用: 全9件の記録ID（未転記であることを確認する）
const ALL_9_IDS = [
  '121032', '121077', '121245', '121195', '121477',
  '121347', '121711', '121851', '121945',
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('=== DRY RUN ===\n');

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A2:V`,
  });
  const rows = response.data.values || [];
  console.log(`シート行数: ${rows.length}\n`);

  // 全9件の現在状態を確認
  console.log('=== 全9件の現在状態 ===');
  for (const id of ALL_9_IDS) {
    const idx = rows.findIndex(r => (r[COL_A] || '').trim() === id);
    if (idx === -1) {
      console.log(`  ${id}: ❌ NOT FOUND`);
      continue;
    }
    const row = rows[idx];
    const flag = (row[COL_T] || '').trim();
    const error = (row[COL_V] || '').trim();
    const needsReset = RESET_IDS.includes(id);
    const marker = needsReset ? '→ RESET' : (flag === '' ? '✅ 既に未転記' : `⚠️ flag="${flag}"`);
    console.log(`  ${id} row${idx + 2}: flag="${flag}" ${error ? `error="${error}" ` : ''}${marker}`);
  }

  // リセット対象を検索
  console.log('\n=== リセット対象 ===');
  const toReset: Array<{ id: string; rowNum: number; currentFlag: string }> = [];
  for (const id of RESET_IDS) {
    const idx = rows.findIndex(r => (r[COL_A] || '').trim() === id);
    if (idx === -1) {
      console.log(`  ${id}: ❌ NOT FOUND — スキップ`);
      continue;
    }
    const flag = (rows[idx][COL_T] || '').trim();
    if (flag === '') {
      console.log(`  ${id} row${idx + 2}: 既に空白 — リセット不要`);
      continue;
    }
    console.log(`  ${id} row${idx + 2}: "${flag}" → ""`);
    toReset.push({ id, rowNum: idx + 2, currentFlag: flag });
  }

  if (toReset.length === 0) {
    console.log('\n全件リセット不要');
    return;
  }

  if (dryRun) {
    console.log(`\n[DRY RUN] ${toReset.length}件をリセット予定`);
    return;
  }

  console.log(`\n${toReset.length}件をリセット中...`);
  for (const item of toReset) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!T${item.rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['']] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${TAB}!V${item.rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['']] },
    });
    console.log(`  ✅ ${item.id} row${item.rowNum}: "${item.currentFlag}" → ""`);
  }

  console.log(`\n完了: ${toReset.length}件リセット`);
  console.log('\n次のステップ:');
  console.log('  npx tsx src/scripts/run-transcription.ts --tab=2026年02月');
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
