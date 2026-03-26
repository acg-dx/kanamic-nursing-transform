/**
 * 指定レコードの転記フラグを変更するユーティリティスクリプト
 *
 * 使用方法:
 *   npx tsx src/scripts/set-status.ts 121047 転記済み
 *   npx tsx src/scripts/set-status.ts 121047 修正あり
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

async function main() {
  const recordId = process.argv[2];
  const newStatus = process.argv[3];
  if (!recordId || !newStatus) {
    console.log('Usage: npx tsx src/scripts/set-status.ts <recordId> <status>');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A2:V`,
  });
  const rows = res.data.values || [];
  const idx = rows.findIndex(r => (r[0] || '').trim() === recordId);
  if (idx === -1) {
    console.log(`${recordId}: NOT FOUND`);
    process.exit(1);
  }

  const rowNum = idx + 2;
  const currentFlag = rows[idx][19] || '(empty)';
  const currentError = rows[idx][21] || '(empty)';
  console.log(`${recordId}: row=${rowNum} current_flag="${currentFlag}" error="${currentError}"`);

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${TAB}!T${rowNum}`, values: [[newStatus]] },
        { range: `${TAB}!V${rowNum}`, values: [['']] },
      ],
    },
  });
  console.log(`${recordId}: "${currentFlag}" → "${newStatus}" (done)`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
