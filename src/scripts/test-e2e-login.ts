/**
 * E2E テスト: TRITRUS ログイン → HAM 遷移 → 利用者検索
 * 実行: npx tsx src/scripts/test-e2e-login.ts
 *
 * ブラウザが起動し、実際のTRITRUSにログインして HAM に到達するかテスト
 */
import dotenv from 'dotenv';
dotenv.config();

import { chromium } from 'playwright';
import { KanamickAuthService, KanamickAuthConfig } from '../services/kanamick-auth.service';
import { logger } from '../core/logger';

async function main() {
  console.log('=== E2E テスト: TRITRUS → HAM ログイン ===\n');

  const config: KanamickAuthConfig = {
    url: process.env.KANAMICK_URL || 'https://portal.kanamic.net/tritrus/index/',
    username: process.env.KANAMICK_USERNAME || '',
    password: process.env.KANAMICK_PASSWORD || '',
    stationName: process.env.KANAMICK_STATION_NAME || '訪問看護ステーションあおぞら姶良',
    hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
    hamOfficeCode: process.env.KANAMICK_HAM_OFFICE_CODE || '400021814',
  };

  console.log(`URL: ${config.url}`);
  console.log(`ユーザー: ${config.username}`);
  console.log(`事業所: ${config.stationName}`);
  console.log();

  // ブラウザ起動
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false' ? true : false,
    slowMo: parseInt(process.env.SLOW_MO || '50', 10),
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'ja-JP',
  });

  // native dialog 自動承認
  context.on('page', page => {
    page.on('dialog', async dialog => {
      logger.debug(`ダイアログ [${dialog.type()}]: ${dialog.message()}`);
      await dialog.accept();
    });
  });

  const auth = new KanamickAuthService(config);
  auth.setContext(context);

  try {
    // Step 1: ログイン
    console.log('Step 1: TRITRUS ログイン...');
    const nav = await auth.login();
    console.log('  ✅ ログイン成功\n');

    // Step 2: HAM メインメニュー確認
    console.log('Step 2: HAM メインメニュー確認...');
    const hamPage = nav.hamPage;
    console.log(`  HAM URL: ${hamPage.url()}`);
    const pageTitle = await hamPage.title();
    console.log(`  タイトル: ${pageTitle}`);
    console.log('  ✅ HAM ページ確認\n');

    // Step 3: 訪問看護業務ガイドへ遷移
    console.log('Step 3: 訪問看護業務ガイドへ遷移...');
    await auth.navigateToBusinessGuide();
    const currentPageId = await nav.getCurrentPageId();
    console.log(`  現在のページID: ${currentPageId}`);
    console.log('  ✅ 業務ガイド遷移完了\n');

    // Step 4: 利用者検索へ遷移
    console.log('Step 4: 利用者検索へ遷移...');
    await auth.navigateToUserSearch();
    const searchPageId = await nav.getCurrentPageId();
    console.log(`  現在のページID: ${searchPageId}`);
    console.log('  ✅ 利用者検索遷移完了\n');

    // Step 5: 検索年月を設定して検索
    console.log('Step 5: 利用者検索テスト...');
    const now = new Date();
    const searchDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}01`;
    await nav.setSelectValue('searchdate', searchDate);
    console.log(`  searchdate = ${searchDate}`);

    // 50音「ア」で検索テスト
    await nav.searchByKana('ア');
    console.log('  カナ検索「ア」完了');

    // ページ内容を確認
    const content = await nav.getFrameContent();
    const lines = content.split('\n').filter(l => l.trim());
    console.log(`  検索結果: ${lines.length} 行`);
    // 最初の5行を表示
    for (const line of lines.slice(0, 5)) {
      console.log(`    ${line.substring(0, 80)}`);
    }
    console.log('  ✅ 利用者検索テスト完了\n');

    console.log('=== 全ステップ完了 ===');
    console.log('ブラウザを10秒後に閉じます...');
    await new Promise(resolve => setTimeout(resolve, 10000));

  } catch (err) {
    console.error('❌ エラー:', err);
    // スクリーンショットを保存
    try {
      const page = context.pages()[0];
      await page.screenshot({ path: 'screenshots/e2e-error.png', fullPage: true });
      console.log('スクリーンショット保存: screenshots/e2e-error.png');
    } catch {
      // ignore
    }
  } finally {
    await browser.close();
    console.log('ブラウザ終了');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
