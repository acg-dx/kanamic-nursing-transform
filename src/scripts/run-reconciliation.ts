/**
 * 予実突合（Reconciliation）実行スクリプト
 *
 * HAM の 8-1 スケジュールデータ出力 CSV をダウンロードし、
 * Google Sheets の転記レコードと突合して差異レポートを出力する。
 *
 * 突合内容:
 *   1. Sheets で「転記済み」なのに HAM にない → 転記漏れ
 *   2. HAM にあるが Sheets にない → 手動追加 or 二重登録
 *   3. 資格不一致（准看護師が看護師として登録されている）
 *   4. 前月未登録レコードの有無
 *
 * 使用方法:
 *   npx tsx src/scripts/run-reconciliation.ts                        # 当月の突合（8-1 CSV 自動ダウンロード）
 *   npx tsx src/scripts/run-reconciliation.ts --month=202602         # 指定月の突合
 *   npx tsx src/scripts/run-reconciliation.ts --csv=./schedule.csv   # ローカル CSV を使用
 *   npx tsx src/scripts/run-reconciliation.ts --skip-download        # CSV ダウンロードスキップ（ローカルのみ）
 *   npx tsx src/scripts/run-reconciliation.ts --check-prev-only      # 前月未登録チェックのみ
 */
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import fs from 'fs';
import { logger } from '../core/logger';

// Ctrl+C で即座に終了
process.on('SIGINT', () => {
  logger.warn('SIGINT 受信 — 強制終了します');
  process.exit(130);
});

import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { ScheduleCsvDownloaderService } from '../services/schedule-csv-downloader.service';
import { ReconciliationService } from '../services/reconciliation.service';
import { SmartHRService } from '../services/smarthr.service';

/** 姶良事業所 Sheet ID */
const AIRA_SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';

interface CliArgs {
  /** 対象年月 (YYYYMM 形式) */
  month: string;
  /** ローカル CSV パス（明示指定） */
  csvPath?: string;
  /** CSV ダウンロードスキップ */
  skipDownload: boolean;
  /** 前月未登録チェックのみ */
  checkPrevOnly: boolean;
  /** 出力ファイルパス */
  output?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const monthArg = args.find(a => a.startsWith('--month='))?.split('=')[1];
  const csvArg = args.find(a => a.startsWith('--csv='))?.split('=')[1];
  const outputArg = args.find(a => a.startsWith('--output='))?.split('=')[1];
  const skipDownload = args.includes('--skip-download');
  const checkPrevOnly = args.includes('--check-prev-only');

  return {
    month: monthArg || ScheduleCsvDownloaderService.getCurrentMonth(),
    csvPath: csvArg,
    skipDownload,
    checkPrevOnly,
    output: outputArg,
  };
}

/**
 * 当月タブ名を返す（形式: "2026年03月"）
 */
function getMonthTab(yyyymm: string): string {
  const year = yyyymm.substring(0, 4);
  const month = yyyymm.substring(4, 6);
  return `${year}年${month}月`;
}

