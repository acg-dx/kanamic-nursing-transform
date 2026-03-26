/**
 * 転記待ちレコード一覧表示
 */
import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

const B2_IDS = new Set(['121032','121065','121068','121073','121077','121165','121167','121169','121129','121245','121195','121477']);

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

  const pending = rows.filter(row => {
    const cs = (row[12] || '').trim();
    const flag = (row[19] || '').trim();
    const locked = (row[25] || '').trim();
    if (locked === 'TRUE') return false;
    if (cs === '' || cs === '1') return false;
    if (flag === '転記済み') return false;
    if (flag === '') return true;
    if (flag === 'エラー：システム') return true;
    if (flag === 'エラー：マスタ不備') return true;
    if (flag === '修正あり') return true;
    return false;
  });

  console.log(`転記待ち: ${pending.length}件\n`);

  const b2Records = pending.filter(r => B2_IDS.has((r[0] || '').trim()));
  const otherRecords = pending.filter(r => !B2_IDS.has((r[0] || '').trim()));

  console.log(`=== B2 漏登録12件 (${b2Records.length}件) ===`);
  for (const row of b2Records) {
    const id = row[0] || '';
    const patient = row[6] || '';
    const date = row[7] || '';
    const time = row[8] || '';
    const flag = row[19] || '';
    const serviceType1 = row[10] || '';
    console.log(`  ${id} | ${patient} | ${date} ${time} | ${serviceType1} | flag="${flag}"`);
  }

  console.log(`\n=== その他の転記待ち (${otherRecords.length}件) ===`);
  for (const row of otherRecords) {
    const id = row[0] || '';
    const patient = row[6] || '';
    const date = row[7] || '';
    const time = row[8] || '';
    const flag = row[19] || '';
    const serviceType1 = row[10] || '';
    console.log(`  ${id} | ${patient} | ${date} ${time} | ${serviceType1} | flag="${flag}"`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
