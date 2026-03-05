/**
 * 特定スタッフをSmartHR経由でHAMに登録するスクリプト
 *
 * emp_code を指定して、SmartHRから情報を取得し、TRITRUS + HAMに登録する。
 * 部署フィルタなしで直接 emp_code で検索するため、
 * run-staff-sync.ts の部署フィルタで漏れるスタッフにも対応可能。
 *
 * 使用方法:
 *   npx tsx src/scripts/register-specific-staff.ts --emp-code=1248
 *   npx tsx src/scripts/register-specific-staff.ts --emp-code=1248 --dry-run
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
  const args = process.argv.slice(2);
  const empCodeArg = args.find(a => a.startsWith('--emp-code='))?.split('=')[1];
  const dryRun = args.includes('--dry-run');

  if (!empCodeArg) {
    logger.error('使用方法: npx tsx src/scripts/register-specific-staff.ts --emp-code=1248');
    process.exit(1);
  }

  logger.info('========================================');
  logger.info('  特定スタッフ登録');
  logger.info(`  従業員番号: ${empCodeArg}`);
  logger.info(`  ドライラン: ${dryRun}`);
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

  // Step 1: SmartHR で検索
  logger.info(`SmartHR で emp_code=${empCodeArg} を検索中...`);
  const crew = await smarthr.getCrewByEmpCode(empCodeArg);

  if (!crew) {
    logger.error(`SmartHR に emp_code=${empCodeArg} が見つかりません`);
    process.exit(1);
  }

  const entry = smarthr.toStaffMasterEntry(crew);
  logger.info(`  氏名: ${entry.staffName}`);
  logger.info(`  ヨミ: ${entry.staffNameYomi}`);
  logger.info(`  性別: ${entry.gender}`);
  logger.info(`  資格: [${entry.qualifications.join(', ')}]`);
  logger.info(`  部署: ${entry.departmentName}`);
  logger.info(`  入社: ${entry.enteredAt}`);
  logger.info(`  退職: ${entry.resignedAt || '在職中'}`);

  if (dryRun) {
    logger.info('[DRY RUN] SmartHR 情報確認のみ。HAM 操作は行いません。');
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

    // StaffSync で登録 (Phase 1 → 2 → 3)
    const staffSync = new StaffSyncService(smarthr, auth);
    logger.info(`TRITRUS + HAM に登録開始: ${entry.staffName} (${empCodeArg})`);

    const result = await staffSync.registerSpecificStaff([entry]);

    // 結果レポート
    logger.info('========================================');
    logger.info('  登録結果');
    logger.info(`  登録: ${result.synced}`);
    logger.info(`  スキップ: ${result.skipped}`);
    logger.info(`  エラー: ${result.errors}`);
    logger.info('========================================');

    if (result.details && result.details.length > 0) {
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
    logger.error(`スタッフ登録異常終了: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  logger.error(`致命的エラー: ${(error as Error).message}`);
  process.exit(1);
});
