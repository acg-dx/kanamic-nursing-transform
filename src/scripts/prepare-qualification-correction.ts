/**
 * Step 4準備: 資格修正対象レコードの転記フラグを「修正あり」に設定
 *
 * HAM 8-1 CSV + SmartHR 資格データから修正マニフェストを生成し、
 * 対応するシート行の T列(19) を「修正あり」に設定する。
 * 転記ワークフロー(run-transcription.ts) が「修正あり」レコードを
 * 削除→再登録（正しい資格で）することで修正を実行する。
 *
 * 実行:
 *   npx tsx src/scripts/prepare-qualification-correction.ts --dry-run
 *   npx tsx src/scripts/prepare-qualification-correction.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';
import { QualificationCorrectionService, CorrectionRecord } from '../services/qualification-correction.service';
import { normalizeCjkName } from '../core/cjk-normalize';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

const COL_T = 'T'; // 転記フラグ (index 19)
const COL_V = 'V'; // エラー詳細 (index 21)

function normalize(s: string): string {
  return normalizeCjkName(s.normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '').trim());
}

function csvDateToSheet(csvDate: string): string {
  // YYYY-MM-DD (manifest already converts from YYYY/MM/DD)
  return csvDate;
}

interface SheetRow {
  rowNum: number;
  recordId: string;
  staffName: string;     // E列 (index 4)
  patientName: string;   // G列 (index 6)
  visitDate: string;     // H列 (index 7)
  startTime: string;     // I列 (index 8)
  endTime: string;       // J列 (index 9)
  serviceType1: string;  // K列 (index 10) = 医療/介護
  flag: string;          // T列 (index 19)
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('=== DRY RUN ===\n');

  // 1. マニフェスト生成
  console.log('=== Step 1: マニフェスト生成 ===');
  const service = new QualificationCorrectionService();
  const manifest = await service.generateManifest();
  console.log(`マニフェスト: ${manifest.length} 件\n`);

  // 2. シートデータ取得
  console.log('=== Step 2: シートデータ取得 ===');
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A2:V`,
  });
  const rows = response.data.values || [];
  console.log(`シート行数: ${rows.length}\n`);

  // シート行をパース
  const sheetRows: SheetRow[] = rows.map((r, i) => ({
    rowNum: i + 2,
    recordId: (r[0] || '').trim(),
    staffName: (r[4] || '').trim(),
    patientName: (r[6] || '').trim(),
    visitDate: (r[7] || '').trim(),
    startTime: (r[8] || '').trim(),
    endTime: (r[9] || '').trim(),
    serviceType1: (r[10] || '').trim(),
    flag: (r[19] || '').trim(),
  }));

  // 3. マニフェスト ↔ シートのマッチング
  console.log('=== Step 3: マッチング ===');

  // シート行をキーでインデックス化（高速検索用）
  const sheetIndex = new Map<string, SheetRow[]>();
  for (const sr of sheetRows) {
    // 医療のみ対象
    if (sr.serviceType1 !== '医療') continue;
    const key = `${normalize(sr.patientName)}|${sr.visitDate}|${sr.startTime}`;
    if (!sheetIndex.has(key)) sheetIndex.set(key, []);
    sheetIndex.get(key)!.push(sr);
  }

  const matched: Array<{ manifest: CorrectionRecord; sheet: SheetRow }> = [];
  const unmatched: CorrectionRecord[] = [];
  const alreadyCorrected: CorrectionRecord[] = [];
  for (const rec of manifest) {
    const sheetDate = csvDateToSheet(rec.date);
    const key = `${normalize(rec.patientName)}|${sheetDate}|${rec.startTime}`;
    const candidates = sheetIndex.get(key) || [];

    // スタッフ名でさらにフィルタ
    const normManifestStaff = normalize(rec.staffName);
    const match = candidates.find(sr => normalize(sr.staffName) === normManifestStaff);

    if (!match) {
      unmatched.push(rec);
      continue;
    }

    // 既に修正あり → スキップ（再設定不要）
    if (match.flag === '修正あり') {
      alreadyCorrected.push(rec);
      continue;
    }

    // 転記済み・エラー系すべてを修正対象として受け入れる
    // 以前の実行で資格選択バグにより誤登録された転記済みレコードや、
    // エラーで中断したレコードも含めて再修正が必要
    matched.push({ manifest: rec, sheet: match });
  }

  console.log(`マッチ成功: ${matched.length} 件 → 修正あり に設定予定`);
  console.log(`既に修正あり: ${alreadyCorrected.length} 件`);
  console.log(`未マッチ: ${unmatched.length} 件`);

  // マッチしたレコードの現在のステータス内訳
  const flagCounts = new Map<string, number>();
  for (const { sheet } of matched) {
    const f = sheet.flag || '(空)';
    flagCounts.set(f, (flagCounts.get(f) || 0) + 1);
  }
  if (flagCounts.size > 0) {
    console.log('\n--- マッチ対象の現在のフラグ内訳 ---');
    for (const [flag, count] of flagCounts) {
      console.log(`  ${flag}: ${count} 件`);
    }
  }

  if (unmatched.length > 0) {
    console.log('\n--- 未マッチ詳細 (上位10件) ---');
    for (const rec of unmatched.slice(0, 10)) {
      console.log(`  ${rec.date} ${rec.startTime} ${rec.patientName} (${rec.staffName})`);
    }
    if (unmatched.length > 10) console.log(`  ... 他 ${unmatched.length - 10} 件`);
  }

  // スタッフ別集計
  const byStaff = new Map<string, number>();
  for (const { manifest: rec } of matched) {
    byStaff.set(rec.staffName, (byStaff.get(rec.staffName) || 0) + 1);
  }
  console.log('\n--- スタッフ別マッチ数 ---');
  for (const [staff, count] of byStaff) {
    console.log(`  ${staff}: ${count} 件`);
  }

  if (matched.length === 0) {
    console.log('\n更新対象なし');
    return;
  }

  // 4. シート更新
  console.log(`\n=== Step 4: シート更新 ${dryRun ? '(DRY RUN)' : ''} ===`);
  console.log(`${matched.length} 件を「修正あり」に設定`);

  if (dryRun) {
    console.log('\nサンプル (上位10件):');
    for (const { manifest: rec, sheet } of matched.slice(0, 10)) {
      console.log(`  ${sheet.recordId} row${sheet.rowNum}: ${rec.patientName} ${rec.date} ${rec.startTime} (${rec.staffName}) → 修正あり`);
    }
    if (matched.length > 10) console.log(`  ... 他 ${matched.length - 10} 件`);
    console.log('\n[DRY RUN] 実行するには --dry-run を外してください');
    return;
  }

  // batchUpdate で一括更新（API レートリミット対策）
  const batchData: Array<{ range: string; values: string[][] }> = [];
  for (const { sheet } of matched) {
    batchData.push({ range: `${TAB}!${COL_T}${sheet.rowNum}`, values: [['修正あり']] });
    batchData.push({ range: `${TAB}!${COL_V}${sheet.rowNum}`, values: [['']] });
  }

  // Google Sheets batchUpdate は 1 リクエストで複数レンジを更新可能
  // ただし大量の場合は分割（1バッチ最大100レンジ）
  const BATCH_CHUNK = 100;
  let updated = 0;
  for (let i = 0; i < batchData.length; i += BATCH_CHUNK) {
    const chunk = batchData.slice(i, i + BATCH_CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: chunk,
      },
    });
    updated += Math.floor(chunk.length / 2); // 2 ranges per record
    console.log(`  ${updated}/${matched.length} 件更新済み...`);
  }

  console.log(`\n完了: ${updated} 件を「修正あり」に設定`);
  console.log('\n次のステップ:');
  console.log('  npx tsx src/scripts/run-transcription.ts --tab=2026年02月');
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
