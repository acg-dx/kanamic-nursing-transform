/**
 * Step 1: Sheet状態修復スクリプト
 *
 * B類 8件: エラー状態 → 転記済み（HAMに既に存在するため）
 * E類 11件: 未転記 → 転記済み（HAMに既に存在するため）
 *
 * 対象合計: 19件
 * 操作: T列(転記フラグ) → "転記済み", V列(エラー詳細) → 空白
 *
 * 実行: npx tsx src/scripts/fix-transcription-flags.ts [--dry-run]
 */
import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

// C1 挿入後の列インデックス（0-based）
const COL_A = 0;   // 記録ID
const COL_T = 19;  // 転記フラグ
const COL_V = 21;  // エラー詳細

// B類: エラー状態だがHAMに存在する → 転記済みに修正
const B_RECORD_IDS = [
  '121091', // 田中穂純 02-02 17:00 冨迫広美
  '121081', // 八木陽子 02-02 12:00 冨迫広美
  '121065', // 西之園喜美子 02-02 12:20 乾真子
  '121068', // 谷本久子 02-02 11:00 永森健大
  '121129', // 宇都ノブ子 02-04 15:00 大迫晋也
  '121177', // 小濵士郎 02-05 16:00 永松アケミ
  '121176', // 川涯利雄 02-05 17:00 永松アケミ
  '121188', // 瀧下絹子 02-06 10:00 永松アケミ
];

// E類: 未転記だがHAMに存在する → 転記済みに修正
const E_RECORD_IDS = [
  '121209', // 東祐一郎 02-06 15:00 冨迫広美
  '121203', // 有田勉 02-06 18:00 冨迫広美
  '121205', // 小濵士郎 02-06 10:00 冨迫広美
  '121207', // 小濵士郎 02-06 14:00 冨迫広美
  '121211', // 川涯利雄 02-06 17:00 冨迫広美
  '121190', // 八木陽子 02-06 11:00 冨迫広美
  '121213', // 佐藤義久 02-06 13:30 永松アケミ
  '121185', // 平原幸一 02-06 09:00 永松アケミ
  '121210', // 溝口己喜男 02-06 16:00 冨迫広美
  '121231', // 井之上昇 02-06 16:30 永松アケミ
  '121476', // 有田勉 02-08 16:00 川口千尋
];

const ALL_RECORD_IDS = new Set([...B_RECORD_IDS, ...E_RECORD_IDS]);

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('=== DRY RUN モード ===\n');

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 全行取得
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A2:V`,
  });
  const rows = response.data.values || [];
  console.log(`シート行数: ${rows.length}`);
  console.log(`対象記録ID: ${ALL_RECORD_IDS.size}件 (B類${B_RECORD_IDS.length} + E類${E_RECORD_IDS.length})\n`);

  // 記録IDで行を検索
  const found: Array<{
    recordId: string;
    rowNum: number;
    category: 'B' | 'E';
    currentFlag: string;
    currentError: string;
  }> = [];

  const notFound: string[] = [];

  for (const targetId of ALL_RECORD_IDS) {
    const match = rows.findIndex((row) => (row[COL_A] || '').trim() === targetId);
    if (match === -1) {
      notFound.push(targetId);
      continue;
    }
    const row = rows[match];
    const rowNum = match + 2; // 1-indexed, header is row 1
    const currentFlag = (row[COL_T] || '').trim();
    const currentError = (row[COL_V] || '').trim();
    const category = B_RECORD_IDS.includes(targetId) ? 'B' : 'E';

    found.push({ recordId: targetId, rowNum, category, currentFlag, currentError });
  }

  // レポート
  console.log('--- B類 (エラー → 転記済み) ---');
  const bFound = found.filter(f => f.category === 'B');
  for (const f of bFound) {
    console.log(`  ${f.recordId} row${f.rowNum}: flag="${f.currentFlag}" error="${f.currentError}"`);
  }
  console.log(`  見つかった: ${bFound.length}/${B_RECORD_IDS.length}\n`);

  console.log('--- E類 (未転記 → 転記済み) ---');
  const eFound = found.filter(f => f.category === 'E');
  for (const f of eFound) {
    console.log(`  ${f.recordId} row${f.rowNum}: flag="${f.currentFlag}"`);
  }
  console.log(`  見つかった: ${eFound.length}/${E_RECORD_IDS.length}\n`);

  if (notFound.length > 0) {
    console.log(`❌ 見つからなかった: ${notFound.join(', ')}\n`);
  }

  // 既に転記済みのものをスキップ
  const needsUpdate = found.filter(f => f.currentFlag !== '転記済み');
  const alreadyDone = found.filter(f => f.currentFlag === '転記済み');

  console.log(`更新必要: ${needsUpdate.length}件`);
  console.log(`既に転記済み: ${alreadyDone.length}件\n`);

  if (needsUpdate.length === 0) {
    console.log('全件既に転記済み — 更新不要');
    return;
  }

  if (dryRun) {
    console.log('[DRY RUN] 以下を更新予定:');
    for (const f of needsUpdate) {
      console.log(`  ${f.recordId} row${f.rowNum} [${f.category}]: "${f.currentFlag}" → "転記済み"`);
    }
    return;
  }

  // 実行
  console.log('更新中...');
  let successCount = 0;
  for (const f of needsUpdate) {
    try {
      // T列 → 転記済み
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${TAB}!T${f.rowNum}`,
        valueInputOption: 'RAW',
        requestBody: { values: [['転記済み']] },
      });
      // V列 → 空白（エラー詳細クリア）
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${TAB}!V${f.rowNum}`,
        valueInputOption: 'RAW',
        requestBody: { values: [['']] },
      });
      console.log(`  ✅ ${f.recordId} row${f.rowNum} [${f.category}]: "${f.currentFlag}" → "転記済み"`);
      successCount++;
    } catch (err) {
      console.error(`  ❌ ${f.recordId} row${f.rowNum}: ${(err as Error).message}`);
    }
  }

  console.log(`\n完了: ${successCount}/${needsUpdate.length}件 更新成功`);
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
