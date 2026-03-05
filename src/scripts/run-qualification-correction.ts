/**
 * D1: 資格修正実行スクリプト
 *
 * HAM 8-1 CSV と SmartHR 資格データを突合し、
 * 看護医療の資格誤登録（212件）を修正する。
 *
 * 使用方法:
 *   npx tsx src/scripts/run-qualification-correction.ts --dry-run
 *   npx tsx src/scripts/run-qualification-correction.ts --batch-size=50 --batch=1
 *   npx tsx src/scripts/run-qualification-correction.ts --staff=冨迫広美 --dry-run
 */

import { QualificationCorrectionService, CorrectionRecord } from '../services/qualification-correction.service';
import dotenv from 'dotenv';

dotenv.config();

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    batchSize: parseInt(args.find(a => a.startsWith('--batch-size='))?.split('=')[1] || '50'),
    batchNum: parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1] || '0'),
    staffFilter: args.find(a => a.startsWith('--staff='))?.split('=')[1] || '',
  };
}

function groupByStaff(manifest: CorrectionRecord[]): Map<string, CorrectionRecord[]> {
  const map = new Map<string, CorrectionRecord[]>();
  for (const rec of manifest) {
    const key = rec.staffName;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(rec);
  }
  return map;
}

function groupByPatient(manifest: CorrectionRecord[]): Map<string, CorrectionRecord[]> {
  const map = new Map<string, CorrectionRecord[]>();
  for (const rec of manifest) {
    const key = rec.patientName;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(rec);
  }
  return map;
}

async function main() {
  const opts = parseArgs();
  const service = new QualificationCorrectionService();

  console.log('=== 資格修正スクリプト ===');
  console.log(`モード: ${opts.dryRun ? 'DRY-RUN' : 'EXECUTE'}`);
  if (opts.staffFilter) console.log(`スタッフフィルタ: ${opts.staffFilter}`);
  if (!opts.dryRun && opts.batchNum > 0) console.log(`バッチ: ${opts.batchNum} (サイズ: ${opts.batchSize})`);
  console.log('');

  // マニフェスト生成
  console.log('マニフェスト生成中...');
  let manifest = await service.generateManifest();

  // スタッフフィルタ
  if (opts.staffFilter) {
    manifest = manifest.filter(r => r.staffName.includes(opts.staffFilter));
    console.log(`フィルタ後: ${manifest.length} 件`);
  }

  // スタッフ別集計
  const byStaff = groupByStaff(manifest);
  const byPatient = groupByPatient(manifest);

  console.log(`\n=== 修正マニフェスト ===`);
  console.log(`総件数: ${manifest.length} 件`);
  console.log('');
  console.log('スタッフ別:');
  for (const [staff, recs] of byStaff) {
    const targetQual = recs[0].targetQualification;
    console.log(`  ${staff}: ${recs.length} 件 → ${targetQual}`);
  }
  console.log('');
  console.log(`患者別 (上位10件):`);
  const patientEntries = Array.from(byPatient.entries()).sort((a, b) => b[1].length - a[1].length);
  for (const [patient, recs] of patientEntries.slice(0, 10)) {
    console.log(`  ${patient}: ${recs.length} 件`);
  }
  if (patientEntries.length > 10) {
    console.log(`  ... 他 ${patientEntries.length - 10} 患者`);
  }

  if (opts.dryRun) {
    console.log('\n[DRY-RUN] 実際の修正は行いません。');
    console.log('実行するには --dry-run を外してください。');
    return;
  }

  // バッチ処理
  const checkpoint = await service.loadCheckpoint();
  const remaining = manifest.filter(r => !checkpoint.has(QualificationCorrectionService.recordKey(r)));
  console.log(`\n残り: ${remaining.length} 件 (完了済み: ${checkpoint.size} 件)`);

  if (remaining.length === 0) {
    console.log('全件完了済みです。');
    return;
  }

  // バッチ選択
  let batchRecords: CorrectionRecord[];
  if (opts.batchNum > 0) {
    const start = (opts.batchNum - 1) * opts.batchSize;
    batchRecords = remaining.slice(start, start + opts.batchSize);
    console.log(`バッチ ${opts.batchNum}: ${start + 1}〜${start + batchRecords.length} 件目`);
  } else {
    batchRecords = remaining.slice(0, opts.batchSize);
    console.log(`最初のバッチ: ${batchRecords.length} 件`);
  }

  if (batchRecords.length === 0) {
    console.log('このバッチに処理対象がありません。');
    return;
  }

  console.log('\n[EXECUTE] 修正を開始します...');
  console.log('注意: HAM への実際の操作は Wave 2 (B3) で実行されます。');
  console.log('このスクリプトは現在マニフェスト生成のみ対応しています。');
  console.log('');
  console.log('修正対象レコード:');
  for (const rec of batchRecords.slice(0, 5)) {
    console.log(`  ${rec.date} ${rec.startTime} ${rec.patientName} (${rec.staffName}) → ${rec.targetQualification}`);
  }
  if (batchRecords.length > 5) {
    console.log(`  ... 他 ${batchRecords.length - 5} 件`);
  }
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
