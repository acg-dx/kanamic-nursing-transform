/**
 * スタッフ同期実行スクリプト
 *
 * SmartHR から姶良の職員データを取得し、HAM に登録する。
 *
 * Phase 1: h1-1 スタッフマスタに職員を新規登録（既存はスキップ）
 * Phase 2: h1-1 スタッフの資格チェックボックスを設定
 *
 * 使用方法:
 *   npx tsx src/scripts/run-staff-sync.ts
 *   npx tsx src/scripts/run-staff-sync.ts --department=姶良
 *   npx tsx src/scripts/run-staff-sync.ts --limit=1
 *   npx tsx src/scripts/run-staff-sync.ts --dry-run
 */
import dotenv from 'dotenv';
dotenv.config();

import { logger } from '../core/logger';
import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { SmartHRService } from '../services/smarthr.service';
import { StaffSyncService } from '../workflows/staff-sync/staff-sync.workflow';

async function main(): Promise<void> {
  // コマンドライン引数
  const args = process.argv.slice(2);
  const departmentArg = args.find(a => a.startsWith('--department='))?.split('=')[1] || '姶良';
  const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? parseInt(limitArg, 10) : undefined;
  const offsetArg = args.find(a => a.startsWith('--offset='))?.split('=')[1];
  const offset = offsetArg ? parseInt(offsetArg, 10) : undefined;
  const dryRun = args.includes('--dry-run');
  const phase3Only = args.includes('--phase3-only');

  logger.info('========================================');
  logger.info('  スタッフ同期実行');
  logger.info(`  部署フィルタ: ${departmentArg}`);
  if (offset) logger.info(`  スキップ: 先頭${offset}名`);
  if (limit) logger.info(`  処理上限: ${limit}名`);
  logger.info(`  ドライラン: ${dryRun}`);
  if (phase3Only) logger.info('  モード: Phase3 のみ（HAM 資格登録）');
  logger.info('========================================');

  // SmartHR 設定チェック
  const smarthrToken = process.env.SMARTHR_ACCESS_TOKEN;
  if (!smarthrToken) {
    logger.error('SMARTHR_ACCESS_TOKEN が設定されていません');
    process.exit(1);
  }

  const smarthr = new SmartHRService({
    baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
    accessToken: smarthrToken,
  });

  if (dryRun) {
    // ドライラン: SmartHR からデータ取得のみ
    logger.info('[DRY RUN] SmartHR からスタッフデータを取得します（HAM 操作なし）');
    const allCrews = await smarthr.getAllCrews();
    const activeCrews = smarthr.filterActive(allCrews);
    const filtered = smarthr.filterByDepartment(activeCrews, departmentArg);
    const staffEntries = filtered.map(c => smarthr.toStaffMasterEntry(c));

    logger.info(`SmartHR 全体: ${allCrews.length}名`);
    logger.info(`在籍中: ${activeCrews.length}名`);
    logger.info(`${departmentArg}: ${filtered.length}名`);
    logger.info('--- スタッフ一覧 ---');
    for (const staff of staffEntries) {
      logger.info(
        `  ${staff.staffNumber} | ${staff.staffName} | ${staff.staffNameYomi} | ` +
        `資格: [${staff.qualifications.join(', ')}]`
      );
    }
    logger.info('--- ドライラン完了 ---');
    return;
  }

  // Kanamick 設定チェック
  const kanamickUrl = process.env.KANAMICK_URL;
  const kanamickUser = process.env.KANAMICK_USERNAME;
  const kanamickPass = process.env.KANAMICK_PASSWORD;
  if (!kanamickUrl || !kanamickUser || !kanamickPass) {
    logger.error('KANAMICK_URL, KANAMICK_USERNAME, KANAMICK_PASSWORD が必要です');
    process.exit(1);
  }

  // サービス初期化
  const aiHealing = new AIHealingService(
    process.env.OPENAI_API_KEY || '',
    process.env.AI_HEALING_MODEL || 'gpt-4o'
  );
  const selectorEngine = new SelectorEngine(aiHealing);
  const browser = new BrowserManager(selectorEngine);
  const auth = new KanamickAuthService({
    url: kanamickUrl,
    username: kanamickUser,
    password: kanamickPass,
    stationName: process.env.KANAMICK_STATION_NAME || '訪問看護ステーションあおぞら姶良',
    hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
    hamOfficeCode: process.env.KANAMICK_HAM_OFFICE_CODE || '400021814',
  });

  try {
    // ブラウザ起動 + ログイン
    await browser.launch();
    auth.setContext(browser.browserContext);

    // スタッフ同期実行
    const staffSync = new StaffSyncService(smarthr, auth);
    const result = phase3Only
      ? await staffSync.syncPhase3Only(departmentArg, limit, offset)
      : await staffSync.syncStaff(departmentArg, limit, offset);

    // 結果レポート
    logger.info('========================================');
    logger.info('  スタッフ同期結果');
    logger.info(`  登録: ${result.synced}`);
    logger.info(`  スキップ: ${result.skipped}`);
    logger.info(`  エラー: ${result.errors}`);
    logger.info('========================================');

    if (result.details && result.details.length > 0) {
      logger.info('--- 詳細 ---');
      for (const d of result.details) {
        const status = d.phase1 === 'error' ? '❌' : d.phase1 === 'registered' ? '✅' : '⏭️';
        const p2 = d.phase2 === 'set' ? '✓' : d.phase2 === 'error' ? '✗' : '-';
        const detail = d as unknown as { phase3?: string };
        const p3 = detail.phase3 === 'set' ? '✓' : detail.phase3 === 'error' ? '✗' : '-';
        logger.info(`  ${status} ${d.staffNumber} ${d.staffName} [P1:${d.phase1}] [P2:${p2}] [P3:${p3}]${d.error ? ` Error: ${d.error}` : ''}`);
      }
    }

    if (result.errors > 0) {
      process.exit(1);
    }
  } catch (error) {
    logger.error(`スタッフ同期異常終了: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  logger.error(`致命的エラー: ${(error as Error).message}`);
  process.exit(1);
});
