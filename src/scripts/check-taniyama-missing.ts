/**
 * 転記漏れチェック（任意事業所）
 *
 * Tritrus からダウンロードした分割 CSV（2〜3 ファイル）を結合し、
 * Google Sheets で「転記済み」なのに Kanamic CSV に存在しないレコードを検出する。
 *
 * 使用方法:
 *   npx tsx src/scripts/check-taniyama-missing.ts --csv1=<CSV> --csv2=<CSV> [--csv3=<CSV>] [--location=谷山] [--month=202603]
 *
 * 例（谷山）:
 *   npx tsx src/scripts/check-taniyama-missing.ts \
 *     --csv1="C:\Users\dxgro\Downloads\schedule_4660191471_20260301.csv" \
 *     --csv2="C:\Users\dxgro\Downloads\schedule_4660191471_20260315.csv"
 *
 * 例（福岡）:
 *   npx tsx src/scripts/check-taniyama-missing.ts \
 *     --location=福岡 \
 *     --csv1="C:\Users\dxgro\Downloads\schedule_4060391200_20260301.csv" \
 *     --csv2="C:\Users\dxgro\Downloads\schedule_4060391200_20260316.csv"
 *
 * 例（荒田・3分割）:
 *   npx tsx src/scripts/check-taniyama-missing.ts \
 *     --location=荒田 \
 *     --csv1="C:\Users\dxgro\Downloads\schedule_4660190861_20260301.csv" \
 *     --csv2="C:\Users\dxgro\Downloads\schedule_4660190861_20260311.csv" \
 *     --csv3="C:\Users\dxgro\Downloads\schedule_4660190861_20260322.csv"
 */
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../core/logger';
import { loadConfig } from '../config/app.config';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { ReconciliationService } from '../services/reconciliation.service';
import { ScheduleCsvDownloaderService } from '../services/schedule-csv-downloader.service';

interface CliArgs {
  csvFiles: string[];
  month: string;
  location: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const getArg = (prefix: string) => args.find(a => a.startsWith(prefix))?.split('=').slice(1).join('=') || '';
  const csv1 = getArg('--csv1=');
  const csv2 = getArg('--csv2=');
  const csv3 = getArg('--csv3=');
  const month = args.find(a => a.startsWith('--month='))?.split('=')[1]
    || ScheduleCsvDownloaderService.getCurrentMonth();
  const location = args.find(a => a.startsWith('--location='))?.split('=')[1] || '谷山';

  const csvFiles = [csv1, csv2, csv3].filter(f => f.length > 0);
  return { csvFiles, month, location };
}

/**
 * 複数の Shift-JIS CSV を順番に結合（先頭ファイル以降はヘッダー行をスキップ）
 * 隣接するファイル間で日付が重複する行は前のファイルから除外する。
 * 結合結果は一時ファイルに書き込み、そのパスを返す。
 */
