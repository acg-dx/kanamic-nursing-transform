import dotenv from 'dotenv';
dotenv.config();
import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A1:Z1`,
  });
  const header = response.data.values?.[0] || [];
  
  console.log('Column mapping:');
  header.forEach((col, idx) => {
    const colLetter = String.fromCharCode(65 + idx);
    console.log(`${colLetter}(${idx}): ${col}`);
  });
  
  // Get first 3 data rows to see structure
  const dataResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A2:Z4`,
  });
  const rows = dataResponse.data.values || [];
  console.log('\nFirst 3 data rows:');
  rows.forEach((row, idx) => {
    console.log(`Row ${idx + 2}:`, row.slice(0, 10).join(' | '));
  });
}

main().catch(err => console.error(err.message));
