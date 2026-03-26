import * as dotenv from 'dotenv';
dotenv.config();
import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';

const ERROR_MSG = 'スタッフ配置不可：担当スタッフが同時間帯に他利用者の予定と重複しHAMで選択不可（手動配置が必要）';

// 谷口ミヨ子 (2月 Row656) + 生野正近 (3月 Row7)
const targets = [
  { tab: '2026年02月', recordId: '121747', patient: '谷口ミヨ子' },
  { tab: '2026年03月', recordId: '121961', patient: '生野正近' },
];

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const updates: { range: string; values: string[][] }[] = [];

  for (const t of targets) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${t.tab}'!A2:V`,
    });
    const rows = res.data.values || [];
    const idx = rows.findIndex(r => (r[0] || '').trim() === t.recordId);
    if (idx === -1) {
      console.log(`${t.recordId} (${t.patient}): NOT FOUND in ${t.tab}`);
      continue;
    }
    const rowNum = idx + 2;
    const currentFlag = rows[idx][19] || '(empty)';

    updates.push(
      { range: `'${t.tab}'!T${rowNum}`, values: [['エラー：システム']] },
      { range: `'${t.tab}'!V${rowNum}`, values: [[ERROR_MSG]] },
    );
    console.log(`${t.recordId} (${t.patient}): Row${rowNum} "${currentFlag}" → "エラー：システム" + V列にエラー詳細`);
  }

  if (updates.length === 0) {
    console.log('更新対象なし');
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: updates },
  });
  console.log(`\n完了: ${updates.length / 2}件を更新`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