function mergeCsvFiles(csvPaths: string[]): string {
  const decode = (p: string) => {
    const buf = fs.readFileSync(p);
    const decoder = new TextDecoder('shift-jis');
    return decoder.decode(buf);
  };

  const allTexts = csvPaths.map(decode);
  const allLineArrays = allTexts.map(t => t.split(/\r?\n/));
  const headerLine = allLineArrays[0][0];

  const dataSegments: string[][] = [];

  for (let i = 0; i < allLineArrays.length; i++) {
    const lines = allLineArrays[i];
    // 次のファイルの開始日付を取得（重複除外用）
    const nextLines = allLineArrays[i + 1];
    const nextStartDate = nextLines
      ? (nextLines.slice(1).find(l => l.trim().length > 0) || '').match(/^"(\d{4}-\d{2}-\d{2})"/)?.[1] || ''
      : '';

    const data = lines.slice(1).filter(l => {
      if (!l.trim()) return false;
      if (nextStartDate) {
        const rowDate = l.match(/^"(\d{4}-\d{2}-\d{2})"/)?.[1] || '';
        if (rowDate >= nextStartDate) return false;
      }
      return true;
    });

    logger.info(`CSV${i + 1} (${path.basename(csvPaths[i])}): ${data.length} データ行${nextStartDate ? `（${nextStartDate} 以降を除外）` : ''}`);
    dataSegments.push(data);
  }

  const totalRows = dataSegments.reduce((sum, d) => sum + d.length, 0);
  logger.info(`合計: ${totalRows} 行`);

  const allData = dataSegments.flat();
  const merged = [headerLine, ...allData].join('\r\n');

  let outBuf: Buffer;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const iconv = require('iconv-lite') as typeof import('iconv-lite');
    outBuf = iconv.encode(merged, 'shift-jis');
  } catch {
    logger.warn('iconv-lite が使えないため UTF-8 で一時ファイルを保存します');
    outBuf = Buffer.from(merged, 'utf-8');
    const tmpUtf = path.join(os.tmpdir(), `merged_csv_${Date.now()}.csv`);
    fs.writeFileSync(tmpUtf, outBuf);
    return tmpUtf;
  }

  const tmpPath = path.join(os.tmpdir(), `merged_csv_${Date.now()}.csv`);
  fs.writeFileSync(tmpPath, outBuf);
  logger.info(`結合 CSV: ${tmpPath}（${allData.length + 1} 行）`);
  return tmpPath;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.csvFiles.length < 2) {
    logger.error('--csv1 と --csv2 の両方を指定してください（--csv3 は省略可）');
    logger.error('例: npx tsx src/scripts/check-taniyama-missing.ts --csv1=<前半.csv> --csv2=<後半.csv>');
    process.exit(1);
  }

  for (const p of args.csvFiles) {
    if (!fs.existsSync(p)) {
      logger.error(`CSV ファイルが見つかりません: ${p}`);
      process.exit(1);
    }
  }

  const config = loadConfig();
  const taniyama = config.sheets.locations.find(l => l.name === args.location);
  if (!taniyama) {
    const names = config.sheets.locations.map(l => l.name).join(', ');
    logger.error(`設定に「${args.location}」が見つかりません。使用可能: ${names}`);
    process.exit(1);
  }

  const month = args.month;
  const tab = `${month.substring(0, 4)}年${month.substring(4, 6)}月`;

  logger.info('========================================');
  logger.info(`  ${args.location} 転記漏れチェック`);
  logger.info(`  対象月: ${tab}`);
  args.csvFiles.forEach((f, i) => logger.info(`  CSV${i + 1}: ${path.basename(f)}`));
  logger.info(`  Sheet: ${taniyama.sheetId}`);
  logger.info('========================================');

  // CSV を結合（2〜3 ファイル対応）
  const mergedCsvPath = mergeCsvFiles(args.csvFiles);

  const sheets = new SpreadsheetService(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || config.sheets.serviceAccountKeyPath,
  );

  const reconciliation = new ReconciliationService(sheets);
  let result: Awaited<ReturnType<typeof reconciliation.reconcile>> | null = null;

  try {
    result = await reconciliation.reconcile(mergedCsvPath, taniyama.sheetId, tab);
  } finally {
    if (fs.existsSync(mergedCsvPath)) {
      fs.unlinkSync(mergedCsvPath);
      logger.debug(`一時ファイル削除: ${mergedCsvPath}`);
    }
  }

  logger.info('');
  logger.info('========================================');
  logger.info('  突合結果');
  logger.info(`  Sheets 転記済み: ${result.sheetsTotal} 件`);
  logger.info(`  Kanamic CSV:    ${result.hamTotal} 件`);
  logger.info(`  マッチ:          ${result.matched} 件`);
  logger.info('========================================');

  // ── 名前の外字・異体字による疑似不一致を検出 ──
  // Sheets→HAM欠落 と HAM余剰 の間で「日付+時刻が一致するが患者名が異なる」ペアを検出
  const nameVariantPairs: Array<{
    sheets: (typeof result.missingFromHam)[0];
    ham: (typeof result.extraInHam)[0];
  }> = [];
  const realMissing: typeof result.missingFromHam = [];

  // 日付形式を統一（YYYY/MM/DD）してから比較
  const normD = (d: string) => d.replace(/-/g, '/');

  /**
   * 患者名が「漢字異体字による差異」の可能性があるか判定
   * - スペース除去後の名前を比較
   * - 文字数が同じで共通文字が多い場合（または先頭2文字が一致）を名前差異とみなす
   */
  const isLikelyNameVariant = (sheetsName: string, hamName: string): boolean => {
    const normName = (n: string) => n.normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '').trim();
    const sn = normName(sheetsName);
    const hn = normName(hamName);
    if (sn === hn) return true;
    // 文字数が大きく違う場合は別人
    if (Math.abs(sn.length - hn.length) > 1) return false;
    // 共通文字率で判定（髙/高、德/徳 などの変体字は1文字だけ異なる）
    const charSet = new Set(sn);
    const commonChars = [...hn].filter(c => charSet.has(c)).length;
    const similarity = commonChars / Math.max(sn.length, hn.length);
    // 2文字以上の名前で70%以上一致 → 同一人物の変体字差異とみなす
    return sn.length >= 2 && similarity >= 0.7;
  };

  for (const miss of result.missingFromHam) {
    // 同一日付+開始時刻の HAM余剰レコードを探す（日付形式を正規化して比較）
    const candidate = result.extraInHam.find(
      e => normD(e.visitDate) === normD(miss.visitDate)
        && e.startTime === miss.startTime
        && isLikelyNameVariant(miss.patientName, e.patientName)
    );
    if (candidate) {
      nameVariantPairs.push({ sheets: miss, ham: candidate });
    } else {
      realMissing.push(miss);
    }
  }

  if (nameVariantPairs.length > 0) {
    logger.warn(`⚠️  患者名の漢字差異による疑似不一致: ${nameVariantPairs.length} 件`);
    logger.warn('   （同日時で Sheets と Kanamic の患者名漢字が異なる → 同一人物の可能性）');
    for (const { sheets: s, ham: h } of nameVariantPairs) {
      logger.warn(`  ${s.visitDate} ${s.startTime}  Sheets:「${s.patientName}」↔ Kanamic:「${h.patientName}」`);
    }
    logger.warn('');
  }

  if (realMissing.length === 0) {
    logger.info('✅ 実質的な転記漏れなし（名字差異を除くと全件マッチ）');
  } else {
    logger.warn(`🚨 転記漏れ（要確認）: ${realMissing.length} 件`);
    logger.warn('   Sheets「転記済み」だが Kanamic に対応レコードなし:');
    const sorted = [...realMissing].sort((a, b) => {
      const d = a.visitDate.localeCompare(b.visitDate);
      return d !== 0 ? d : a.startTime.localeCompare(b.startTime);
    });
    for (const r of sorted) {
      logger.warn(`  ${r.visitDate} ${r.startTime}-${r.endTime}  ${r.patientName}  ${r.staffName}  [${r.serviceType}]`);
    }
  }

  // HAM にしかない（Sheets にも名前差異ペアにも属さない）レコード
  // HAM の余剰から「名前差異ペアに使われた」レコードを除外（日付正規化して比較）
  const pairedHamKeys = new Set(
    nameVariantPairs.map(p => `${normD(p.ham.visitDate)}|${p.ham.startTime}|${p.ham.patientName}`)
  );
  const onlyInHam = result.extraInHam.filter(
    e => !pairedHamKeys.has(`${normD(e.visitDate)}|${e.startTime}|${e.patientName}`)
      && !e.patientName.includes('(非表示)')
  );
  if (onlyInHam.length > 0) {
    logger.info('');
    logger.info(`ℹ️  Kanamic のみ存在（Sheets に対応なし）: ${onlyInHam.length} 件`);
    for (const e of onlyInHam) {
      logger.info(`  ${e.visitDate} ${e.startTime}-${e.endTime}  ${e.patientName}  ${e.staffName}  [${e.serviceType}]`);
    }
  }

  if (realMissing.length > 0) process.exit(1);
}


main().catch(err => {
  logger.error(`エラー: ${(err as Error).message}`);
  process.exit(1);
});
