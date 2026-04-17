/**
 * 指定メールアドレスを全 Sheet に editor 権限で追加
 */
import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';
import path from 'path';

const TARGET_EMAIL = 'makitoru@aozora-cg.com';

const SHEETS = [
  { name: '姶良', id: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M' },
  { name: '荒田', id: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4' },
  { name: '谷山', id: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8' },
  { name: '福岡', id: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg' },
  { name: '建物管理', id: '18DueDsYPsNmePiYIp9hVpD1rIWWMCyPX5SdWzXOnZBY' },
];

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json'),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  for (const s of SHEETS) {
    try {
      await drive.permissions.create({
        fileId: s.id,
        sendNotificationEmail: false,
        supportsAllDrives: true,
        requestBody: {
          type: 'user',
          role: 'writer',
          emailAddress: TARGET_EMAIL,
        },
      });
      console.log(`OK [${s.name}] ${TARGET_EMAIL} を editor 追加`);
    } catch (e) {
      console.log(`NG [${s.name}] ${(e as Error).message}`);
    }
  }
}

main().catch(console.error);
