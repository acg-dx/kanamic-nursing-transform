/**
 * 削除済みレコードの月次シート行を一括削除するリトロアクティブクリーンアップスクリプト
 *
 * 削除タブの完了ステータスが「削除済み」のレコードを対象に、
 * 対応する月次シート (e.g. "2026年02月") の行を削除する。
 *
 * 冪等: 既に月次シートから削除済みの行はスキップされる（二重実行安全）
 *
 * 使い方:
 *   npx ts-node src/scripts/cleanup-deleted-records.ts
 *   RUN_LOCATIONS=姶良 npx ts-node src/scripts/cleanup-deleted-records.ts
 */
import dotenv from 'dotenv';
dotenv.config();
import { SpreadsheetService } from '../services/spreadsheet.service';

const SHEET_LOCATIONS = [
  { name: '谷山', sheetId: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8' },
  { name: '荒田', sheetId: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4' },
  { name: '博多', sheetId: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg' },
  { name: '姶良', sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M' },
];

/**
 * visitDate (YYYY-MM-DD または YYYY/MM/DD) から月次タブ名 (e.g. "2026年02月") を生成する
 */
function visitDateToMonthTab(visitDate: string): string {
  const normalized = visitDate.replace(/\//g, '-');
  const parts = normalized.split('-');
  if (parts.length < 2 || !parts[0] || !parts[1]) return '';
  return `${parts[0]}年${parts[1].padStart(2, '0')}月`;
}

async function main(): Promise<void> {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
  const sheets = new SpreadsheetService(keyPath);

  // RUN_LOCATIONS 環境変数で事業所をフィルタ（未設定なら全事業所）
  const runLocations = process.env.RUN_LOCATIONS;
  const locations = runLocations
    ? SHEET_LOCATIONS.filter(l => runLocations.split(',').map(s => s.trim()).includes(l.name))
    : SHEET_LOCATIONS;

  if (locations.length === 0) {
    console.error('対象事業所が見つかりません。RUN_LOCATIONS を確認してください。');
    process.exit(1);
  }

  let totalDeleted = 0;
  let totalNotFound = 0;
  let totalSkipped = 0;

  for (const location of locations) {
    console.log(`\n--- ${location.name} (sheetId=${location.sheetId}) ---`);

    const records = await sheets.getDeletionRecords(location.sheetId);
    const deletedRecords = records.filter(
      r => r.completionStatus === '削除済み' && r.recordId
    );

    console.log(`削除タブ: 全${records.length}件中、削除済み ${deletedRecords.length}件を処理`);

    for (const record of deletedRecords) {
      const monthTab = visitDateToMonthTab(record.visitDate);
      if (!monthTab) {
        console.warn(`  [SKIP] ${record.recordId}: visitDate「${record.visitDate}」からタブ名を特定できません`);
        totalSkipped++;
        continue;
      }

      const deleted = await sheets.deleteRowByRecordId(location.sheetId, monthTab, record.recordId);
      if (deleted) {
        console.log(`  [DELETED] ${record.recordId} from tab「${monthTab}」`);
        totalDeleted++;
      } else {
        console.log(`  [NOT FOUND] ${record.recordId} in tab「${monthTab}」(既に削除済みの可能性)`);
        totalNotFound++;
      }
    }
  }

  console.log('\n=== 完了 ===');
  console.log(`削除: ${totalDeleted} 行`);
  console.log(`見つからず（既に削除済みの可能性）: ${totalNotFound} 行`);
  console.log(`スキップ: ${totalSkipped} 行`);
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