async function main(): Promise<void> {
  const cliArgs = parseArgs();

  logger.info('========================================');
  logger.info('  予実突合（Reconciliation）');
  logger.info(`  事業所: 姶良`);
  logger.info(`  Sheet ID: ${AIRA_SHEET_ID}`);
  logger.info(`  対象月: ${cliArgs.month}`);
  if (cliArgs.csvPath) logger.info(`  CSV: ${cliArgs.csvPath}`);
  if (cliArgs.skipDownload) logger.info(`  ダウンロードスキップ: true`);
  if (cliArgs.checkPrevOnly) logger.info(`  前月チェックのみ: true`);
  logger.info('========================================');

  // 環境変数チェック（前月チェックのみの場合は HAM 不要）
  const kanamickUrl = process.env.KANAMICK_URL;
  const kanamickUser = process.env.KANAMICK_USERNAME;
  const kanamickPass = process.env.KANAMICK_PASSWORD;

  const needsHam = !cliArgs.checkPrevOnly && !cliArgs.csvPath && !cliArgs.skipDownload;
  if (needsHam && (!kanamickUrl || !kanamickUser || !kanamickPass)) {
    logger.error('KANAMICK_URL, KANAMICK_USERNAME, KANAMICK_PASSWORD が必要です');
    process.exit(1);
  }

  // サービス初期化
  const sheets = new SpreadsheetService(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json',
  );
  const reconciliation = new ReconciliationService(sheets);

  // === Step 1: 前月未登録チェック ===
  logger.info('--- 前月未登録チェック ---');
  const prevResult = await reconciliation.checkPreviousMonthUnregistered(AIRA_SHEET_ID);

  if (prevResult.hasPending) {
    logger.warn(`前月に未登録レコード ${prevResult.pendingCount} 件を検出！`);
    logger.warn('当月の転記前に前月分を処理してください。');
  } else {
    logger.info('前月未登録レコードなし');
  }

  if (cliArgs.checkPrevOnly) {
    // 前月チェックのみの場合はここで終了
    if (prevResult.hasPending) {
      logger.info('');
      logger.info('--- 前月未登録レコード一覧 ---');
      for (const r of prevResult.pendingRecords) {
        logger.info(`  ${r.recordId}: ${r.patientName} (${r.visitDate}) ${r.staffName} [${r.transcriptionFlag || '未転記'}]`);
      }
    }
    process.exit(prevResult.hasPending ? 1 : 0);
  }

  // === Step 2: 8-1 CSV の取得 ===
  let csvPath: string;

  if (cliArgs.csvPath) {
    // ローカル CSV 指定
    csvPath = path.resolve(cliArgs.csvPath);
    if (!fs.existsSync(csvPath)) {
      logger.error(`CSV ファイルが見つかりません: ${csvPath}`);
      process.exit(1);
    }
    logger.info(`CSV: ローカルファイル使用 → ${csvPath}`);
  } else if (cliArgs.skipDownload) {
    // ダウンロードスキップ → ローカルキャッシュから検索
    const downloader = new ScheduleCsvDownloaderService(null as unknown as KanamickAuthService);
    const localCsv = downloader.findLocalCsv(cliArgs.month);
    if (!localCsv) {
      logger.error(`ローカルに ${cliArgs.month} の 8-1 CSV が見つかりません。--csv= で指定するか、--skip-download を外してください`);
      process.exit(1);
    }
    csvPath = localCsv;
    logger.info(`CSV: ローカルキャッシュ使用 → ${csvPath}`);
  } else {
    // HAM から自動ダウンロード
    logger.info('8-1 CSV を HAM からダウンロード中...');

    const aiHealing = new AIHealingService(
      process.env.OPENAI_API_KEY || '',
      process.env.AI_HEALING_MODEL || 'gpt-4o',
    );
    const selectorEngine = new SelectorEngine(aiHealing);
    const browser = new BrowserManager(selectorEngine);
    const auth = new KanamickAuthService({
      url: kanamickUrl!,
      username: kanamickUser!,
      password: kanamickPass!,
      stationName: process.env.KANAMICK_STATION_NAME || '訪問看護ステーションあおぞら姶良',
      hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
      hamOfficeCode: process.env.KANAMICK_HAM_OFFICE_CODE || '400021814',
    });

    try {
      await browser.launch();
      auth.setContext(browser.browserContext);
      await auth.login();

      const csvDownloader = new ScheduleCsvDownloaderService(auth);
      csvPath = await csvDownloader.ensureScheduleCsv({
        targetMonth: cliArgs.month,
      });
      logger.info(`CSV: ダウンロード完了 → ${csvPath}`);
    } catch (error) {
      logger.error(`8-1 CSV ダウンロード失敗: ${(error as Error).message}`);
      process.exit(1);
    } finally {
      await browser.close();
    }
  }

  // === Step 2.5: SmartHR 資格情報の取得 ===
  logger.info('--- SmartHR 資格情報を取得中 ---');
  const smarthrAccessToken = process.env.SMARTHR_ACCESS_TOKEN;
  if (!smarthrAccessToken) {
    logger.warn('SMARTHR_ACCESS_TOKEN が設定されていません。CSV ベースの准看護師検出にフォールバック');
  } else {
    try {
      const smarthr = new SmartHRService({
        baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
        accessToken: smarthrAccessToken,
      });

      const allCrews = await smarthr.getAllCrews();
      const staffQualMap = new Map<string, string>();

      for (const crew of allCrews) {
        const quals = smarthr.getQualifications(crew);
        const hasKangoshi = quals.some(q => q === '看護師' || q === '正看護師');
        const hasJun = quals.some(q => q === '准看護師');

        // 看護師 > 准看護師 優先ルール
        const actual = hasKangoshi ? '看護師' : (hasJun ? '准看護師' : null);
        if (actual) {
          const legalName = `${crew.last_name}${crew.first_name}`.normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '').trim();
          const businessName = crew.business_last_name
            ? `${crew.business_last_name}${crew.business_first_name || ''}`.normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '').trim()
            : '';

          if (legalName) staffQualMap.set(legalName, actual);
          if (businessName && businessName !== legalName) staffQualMap.set(businessName, actual);
        }
      }

      reconciliation.setStaffQualifications(staffQualMap);
      logger.info(`SmartHR 資格マップ設定完了: ${staffQualMap.size} 名分の資格情報`);
    } catch (error) {
      logger.warn(`SmartHR 資格情報取得失敗: ${(error as Error).message}。CSV ベースの准看護師検出にフォールバック`);
    }
  }

  // === Step 3: 突合実行 ===
  const tab = getMonthTab(cliArgs.month);
  logger.info(`--- 突合実行: ${tab} ---`);

  const result = await reconciliation.reconcile(csvPath, AIRA_SHEET_ID, tab);
  result.previousMonthPending = prevResult;

  // === Step 4: レポート出力 ===
  const report = reconciliation.formatReport(result);
  logger.info('');
  logger.info(report);

  // ファイル出力（--output= 指定時）
  if (cliArgs.output) {
    const outputPath = path.resolve(cliArgs.output);
    fs.writeFileSync(outputPath, report, 'utf-8');
    logger.info(`レポート出力: ${outputPath}`);
  }

  // 結果サマリー
  logger.info('');
  logger.info('========================================');
  logger.info('  突合結果サマリー');
  logger.info(`  Sheets 転記済み: ${result.sheetsTotal} 件`);
  logger.info(`  HAM 8-1 CSV: ${result.hamTotal} 件`);
  logger.info(`  マッチ: ${result.matched} 件`);
  logger.info(`  Sheets→HAM 欠落: ${result.missingFromHam.length} 件`);
  logger.info(`  HAM 余剰: ${result.extraInHam.length} 件`);
  logger.info(`  資格不一致: ${result.qualificationMismatches.length} 件`);
  if (prevResult.hasPending) {
    logger.info(`  前月未登録: ${prevResult.pendingCount} 件`);
  }
  logger.info('========================================');

  // 差異がある場合は exit code 1
  const hasDiff = result.missingFromHam.length > 0
    || result.extraInHam.length > 0
    || result.qualificationMismatches.length > 0
    || prevResult.hasPending;

  if (hasDiff) {
    process.exit(1);
  }
}

main().catch(error => {
  logger.error(`致命的エラー: ${(error as Error).message}`);
  process.exit(1);
});
