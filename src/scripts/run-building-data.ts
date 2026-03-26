/**
 * 同一建物管理 データ取得スクリプト
 *
 * Kintone App 197 + 共同生活援助スプレッドシートからデータを取得し、
 * 連携スプレッドシートの月度タブに書き込む。
 *
 * 使用方法:
 *   npx tsx src/scripts/run-building-data.ts                  # 前月データを取得・書き込み
 *   npx tsx src/scripts/run-building-data.ts --month=2026-02  # 指定月のデータを取得
 *   npx tsx src/scripts/run-building-data.ts --dry-run        # 書き込みせずに結果を表示
 *   npx tsx src/scripts/run-building-data.ts --month=2026-02 --dry-run
 */
import dotenv from 'dotenv';
dotenv.config();

import { logger } from '../core/logger';
import { loadConfig } from '../config/app.config';
import { BuildingDataExtractionService } from '../services/building-data-extraction.service';

// Ctrl+C で即座に終了
process.on('SIGINT', () => {
  logger.warn('SIGINT 受信 — 強制終了します');
  process.exit(130);
});

function parseArgs() {
  const args = process.argv.slice(2);
  let month: string | undefined;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--month=')) {
      month = arg.slice('--month='.length);
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }
  return { month, dryRun };
}

/**
 * --month=2026-02 → { year: 2026, month: 2 }
 * 省略時は前月
 */
function resolveTargetMonth(monthArg?: string): { year: number; month: number } {
  if (monthArg) {
    const match = monthArg.match(/^(\d{4})-(\d{1,2})$/);
    if (!match) {
      throw new Error(`--month の形式が不正です: "${monthArg}" (期待: YYYY-MM, 例: 2026-02)`);
    }
    return { year: parseInt(match[1]), month: parseInt(match[2]) };
  }
  // デフォルト: 前月
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { year: prev.getFullYear(), month: prev.getMonth() + 1 };
}

async function main() {
  const { month: monthArg, dryRun } = parseArgs();
  const { year, month } = resolveTargetMonth(monthArg);
  const tab = `${year}/${String(month).padStart(2, '0')}`;

  logger.info(`同一建物管理データ取得 開始 (対象: ${tab}${dryRun ? ', DRY RUN' : ''})`);

  const config = loadConfig();

  // 環境変数チェック
  if (!config.kintone.baseUrl || !config.kintone.app197Token) {
    throw new Error('Kintone 環境変数が未設定です (KINTONE_BASE_URL, KINTONE_APP_197_TOKEN)');
  }
  if (!config.sheets.ghSheetIdKagoshima) {
    throw new Error('GH鹿児島スプレッドシートIDが未設定です (GH_SHEET_ID_KAGOSHIMA)');
  }
  if (!config.sheets.ghSheetIdFukuoka) {
    throw new Error('GH福岡スプレッドシートIDが未設定です (GH_SHEET_ID_FUKUOKA)');
  }

  // 転記用事業所シート → 訪問看護利用実績の取得元
  // 全4事業所を使用（RUN_LOCATIONS フィルタは適用しない — 全事業所の訪問看護記録が必要）
  const nursingSheetLocations = [
    { name: '谷山', sheetId: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8', officeName: '訪問看護ステーションあおぞら谷山' },
    { name: '荒田', sheetId: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4', officeName: '訪問看護ステーションあおぞら荒田' },
    { name: '博多', sheetId: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg', officeName: '訪問看護ステーションあおぞら博多' },
    { name: '姶良', sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M', officeName: '訪問看護ステーションあおぞら姶良' },
  ];

  const service = new BuildingDataExtractionService({
    kintone: {
      baseUrl: config.kintone.baseUrl,
      appId: 197,
      apiToken: config.kintone.app197Token,
    },
    ghSheetIdKagoshima: config.sheets.ghSheetIdKagoshima,
    ghSheetIdFukuoka: config.sheets.ghSheetIdFukuoka,
    buildingMgmtSheetId: config.sheets.buildingMgmtSheetId,
    serviceAccountKeyPath: config.sheets.serviceAccountKeyPath,
    nursingSheetLocations,
  });

  const result = await service.extract(year, month, dryRun);

  // 結果サマリー
  logger.info('─────────────────────────────────────');
  logger.info(`対象月:       ${result.tab}`);
  logger.info(`総レコード:   ${result.totalRecords} 件`);
  logger.info(`  Kintone:    ${result.kintoneRecords} 件 (非GH)`);
  logger.info(`  GH:         ${result.ghRecords} 件`);
  logger.info(`  訪問看護なし除外: ${result.filteredByNursing} 件`);
  logger.info(`新規:         ${result.newRecords} 件`);
  if (result.unmappedFacilities.length > 0) {
    logger.warn(`マッピング不能: ${result.unmappedFacilities.join(', ')}`);
  }
  logger.info('─────────────────────────────────────');

  if (dryRun) {
    logger.info('[DRY RUN] シートへの書き込みは行っていません。');
  }
}

main().catch(error => {
  logger.error(`致命的エラー: ${error.message}`);
  logger.error(error.stack);
  process.exit(1);
});
