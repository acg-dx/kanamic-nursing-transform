import * as dotenv from 'dotenv';
dotenv.config();
import { google } from 'googleapis';
import fs from 'fs';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年03月';

async function main() {
  const corrections = JSON.parse(fs.readFileSync('./audit-corrections.json', 'utf-8'));
  const recordIds = [...new Set(corrections.map((c: { recordId: string }) => c.recordId))] as string[];
  console.log(`対象レコード: ${recordIds.length}件 → ${TAB}`);

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

  const updates: { range: string; values: string[][] }[] = [];
  for (const rid of recordIds) {
    const idx = rows.findIndex(r => (r[0] || '').trim() === rid);
    if (idx === -1) {
      console.log(`  ${rid}: NOT FOUND — スキップ`);
      continue;
    }
    const rowNum = idx + 2;
    const currentFlag = rows[idx][19] || '(empty)';
    updates.push(
      { range: `${TAB}!T${rowNum}`, values: [['修正あり']] },
      { range: `${TAB}!V${rowNum}`, values: [['']] },
    );
    console.log(`  ${rid}: row=${rowNum} "${currentFlag}" → "修正あり"`);
  }

  if (updates.length === 0) {
    console.log('更新対象なし');
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: updates },
  });
  console.log(`\n完了: ${updates.length / 2}件を修正ありに更新`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
