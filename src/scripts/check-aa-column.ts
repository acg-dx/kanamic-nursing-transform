/**
 * 検査スクリプト: 4据点の2026年04月タブ AA列(assignId) の状況を確認
 * 転記済みレコードのうち assignId が空のものを集計する
 */
import { google } from 'googleapis';
import path from 'path';

const SERVICE_ACCOUNT_KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';

const LOCATIONS = [
  { name: '姶良', sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M' },
  { name: '荒田', sheetId: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4' },
  { name: '谷山', sheetId: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8' },
  { name: '福岡', sheetId: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg' },
];

const TAB = '2026年04月';
// Also check March for comparison
const TAB_MARCH = '2026年03月';

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(SERVICE_ACCOUNT_KEY_PATH),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  for (const loc of LOCATIONS) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`据点: ${loc.name}`);
    console.log('='.repeat(60));

    for (const tab of [TAB, TAB_MARCH]) {
      try {
        // Read columns A-AA (columns 1-27): A=recordId, G=patientName, H=visitDate, T=転記フラグ, AA=assignId
        const range = `'${tab}'!A2:AA`;
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: loc.sheetId,
          range,
        });
        const rows = res.data.values || [];

        let totalRows = 0;
        let transcribed = 0;
        let withAssignId = 0;
        let withoutAssignId = 0;
        const missingExamples: string[] = [];

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const recordId = row[0] || '';
          if (!recordId) continue; // skip empty rows
          totalRows++;

          const patientName = row[6] || '';
          const visitDate = row[7] || '';
          const transcriptionFlag = row[19] || ''; // T column (index 19)
          const assignId = row[26] || ''; // AA column (index 26)

          if (transcriptionFlag === '転記済み') {
            transcribed++;
            if (assignId) {
              withAssignId++;
            } else {
              withoutAssignId++;
              if (missingExamples.length < 5) {
                missingExamples.push(`  row ${i + 2}: ${recordId} ${patientName} ${visitDate}`);
              }
            }
          }
        }

        console.log(`\n[${tab}]`);
        console.log(`  総行数: ${totalRows}`);
        console.log(`  転記済み: ${transcribed}`);
        console.log(`  assignId あり: ${withAssignId}`);
        console.log(`  assignId なし: ${withoutAssignId}`);
        if (missingExamples.length > 0) {
          console.log(`  assignId なし例 (先頭5件):`);
          missingExamples.forEach(ex => console.log(ex));
        }
      } catch (e) {
        console.log(`\n[${tab}] エラー: ${(e as Error).message}`);
      }
    }
  }
}

main().catch(console.error);
