/**
 * C1: 加算対象の理由 列挿入スクリプト
 *
 * 全月次タブ（\d{4}年\d{2}月）に列を挿入し、ヘッダーを設定する。
 * 冪等性あり: ヘッダーが既に存在する場合はスキップ。
 *
 * 使用方法:
 *   npx tsx src/scripts/update-sheet-columns.ts                    # 全事業所
 *   npx tsx src/scripts/update-sheet-columns.ts --dry-run
 *   npx tsx src/scripts/update-sheet-columns.ts --location=姶良    # 指定事業所のみ
 */

import { google, sheets_v4 } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

/** 全事業所のSheet ID */
const ALL_LOCATIONS = [
  { name: '谷山', sheetId: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8' },
  { name: '荒田', sheetId: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4' },
  { name: '博多', sheetId: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg' },
  { name: '姶良', sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M' },
];

const INSERT_COL_INDEX = 18; // S列(18) に挿入（R=緊急時事務員チェック の後）
const NEW_HEADER = '加算対象の理由';
const MONTH_TAB_PATTERN = /^\d{4}年\d{2}月$/;

async function processLocation(
  sheets: sheets_v4.Sheets,
  locationName: string,
  spreadsheetId: string,
  dryRun: boolean,
) {
  console.log(`\n========== ${locationName} (${spreadsheetId.slice(0, 8)}...) ==========`);

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });

  const allSheets = spreadsheet.data.sheets || [];
  const monthTabs = allSheets.filter(s =>
    s.properties?.title && MONTH_TAB_PATTERN.test(s.properties.title)
  );

  console.log(`対象タブ: ${monthTabs.map(s => s.properties?.title).join(', ')}`);

  for (const sheet of monthTabs) {
    const tabName = sheet.properties!.title!;
    const tabSheetId = sheet.properties!.sheetId!;

    // ヘッダー行を確認（冪等性チェック）
    const headerRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
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
      spreadsheetId,
      requestBody: {
        requests: [{
          insertDimension: {
            range: {
              sheetId: tabSheetId,
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
      spreadsheetId,
      range: `'${tabName}'!S1`,
      valueInputOption: 'RAW',
      requestBody: { values: [[NEW_HEADER]] },
    });

    console.log(`[DONE] ${tabName}: "${NEW_HEADER}" 列を挿入しました`);
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const locationArg = process.argv.find(a => a.startsWith('--location='))?.split('=')[1];

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH!,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const targets = locationArg
    ? ALL_LOCATIONS.filter(l => l.name === locationArg)
    : ALL_LOCATIONS;

  if (targets.length === 0) {
    console.error(`事業所 "${locationArg}" が見つかりません。選択肢: ${ALL_LOCATIONS.map(l => l.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`対象事業所: ${targets.map(l => l.name).join(', ')}`);

  for (const loc of targets) {
    await processLocation(sheets, loc.name, loc.sheetId, dryRun);
  }

  console.log('\n完了。');
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
