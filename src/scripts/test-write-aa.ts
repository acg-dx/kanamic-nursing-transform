/**
 * テスト: AA列への書き込み+読み戻しを検証
 * 姶良の先頭レコード（row 2）に仮値を書き込み、読み戻して確認後、クリアする
 */
import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';
import path from 'path';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M'; // 姶良
const TAB = '2026年04月';
const TEST_ROW = 2; // 先頭行
const TEST_VALUE = 'TEST_BACKFILL_12345';

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 0. 列数を確認+拡張
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets(properties(sheetId,title,gridProperties(columnCount)))',
  });
  for (const s of (meta.data.sheets || [])) {
    if (s.properties?.title === TAB) {
      const cols = s.properties.gridProperties?.columnCount || 0;
      console.log(`[Meta] ${TAB} cols=${cols}`);
      if (cols < 27) {
        console.log(`[Expand] ${cols} → 27`);
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SHEET_ID,
          requestBody: {
            requests: [{
              updateSheetProperties: {
                properties: {
                  sheetId: s.properties.sheetId!,
                  gridProperties: { columnCount: 27 },
                },
                fields: 'gridProperties.columnCount',
              },
            }],
          },
        });
      }
    }
  }

  // 1. 現在の値を読み取り
  const before = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!AA${TEST_ROW}`,
  });
  console.log(`[Before] AA${TEST_ROW} = "${(before.data.values?.[0]?.[0]) || '(空)'}"`);

  // 2. テスト値を書き込み
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!AA${TEST_ROW}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[TEST_VALUE]] },
  });
  console.log(`[Write] AA${TEST_ROW} に "${TEST_VALUE}" を書き込み`);

  // 3. 読み戻して確認
  const after = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!AA${TEST_ROW}`,
  });
  const readBack = after.data.values?.[0]?.[0] || '';
  console.log(`[Verify] AA${TEST_ROW} = "${readBack}"`);

  if (readBack === TEST_VALUE) {
    console.log('OK: 書き込み+読み戻し成功');
  } else {
    console.log(`NG: 期待="${TEST_VALUE}", 実際="${readBack}"`);
  }

  // 4. クリア（元に戻す）
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!AA${TEST_ROW}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['']] },
  });
  console.log(`[Cleanup] AA${TEST_ROW} をクリア`);
}

main().catch(console.error);
