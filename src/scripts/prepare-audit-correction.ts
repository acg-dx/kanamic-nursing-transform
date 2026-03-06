/**
 * 監査結果に基づく修正準備スクリプト
 *
 * full-service-audit.ts が出力した audit-corrections.json を読み込み、
 * 対象レコードの転記フラグ (T列) を「修正あり」に設定する。
 * 転記ワークフロー (run-transcription.ts) が「修正あり」レコードを検出し、
 * 既存 HAM エントリを削除 → 正しい設定で再登録する。
 *
 * Usage:
 *   npx tsx src/scripts/prepare-audit-correction.ts --dry-run              # 確認のみ
 *   npx tsx src/scripts/prepare-audit-correction.ts                         # 実行
 *   npx tsx src/scripts/prepare-audit-correction.ts --bug=A-searchKbn       # 特定bug種別のみ
 *   npx tsx src/scripts/prepare-audit-correction.ts --json=./custom.json    # 別JSON指定
 *
 * 前提: 先に full-service-audit.ts を実行して audit-corrections.json を生成しておくこと
 *   npx tsx src/scripts/full-service-audit.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const AIRA_SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';

interface AuditCorrection {
  tab: string;
  row: number;
  recordId: string;
  bugs: string[];
  patientName: string;
  visitDate: string;
  startTime: string;
  st1: string;
  st2: string;
  qualification: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    jsonPath: args.find(a => a.startsWith('--json='))?.split('=')[1]
      || path.resolve('./audit-corrections.json'),
    bugFilter: args.find(a => a.startsWith('--bug='))?.split('=')[1] || '',
  };
}

async function main() {
  const opts = parseArgs();
  console.log(`=== 監査結果に基づく修正準備 ===`);
  console.log(`モード: ${opts.dryRun ? 'DRY-RUN (変更なし)' : 'EXECUTE (シート更新)'}`);

  // Load audit corrections JSON
  const jsonPath = path.resolve(opts.jsonPath);
  if (!fs.existsSync(jsonPath)) {
    console.error(`修正リストが見つかりません: ${jsonPath}`);
    console.error('先に full-service-audit.ts を実行してください:');
    console.error('  npx tsx src/scripts/full-service-audit.ts');
    process.exit(1);
  }

  let corrections: AuditCorrection[] = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  console.log(`修正リスト読み込み: ${corrections.length} 件 (${jsonPath})`);

  // Bug filter
  if (opts.bugFilter) {
    corrections = corrections.filter(c => c.bugs.some(b => b.includes(opts.bugFilter)));
    console.log(`Bugフィルタ "${opts.bugFilter}" 適用後: ${corrections.length} 件`);
  }

  if (corrections.length === 0) {
    console.log('\n修正対象なし。');
    return;
  }

  // Deduplicate by tab+row (audit may list same record under multiple bugs)
  const uniqueByKey = new Map<string, AuditCorrection>();
  for (const c of corrections) {
    const key = `${c.tab}:${c.row}`;
    const existing = uniqueByKey.get(key);
    if (existing) {
      // Merge bugs
      for (const b of c.bugs) {
        if (!existing.bugs.includes(b)) existing.bugs.push(b);
      }
    } else {
      uniqueByKey.set(key, { ...c });
    }
  }
  const uniqueCorrections = [...uniqueByKey.values()];
  console.log(`重複排除後: ${uniqueCorrections.length} 件`);

  // Group by tab
  const byTab = new Map<string, AuditCorrection[]>();
  for (const c of uniqueCorrections) {
    if (!byTab.has(c.tab)) byTab.set(c.tab, []);
    byTab.get(c.tab)!.push(c);
  }

  // Group by bug category
  const byBug = new Map<string, number>();
  for (const c of uniqueCorrections) {
    for (const b of c.bugs) {
      const cat = b.split('(')[0];  // e.g. "A-searchKbn(理学)" → "A-searchKbn"
      byBug.set(cat, (byBug.get(cat) || 0) + 1);
    }
  }

  // Group by st1
  const bySt1 = new Map<string, number>();
  for (const c of uniqueCorrections) {
    bySt1.set(c.st1, (bySt1.get(c.st1) || 0) + 1);
  }

  // Print summary
  for (const [tab, recs] of [...byTab].sort()) {
    console.log(`\n--- ${tab}: ${recs.length} 件 ---`);
    for (const rec of recs.slice(0, 8)) {
      console.log(`  Row ${rec.row} | ID=${rec.recordId} | ${rec.visitDate} ${rec.startTime} | ${rec.patientName} | ${rec.qualification} | ${rec.st1}/${rec.st2} | [${rec.bugs.join(', ')}]`);
    }
    if (recs.length > 8) {
      console.log(`  ... 他 ${recs.length - 8} 件`);
    }
  }

  console.log('\n--- 保険種別別内訳 ---');
  for (const [st1, count] of [...bySt1.entries()].sort()) {
    console.log(`  ${st1}: ${count} 件`);
  }

  console.log('\n--- Bug分類別内訳 ---');
  for (const [bug, count] of [...byBug.entries()].sort()) {
    console.log(`  ${bug}: ${count} 件`);
  }

  if (opts.dryRun) {
    console.log('\n[DRY-RUN] シートは更新されません。実行するには --dry-run を外してください。');
    return;
  }

  // === Verify current flags before updating ===
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log(`\n=== シート更新: ${uniqueCorrections.length} 件を「修正あり」に設定 ===`);

  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const [tab, recs] of [...byTab].sort()) {
    // Read current T column values for validation
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: AIRA_SHEET_ID,
      range: `'${tab}'!A2:T`,
    });
    const rows = res.data.values || [];

    const batchData: Array<{ range: string; values: string[][] }> = [];
    const skipped: string[] = [];

    for (const rec of recs) {
      const rowIdx = rec.row - 2; // Sheet row → array index (A2 starts at index 0)
      const currentRow = rows[rowIdx];
      if (!currentRow) {
        skipped.push(`Row ${rec.row}: 行が見つかりません`);
        continue;
      }

      // Verify record ID matches
      const actualRecordId = (currentRow[0] || '').trim();
      if (actualRecordId !== rec.recordId) {
        skipped.push(`Row ${rec.row}: ID不一致 (expected=${rec.recordId}, actual=${actualRecordId})`);
        continue;
      }

      // Check current flag
      const currentFlag = (currentRow[19] || '').trim();
      if (currentFlag === '修正あり') {
        skipped.push(`Row ${rec.row}: 既に修正あり`);
        continue;
      }
      if (currentFlag !== '転記済み') {
        skipped.push(`Row ${rec.row}: flag="${currentFlag}" (転記済み以外はスキップ)`);
        continue;
      }

      batchData.push({
        range: `'${tab}'!T${rec.row}`,
        values: [['修正あり']],
      });
    }

    if (skipped.length > 0) {
      console.log(`\n  ${tab}: スキップ ${skipped.length} 件`);
      for (const s of skipped.slice(0, 5)) console.log(`    ${s}`);
      if (skipped.length > 5) console.log(`    ... 他 ${skipped.length - 5} 件`);
      totalSkipped += skipped.length;
    }

    if (batchData.length === 0) {
      console.log(`  ${tab}: 更新対象なし`);
      continue;
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
      console.log(`  ${tab}: ${updated}/${batchData.length} 件更新済み`);
    }
    totalUpdated += updated;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`完了: ${totalUpdated} 件を「修正あり」に設定 (スキップ: ${totalSkipped} 件)`);
  console.log(`${'='.repeat(60)}`);
  console.log('\n次のステップ:');
  console.log('  npx tsx src/scripts/run-transcription.ts');
  console.log('  → 修正ありレコードを検出 → HAM既存削除 → 正しい設定で再登録');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
