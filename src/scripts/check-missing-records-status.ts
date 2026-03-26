/**
 * B2: 漏登録12件の詳細状態確認
 */
import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

const TARGET_IDS = ['121032','121065','121068','121073','121077','121165','121167','121169','121129','121245','121195','121477'];

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A2:Z`,
  });
  const rows = response.data.values || [];

  console.log('recordId | patientName | visitDate | startTime | completionStatus(M=12) | transcriptionFlag(T=19) | recordLocked(Z=25)');
  console.log('---');

  for (const row of rows) {
    const id = (row[0] || '').trim();
    if (!TARGET_IDS.includes(id)) continue;
    const patientName = row[6] || '';
    const visitDate = row[7] || '';
    const startTime = row[8] || '';
    const completionStatus = row[12] || '';
    const transcriptionFlag = row[19] || '';
    const recordLocked = row[25] || '';
    console.log(`${id} | ${patientName} | ${visitDate} | ${startTime} | completionStatus="${completionStatus}" | transcriptionFlag="${transcriptionFlag}" | recordLocked="${recordLocked}"`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
