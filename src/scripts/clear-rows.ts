/**
 * 指定利用者の全行について S列（転記フラグ）と U列（エラー詳細）を空白にリセットする
 * 使い方: npx ts-node src/scripts/clear-rows.ts
 */
import dotenv from 'dotenv';
dotenv.config();
import { google } from 'googleapis';

async function main() {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetId = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M'; // 姶良

  const now = new Date();
  const tab = `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月`;

  // I5 バグ影響の特定行のみクリア（非I5の正常転記済みレコードを壊さないため）
  const targetRows = [114, 117, 135, 140, 144];
  // 114: 乾五男 121121, 117: 八汐征男 121158, 135: 西之園喜美子 121161,
  // 140: 横山宜子 121156, 144: 上枝眞由美 121164

  let cleared = 0;
  for (const rowNum of targetRows) {
    // S列 = 転記フラグ → 空白
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tab}!S${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['']] },
    });
    // U列 = エラー詳細 → 空白
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tab}!U${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['']] },
    });
    console.log(`row ${rowNum}: S列・U列クリア`);
    cleared++;
  }
  console.log(`完了: ${cleared}行クリア`);
}

main().catch(console.error);
