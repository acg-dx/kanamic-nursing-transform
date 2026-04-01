/**
 * 予実突合（Reconciliation）実行スクリプト
 *
 * HAM の 8-1 スケジュールデータ出力 CSV をダウンロードし、
 * Google Sheets の転記レコードと突合して差異レポートを出力する。
 *
 * 全事業所を順番に処理し、汇总レポートを出力する。
 *
 * 突合内容:
 *   1. Sheets で「転記済み」なのに HAM にない → 転記漏れ
 *   2. HAM にあるが Sheets にない → 手動追加 or 二重登録
 *   3. 資格不一致（准看護師が看護師として登録されている）
 *   4. 前月未登録レコードの有無
 *
 * 使用方法:
 *   npx tsx src/scripts/run-reconciliation.ts                        # 当月の突合（全事業所、8-1 CSV 自動ダウンロード）
 *   npx tsx src/scripts/run-reconciliation.ts --month=202603         # 指定月の突合
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

import { loadConfig } from '../config/app.config';
import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { ScheduleCsvDownloaderService } from '../services/schedule-csv-downloader.service';
import { ReconciliationService, type ReconciliationResult } from '../services/reconciliation.service';
import { SmartHRService } from '../services/smarthr.service';

interface CliArgs {
  month: string;
  skipDownload: boolean;
  checkPrevOnly: boolean;
  output?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const monthArg = args.find(a => a.startsWith('--month='))?.split('=')[1];
  const outputArg = args.find(a => a.startsWith('--output='))?.split('=')[1];
  const skipDownload = args.includes('--skip-download');
  const checkPrevOnly = args.includes('--check-prev-only');

  return {
    month: monthArg || ScheduleCsvDownloaderService.getCurrentMonth(),
    skipDownload,
    checkPrevOnly,
    output: outputArg,
  };
}

function getMonthTab(yyyymm: string): string {
  const year = yyyymm.substring(0, 4);
  const month = yyyymm.substring(4, 6);
  return `${year}年${month}月`;
}

async function main(): Promise<void> {
  const cliArgs = parseArgs();
  const config = loadConfig();
  const locations = config.sheets.locations;

  logger.info('========================================');
  logger.info('  予実突合（Reconciliation）— 全事業所');
  logger.info(`  対象事業所: ${locations.map(l => l.name).join(', ')}`);
  logger.info(`  対象月: ${cliArgs.month}`);
  if (cliArgs.skipDownload) logger.info('  ダウンロードスキップ: true');
  if (cliArgs.checkPrevOnly) logger.info('  前月チェックのみ: true');
  logger.info('========================================');

  const kanamickUrl = process.env.KANAMICK_URL || config.kanamick.url;
  const kanamickUser = process.env.KANAMICK_USERNAME || config.kanamick.username;
  const kanamickPass = process.env.KANAMICK_PASSWORD || config.kanamick.password;

  const needsHam = !cliArgs.checkPrevOnly && !cliArgs.skipDownload;
  if (needsHam && (!kanamickUrl || !kanamickUser || !kanamickPass)) {
    logger.error('KANAMICK_URL, KANAMICK_USERNAME, KANAMICK_PASSWORD が必要です');
    process.exit(1);
  }

  const sheets = new SpreadsheetService(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || config.sheets.serviceAccountKeyPath,
  );

  // SmartHR 資格マップ（全事業所共通）
  let staffQualMap: Map<string, string> | null = null;
  const smarthrAccessToken = process.env.SMARTHR_ACCESS_TOKEN;
  if (smarthrAccessToken) {
    try {
      const smarthr = new SmartHRService({
        baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
        accessToken: smarthrAccessToken,
      });
      const allCrews = await smarthr.getAllCrews();
      staffQualMap = new Map();
      for (const crew of allCrews) {
        const quals = smarthr.getQualifications(crew);
        const hasKangoshi = quals.some(q => q === '看護師' || q === '正看護師');
        const hasJun = quals.some(q => q === '准看護師');
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
      logger.info(`SmartHR 資格マップ: ${staffQualMap.size} 名分`);
    } catch (error) {
      logger.warn(`SmartHR 資格情報取得失敗: ${(error as Error).message}`);
    }
  }

  // === 前月チェックのみモード ===
  if (cliArgs.checkPrevOnly) {
    let hasDiff = false;
    for (const loc of locations) {
      logger.info(`--- [${loc.name}] 前月未登録チェック ---`);
      const reconciliation = new ReconciliationService(sheets);
      const prevResult = await reconciliation.checkPreviousMonthUnregistered(loc.sheetId);
      if (prevResult.hasPending) {
        hasDiff = true;
        for (const r of prevResult.pendingRecords) {
          logger.info(`  ${r.recordId}: ${r.patientName} (${r.visitDate}) ${r.staffName} [${r.transcriptionFlag || '未転記'}]`);
        }
      }
    }
    process.exit(hasDiff ? 1 : 0);
  }

  // === ブラウザ初期化（8-1 CSV ダウンロード用） ===
  let browser: BrowserManager | null = null;
  if (needsHam) {
    const aiHealing = new AIHealingService(
      process.env.OPENAI_API_KEY || '',
      process.env.AI_HEALING_MODEL || 'gpt-4o',
    );
    const selectorEngine = new SelectorEngine(aiHealing);
    browser = new BrowserManager(selectorEngine);
    await browser.launch();
  }

  const tab = getMonthTab(cliArgs.month);
  const allResults: Array<{ name: string; result: ReconciliationResult }> = [];

  try {
    // === 各事業所を順番に処理 ===
    for (const loc of locations) {
      logger.info('');
      logger.info(`========== [${loc.name}] 突合開始 ==========`);

      const reconciliation = new ReconciliationService(sheets);
      if (staffQualMap) {
        reconciliation.setStaffQualifications(staffQualMap);
      }

      // 前月チェック
      const prevResult = await reconciliation.checkPreviousMonthUnregistered(loc.sheetId);
      if (prevResult.hasPending) {
        logger.warn(`[${loc.name}] 前月未登録: ${prevResult.pendingCount} 件`);
      }

      // 8-1 CSV 取得
      let csvPath: string | null = null;

      if (cliArgs.skipDownload) {
        // ローカルキャッシュから検索（事業所コード付き or 汎用）
        const downloader = new ScheduleCsvDownloaderService(null as unknown as KanamickAuthService);
        csvPath = downloader.findLocalCsv(cliArgs.month);
        if (!csvPath) {
          logger.warn(`[${loc.name}] ローカルに ${cliArgs.month} の 8-1 CSV なし → スキップ`);
          continue;
        }
        logger.info(`[${loc.name}] CSV: ローカルキャッシュ → ${csvPath}`);
      } else if (browser) {
        // HAM からダウンロード
        const auth = new KanamickAuthService({
          url: kanamickUrl,
          username: kanamickUser,
          password: kanamickPass,
          stationName: loc.stationName,
          hamOfficeKey: '6',
          hamOfficeCode: loc.hamOfficeCode,
        });
        auth.setContext(browser.browserContext, browser);
        await auth.login();

        const csvDownloader = new ScheduleCsvDownloaderService(auth);
        try {
          csvPath = await csvDownloader.ensureScheduleCsv({
            targetMonth: cliArgs.month,
            force: true, // 事業所ごとに新規ダウンロード
          });
          logger.info(`[${loc.name}] CSV: ダウンロード完了 → ${csvPath}`);
        } catch (error) {
          logger.error(`[${loc.name}] 8-1 CSV ダウンロード失敗: ${(error as Error).message}`);
          continue;
        }
      }

      if (!csvPath) {
        logger.warn(`[${loc.name}] CSV なし → スキップ`);
        continue;
      }

      // 突合実行
      const result = await reconciliation.reconcile(csvPath, loc.sheetId, tab);
      result.previousMonthPending = prevResult;
      allResults.push({ name: loc.name, result });

      // 据点レポート
      const report = reconciliation.formatReport(result);
      logger.info(`\n[${loc.name}] ${report}`);
    }
  } finally {
    if (browser) await browser.close();
  }

  // === 汇总レポート ===
  logger.info('');
  logger.info('========================================');
  logger.info('  全事業所 突合結果サマリー');
  logger.info('========================================');

  let totalMissing = 0;
  let totalExtra = 0;
  let totalQualMismatch = 0;
  let totalPrevPending = 0;

  for (const { name, result } of allResults) {
    const missing = result.missingFromHam.length;
    const extra = result.extraInHam.length;
    const qual = result.qualificationMismatches.length;
    const prev = result.previousMonthPending?.pendingCount || 0;
    totalMissing += missing;
    totalExtra += extra;
    totalQualMismatch += qual;
    totalPrevPending += prev;

    const status = (missing + extra + qual + prev) === 0 ? '✓' : '⚠';
    logger.info(
      `  ${status} ${name}: マッチ=${result.matched}, 欠落=${missing}, 余剰=${extra}, 資格不一致=${qual}` +
      (prev > 0 ? `, 前月未登録=${prev}` : ''),
    );
  }

  logger.info('');
  logger.info(`  合計: 欠落=${totalMissing}, 余剰=${totalExtra}, 資格不一致=${totalQualMismatch}, 前月未登録=${totalPrevPending}`);
  logger.info('========================================');

  // ファイル出力
  if (cliArgs.output) {
    const lines: string[] = ['=== 全事業所 突合レポート ===', ''];
    for (const { name, result } of allResults) {
      const reconciliation = new ReconciliationService(sheets);
      lines.push(`--- ${name} ---`);
      lines.push(reconciliation.formatReport(result));
      lines.push('');
    }
    const outputPath = path.resolve(cliArgs.output);
    fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
    logger.info(`レポート出力: ${outputPath}`);
  }

  const hasDiff = totalMissing + totalExtra + totalQualMismatch + totalPrevPending > 0;
  if (hasDiff) process.exit(1);
}

main().catch(error => {
  logger.error(`致命的エラー: ${(error as Error).message}`);
  process.exit(1);
});
