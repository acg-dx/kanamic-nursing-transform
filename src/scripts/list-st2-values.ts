import dotenv from 'dotenv';
dotenv.config();
import { google } from 'googleapis';

const AIRA_SHEET = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const COL_K = 10, COL_L = 11;

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH!,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: AIRA_SHEET, fields: 'sheets.properties',
  });
  const tabs = (spreadsheet.data.sheets || [])
    .filter(s => /^\d{4}年\d{2}月$/.test(s.properties?.title || ''))
    .map(s => s.properties!.title!);

  const st2Values = new Map<string, number>();
  for (const tab of tabs) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: AIRA_SHEET, range: `'${tab}'!A2:Z`,
    });
    for (const row of res.data.values || []) {
      const st1 = (row[COL_K] || '').trim();
      const st2 = (row[COL_L] || '').trim();
      const key = `${st1} / ${st2}`;
      st2Values.set(key, (st2Values.get(key) || 0) + 1);
    }
  }

  console.log('=== K列(支援区分1) / L列(支援区分2) 全組み合わせ ===');
  for (const [k, v] of [...st2Values].sort()) {
    console.log(`  ${k}: ${v}件`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
