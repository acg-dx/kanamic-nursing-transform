/**
 * TRITRUS 同一建物管理 施設一覧スクレイピング検証スクリプト
 *
 * ログインして施設一覧を取得し、連携シートの施設名とのマッチング精度を確認する。
 * 実機テスト前の事前確認用。
 *
 * 使用方法:
 *   npx tsx src/scripts/explore-premises.ts
 *   npx tsx src/scripts/explore-premises.ts --dump-dialog=7870   # 施設ID指定で弾窗内容をダンプ
 */
import dotenv from 'dotenv';
dotenv.config();

import { logger } from '../core/logger';
import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { PremisesNavigator } from '../core/premises-navigator';

// Ctrl+C で即座に終了
process.on('SIGINT', () => {
  logger.warn('SIGINT 受信 — 強制終了します');
  process.exit(130);
});

function parseArgs() {
  const args = process.argv.slice(2);
  let dumpDialogId: number | undefined;

  for (const arg of args) {
    if (arg.startsWith('--dump-dialog=')) {
      dumpDialogId = parseInt(arg.slice('--dump-dialog='.length));
    }
  }
  return { dumpDialogId };
}

async function main(): Promise<void> {
  const { dumpDialogId } = parseArgs();

  // 環境変数チェック
  const kanamickUrl = process.env.KANAMICK_URL;
  const kanamickUser = process.env.KANAMICK_USERNAME;
  const kanamickPass = process.env.KANAMICK_PASSWORD;
  if (!kanamickUrl || !kanamickUser || !kanamickPass) {
    logger.error('KANAMICK_URL, KANAMICK_USERNAME, KANAMICK_PASSWORD が必要です');
    process.exit(1);
  }

  const aiHealing = new AIHealingService(process.env.OPENAI_API_KEY || '', 'gpt-4o');
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
    await browser.launch();
    auth.setContext(browser.browserContext);

    // ログイン（TRITRUS ポータルのみ — HAM 不要）
    logger.info('TRITRUS ログイン中...');
    const tritrusPage = await auth.loginTritrusOnly();
    const premisesNav = new PremisesNavigator(tritrusPage);

    // 施設一覧取得
    await premisesNav.navigateToPremisesList();
    const mappings = await premisesNav.scrapePremisesMapping();

    console.log('\n=== TRITRUS 施設一覧 ===');
    console.log(`施設数: ${mappings.length}`);
    for (const m of mappings) {
      console.log(`  ${m.premisesId} | ${m.tritrusName}`);
    }

    // 連携シートの施設名と照合
    const buildingMgmtSheetId = process.env.BUILDING_MGMT_SHEET_ID
      || '18DueDsYPsNmePiYIp9hVpD1rIWWMCyPX5SdWzXOnZBY';
    const sheets = new SpreadsheetService(
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json',
    );

    // 前月タブ名
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const tab = `${prev.getFullYear()}/${String(prev.getMonth() + 1).padStart(2, '0')}`;

    const records = await sheets.getBuildingManagementRecords(buildingMgmtSheetId, tab);
    const sheetFacilityNames = [...new Set(records.map(r => r.facilityName))];

    console.log(`\n=== 連携シート施設名 (${tab}) ===`);
    for (const name of sheetFacilityNames) {
      console.log(`  ${name}`);
    }

    // マッチング結果
    const { matched, unmatched } = premisesNav.buildFacilityToPremisesMap(mappings, sheetFacilityNames);

    console.log(`\n=== マッチング結果 ===`);
    console.log(`マッチ: ${matched.size}/${sheetFacilityNames.length}`);
    for (const [name, id] of matched) {
      const tritrusName = mappings.find(m => m.premisesId === id)?.tritrusName || '?';
      console.log(`  ✅ ${name} → premisesId=${id} (${tritrusName})`);
    }
    if (unmatched.length > 0) {
      console.log(`\n❌ マッチ不能: ${unmatched.length}件`);
      for (const name of unmatched) {
        console.log(`  ❌ ${name}`);
      }
    }

    // 弾窗ダンプ（オプション）
    if (dumpDialogId !== undefined) {
      console.log(`\n=== 弾窗ダンプ (premisesId=${dumpDialogId}) ===`);
      await premisesNav.openFacilityDetail(dumpDialogId);

      // 登録済み利用者
      const registered = await premisesNav.getRegisteredUsers();
      console.log(`登録済み利用者: ${registered.length}件`);
      for (const name of registered.slice(0, 20)) {
        console.log(`  ${name}`);
      }
      if (registered.length > 20) {
        console.log(`  ... 他 ${registered.length - 20}件`);
      }

      // 弾窗オープン
      await premisesNav.openAddUserDialog();
      const dialogUsers = await premisesNav.getDialogUsers();
      console.log(`\n弾窗内利用者: ${dialogUsers.length}件`);
      for (const u of dialogUsers.slice(0, 30)) {
        console.log(`  [${u.index}] ${u.checked ? '✅' : '⬜'} ${u.userName} | ${u.officeName} | careuid=${u.careuid}`);
      }
      if (dialogUsers.length > 30) {
        console.log(`  ... 他 ${dialogUsers.length - 30}件`);
      }
    }

    console.log('\n=== 完了 ===');
  } catch (error) {
    logger.error(`エラー: ${(error as Error).message}`);
    logger.error((error as Error).stack || '');
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  logger.error(`致命的エラー: ${(error as Error).message}`);
  process.exit(1);
});
