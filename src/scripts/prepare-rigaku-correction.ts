/**
 * 理学療法士等 searchKbn 修正準備スクリプト
 *
 * 姶良の理学療法士等+医療+転記済みレコードの転記フラグを「修正あり」に設定する。
 * 転記ワークフローが「修正あり」レコードを検出し、既存HAMエントリを削除→
 * 正しい searchKbn=3（理学療法士等）で再登録する。
 *
 * Usage:
 *   npx tsx src/scripts/prepare-rigaku-correction.ts --dry-run    # 確認のみ
 *   npx tsx src/scripts/prepare-rigaku-correction.ts              # 実行
 *   npx tsx src/scripts/prepare-rigaku-correction.ts --tab=2026年02月  # 月指定
 */

import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const AIRA_SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const MONTH_TAB_PATTERN = /^\d{4}年\d{2}月$/;

// C1 挿入後の列レイアウト (A-Z, 26列)
const COL_E = 4;   // 記録者 (資格-姓名)
const COL_K = 10;  // 支援区分1
const COL_T = 19;  // 転記フラグ

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    tab: args.find(a => a.startsWith('--tab='))?.split('=')[1] || '',
  };
}

interface TargetRecord {
  rowNum: number;      // 1-indexed sheet row (including header)
  recordId: string;
  staffName: string;
  patientName: string;
  visitDate: string;
  startTime: string;
  serviceType2: string;
  currentFlag: string;
  tab: string;
}

async function main() {
  const opts = parseArgs();
  console.log(`=== 理学療法士等 searchKbn 修正準備 ===`);
  console.log(`モード: ${opts.dryRun ? 'DRY-RUN (変更なし)' : 'EXECUTE (シート更新)'}`);
  if (opts.tab) console.log(`対象タブ: ${opts.tab}`);

  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Get month tabs
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: AIRA_SHEET_ID,
    fields: 'sheets.properties',
  });
  const allSheets = spreadsheet.data.sheets || [];
  let monthTabs = allSheets
    .filter(s => s.properties?.title && MONTH_TAB_PATTERN.test(s.properties.title))
    .map(s => s.properties!.title!);

  if (opts.tab) {
    monthTabs = monthTabs.filter(t => t === opts.tab);
    if (monthTabs.length === 0) {
      console.error(`タブ「${opts.tab}」が見つかりません`);
      process.exit(1);
    }
  }

  console.log(`対象タブ: ${monthTabs.join(', ')}`);

  const allTargets: TargetRecord[] = [];

  for (const tab of monthTabs) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: AIRA_SHEET_ID,
      range: `'${tab}'!A2:Z`,
    });
    const rows = res.data.values || [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const staffName = (r[COL_E] || '').trim();
      const serviceType1 = (r[COL_K] || '').trim();
      const flag = (r[COL_T] || '').trim();

      // Filter: 理学療法士等 + 医療 + 転記済み
      if (!staffName.startsWith('理学療法士等-')) continue;
      if (serviceType1 !== '医療') continue;
      if (flag !== '転記済み') continue;

      allTargets.push({
        rowNum: i + 2,  // +2 because A2:Z starts from row 2
        recordId: (r[0] || '').trim(),
        staffName: staffName.replace('理学療法士等-', ''),
        patientName: (r[6] || '').trim(),
        visitDate: (r[7] || '').trim(),
        startTime: (r[8] || '').trim(),
        serviceType2: (r[11] || '').trim(),
        currentFlag: flag,
        tab,
      });
    }
  }

  console.log(`\n修正対象: ${allTargets.length} 件`);

  // Group by tab
  const byTab = new Map<string, TargetRecord[]>();
  for (const t of allTargets) {
    if (!byTab.has(t.tab)) byTab.set(t.tab, []);
    byTab.get(t.tab)!.push(t);
  }

  // Group by staff
  const byStaff = new Map<string, number>();
  for (const t of allTargets) {
    byStaff.set(t.staffName, (byStaff.get(t.staffName) || 0) + 1);
  }

  for (const [tab, recs] of byTab) {
    console.log(`\n--- ${tab}: ${recs.length} 件 ---`);
    for (const rec of recs.slice(0, 5)) {
      console.log(`  Row ${rec.rowNum} | ID=${rec.recordId} | ${rec.visitDate} ${rec.startTime} | ${rec.patientName} | ${rec.staffName} | ${rec.serviceType2}`);
    }
    if (recs.length > 5) {
      console.log(`  ... 他 ${recs.length - 5} 件`);
    }
  }

  console.log('\n--- スタッフ別内訳 ---');
  for (const [staff, count] of [...byStaff.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${staff}: ${count} 件`);
  }

  if (allTargets.length === 0) {
    console.log('\n修正対象なし。');
    return;
  }

  if (opts.dryRun) {
    console.log('\n[DRY-RUN] シートは更新されません。実行するには --dry-run を外してください。');
    return;
  }

  // === Execute: Set T列 to 「修正あり」 ===
  console.log(`\n=== シート更新: ${allTargets.length} 件を「修正あり」に設定 ===`);

  // Build batch update data, grouped by tab
  for (const [tab, recs] of byTab) {
    const batchData: Array<{ range: string; values: string[][] }> = [];
    for (const rec of recs) {
      // T列 = column index 19 = column letter T
      batchData.push({
        range: `'${tab}'!T${rec.rowNum}`,
        values: [['修正あり']],
      });
    }

    // Batch update (max 100 ranges per request)
    const BATCH_CHUNK = 100;
    let updated = 0;
    for (let i = 0; i < batchData.length; i += BATCH_CHUNK) {
      const chunk = batchData.slice(i, i + BATCH_CHUNK);
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: AIRA_SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: chunk,
        },
      });
      updated += chunk.length;
      console.log(`  ${tab}: ${updated}/${recs.length} 件更新済み`);
    }
  }

  console.log(`\n✅ 完了: ${allTargets.length} 件を「修正あり」に設定`);
  console.log('\n次のステップ:');
  console.log('  npx tsx src/scripts/run-transcription.ts');
  console.log('  → 修正ありレコードを検出 → HAM既存削除 → searchKbn=3で再登録');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
