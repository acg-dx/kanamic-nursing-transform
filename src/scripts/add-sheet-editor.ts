/**
 * C3: シート保護に dxgroup@aozora-cg.com を追加するスクリプト
 *
 * 使用方法:
 *   npx tsx src/scripts/add-sheet-editor.ts                    # 全事業所
 *   npx tsx src/scripts/add-sheet-editor.ts --dry-run
 *   npx tsx src/scripts/add-sheet-editor.ts --location=姶良    # 指定事業所のみ
 */

import { google, sheets_v4 } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

/** 全事業所のSheet ID */
const ALL_LOCATIONS = [
  { name: '谷山', sheetId: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8' },
  { name: '荒田', sheetId: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4' },
  { name: '博多', sheetId: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg' },
  { name: '姶良', sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M' },
];

const TARGET_EMAIL = 'dxgroup@aozora-cg.com';

async function processLocation(
  sheets: sheets_v4.Sheets,
  locationName: string,
  spreadsheetId: string,
  dryRun: boolean,
) {
  console.log(`\n========== ${locationName} (${spreadsheetId.slice(0, 8)}...) ==========`);

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
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
    const groups = pr.editors?.groups ?? [];
    const description = pr.description || `ID: ${pr.protectedRangeId}`;

    if (editors.includes(TARGET_EMAIL) || groups.includes(TARGET_EMAIL)) {
      console.log(`[SKIP] "${description}": ${TARGET_EMAIL} は既に追加済み`);
      continue;
    }

    console.log(`[${dryRun ? 'DRY-RUN' : 'EXECUTE'}] "${description}": ${TARGET_EMAIL} を追加`);
    console.log(`  現在のエディタ(users): ${editors.join(', ') || '(なし)'}  groups: ${groups.join(', ') || '(なし)'}`);

    if (dryRun) continue;

    // Google Group として追加（dxgroup はグループアドレス）
    const currentGroups = pr.editors?.groups ?? [];
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            updateProtectedRange: {
              protectedRange: {
                protectedRangeId: pr.protectedRangeId,
                editors: {
                  users: editors,
                  groups: [...currentGroups, TARGET_EMAIL],
                },
              },
              fields: 'editors',
            },
          }],
        },
      });
    } catch (err: unknown) {
      const msg = (err as Error).message || '';
      if (msg.includes('Invalid user')) {
        console.log(`  → users として再試行中...`);
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{
              updateProtectedRange: {
                protectedRange: {
                  protectedRangeId: pr.protectedRangeId,
                  editors: { users: [...editors, TARGET_EMAIL], groups: currentGroups },
                },
                fields: 'editors',
              },
            }],
          },
        });
      } else {
        throw err;
      }
    }

    console.log(`[DONE] "${description}": ${TARGET_EMAIL} を追加しました`);
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const locationArg = process.argv.find(a => a.startsWith('--location='))?.split('=')[1];

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH!,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const targets = locationArg
    ? ALL_LOCATIONS.filter(l => l.name === locationArg)
    : ALL_LOCATIONS;

  if (targets.length === 0) {
    console.error(`事業所 "${locationArg}" が見つかりません。選択肢: ${ALL_LOCATIONS.map(l => l.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`対象事業所: ${targets.map(l => l.name).join(', ')}`);

  for (const loc of targets) {
    await processLocation(sheets, loc.name, loc.sheetId, dryRun);
  }

  console.log('\n完了。');
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
