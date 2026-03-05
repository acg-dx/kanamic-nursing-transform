/**
 * C1: 加算対象の理由 列挿入スクリプト
 *
 * 全月次タブ（\d{4}年\d{2}月）に列を挿入し、ヘッダーを設定する。
 * 冪等性あり: ヘッダーが既に存在する場合はスキップ。
 *
 * 使用方法:
 *   npx tsx src/scripts/update-sheet-columns.ts
 *   npx tsx src/scripts/update-sheet-columns.ts --dry-run
 */

import { google, sheets_v4 } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M'; // 姶良
const INSERT_COL_INDEX = 18; // S列(18) に挿入（R=緊急時事務員チェック の後）
const NEW_HEADER = '加算対象の理由';
const MONTH_TAB_PATTERN = /^\d{4}年\d{2}月$/;

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH!,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 全シートのタブ一覧を取得
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.properties',
  });

  const allSheets = spreadsheet.data.sheets || [];
  const monthTabs = allSheets.filter(s =>
    s.properties?.title && MONTH_TAB_PATTERN.test(s.properties.title)
  );

  console.log(`対象タブ: ${monthTabs.map(s => s.properties?.title).join(', ')}`);

  for (const sheet of monthTabs) {
    const tabName = sheet.properties!.title!;
    const sheetId = sheet.properties!.sheetId!;

    // ヘッダー行を確認（冪等性チェック）
    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tabName}'!S1`,
    });
    const currentHeader = headerRes.data.values?.[0]?.[0] || '';

    if (currentHeader === NEW_HEADER) {
      console.log(`[SKIP] ${tabName}: ヘッダー "${NEW_HEADER}" は既に存在します`);
      continue;
    }

    console.log(`[${dryRun ? 'DRY-RUN' : 'EXECUTE'}] ${tabName}: S列に "${NEW_HEADER}" を挿入 (現在のS列: "${currentHeader}")`);

    if (dryRun) continue;

    // 列を挿入
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          insertDimension: {
            range: {
              sheetId,
              dimension: 'COLUMNS',
              startIndex: INSERT_COL_INDEX,
              endIndex: INSERT_COL_INDEX + 1,
            },
            inheritFromBefore: false,
          },
        }],
      },
    });

    // ヘッダーを設定
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${tabName}'!S1`,
      valueInputOption: 'RAW',
      requestBody: { values: [[NEW_HEADER]] },
    });

    console.log(`[DONE] ${tabName}: "${NEW_HEADER}" 列を挿入しました`);
  }

  console.log('\n完了。');
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
