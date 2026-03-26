/**
 * S列・U列クリアスクリプト
 *
 * 指定レコードIDの S列（転記フラグ）と U列（エラー詳細）を空白にリセットする。
 * 実行: npx tsx src/scripts/clear-status.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

// クリア対象のレコードID
const TARGET_IDS = ['121063', '121294', '121479', '121476'];

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 全行取得して対象レコードIDの行番号を特定
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A2:A`,
  });
  const rows = response.data.values || [];

  const updates: Array<{ range: string; values: string[][] }> = [];

  for (const [index, row] of rows.entries()) {
    const recordId = (row[0] || '').trim();
    if (TARGET_IDS.includes(recordId)) {
      const rowNum = index + 2; // 1-indexed, header is row 1
      updates.push(
        { range: `${TAB}!S${rowNum}`, values: [['']] },
        { range: `${TAB}!U${rowNum}`, values: [['']] },
      );
      console.log(`🔍 ${recordId} → row ${rowNum}`);
    }
  }

  if (updates.length === 0) {
    console.log('対象レコードが見つかりませんでした');
    return;
  }

  for (const u of updates) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: u.range,
      valueInputOption: 'RAW',
      requestBody: { values: u.values },
    });
    console.log(`✅ ${u.range} → 空白`);
  }

  console.log('完了');
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
