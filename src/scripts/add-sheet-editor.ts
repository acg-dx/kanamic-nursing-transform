/**
 * C3: シート保護に dxgroup@aozora-cg.com を追加するスクリプト
 *
 * 使用方法:
 *   npx tsx src/scripts/add-sheet-editor.ts
 *   npx tsx src/scripts/add-sheet-editor.ts --dry-run
 */

import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M'; // 姶良
const TARGET_EMAIL = 'dxgroup@aozora-cg.com';

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH!,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // 保護範囲一覧を取得
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.protectedRanges',
  });

  const protectedRanges = spreadsheet.data.sheets?.flatMap(s => s.protectedRanges ?? []) ?? [];

  if (protectedRanges.length === 0) {
    console.log('保護範囲が見つかりません');
    return;
  }

  console.log(`保護範囲: ${protectedRanges.length} 件`);

  for (const pr of protectedRanges) {
    if (!pr.protectedRangeId) continue;

    const editors = pr.editors?.users ?? [];
    const description = pr.description || `ID: ${pr.protectedRangeId}`;

    if (editors.includes(TARGET_EMAIL)) {
      console.log(`[SKIP] "${description}": ${TARGET_EMAIL} は既に追加済み`);
      continue;
    }

    console.log(`[${dryRun ? 'DRY-RUN' : 'EXECUTE'}] "${description}": ${TARGET_EMAIL} を追加`);
    console.log(`  現在のエディタ: ${editors.join(', ') || '(なし)'}`);

    if (dryRun) continue;

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          updateProtectedRange: {
            protectedRange: {
              protectedRangeId: pr.protectedRangeId,
              editors: { users: [...editors, TARGET_EMAIL] },
            },
            fields: 'editors',
          },
        }],
      },
    });

    console.log(`[DONE] "${description}": ${TARGET_EMAIL} を追加しました`);
  }

  console.log('\n完了。');
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
