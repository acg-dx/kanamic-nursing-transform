/**
 * 特定レコードの転記フラグを空白にリセットするスクリプト
 *
 * 漏登録（HAMに登録されていないが転記済みになっている）レコードを
 * 空白に戻し、新規転記として再処理させる。
 *
 * Usage: npx tsx src/scripts/set-blank-flag.ts <tab> <row> <recordId>
 *   例: npx tsx src/scripts/set-blank-flag.ts "2026年02月" 750 121911
 */
import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';

async function main() {
  const tab = process.argv[2];
  const row = parseInt(process.argv[3], 10);
  const expectedId = process.argv[4];

  if (!tab || !row || !expectedId) {
    console.error('Usage: npx tsx src/scripts/set-blank-flag.ts <tab> <row> <recordId>');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Verify record ID
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${tab}'!A${row}:T${row}`,
  });
  const vals = res.data.values?.[0];
  if (!vals) {
    console.error(`Row ${row} not found in tab "${tab}"`);
    process.exit(1);
  }

  const actualId = (vals[0] || '').trim();
  if (actualId !== expectedId) {
    console.error(`ID mismatch at row ${row}: expected=${expectedId}, actual=${actualId}`);
    process.exit(1);
  }

  const currentFlag = (vals[19] || '').trim();
  const patientName = (vals[6] || '').trim();
  const staffName = (vals[4] || '').trim();
  console.log(`Record: ${actualId} | ${patientName} | ${staffName} | current flag="${currentFlag}"`);

  // Set T column to blank
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${tab}'!T${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['']] },
  });

  // Also clear V column (error detail) if present
  if (vals.length > 21) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${tab}'!V${row}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['']] },
    });
  }

  console.log(`✅ Row ${row} (${actualId}): T列 → 空白 (was "${currentFlag}")`);
}

main().catch(e => { console.error(e); process.exit(1); });
