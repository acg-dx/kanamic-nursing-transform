/**
 * HAM スタッフマスタの資格を修正する（准看護師 → 看護師）。
 * 対象: 口町恵美, 櫻井鈴菜, 川尻絵李奈
 * 実行: npx tsx src/scripts/fix-ham-qualifications.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { KanamickAuthService } from '../services/kanamick-auth.service';

// 修正対象
const TARGETS = [
  { empCode: '584',  name: '口町恵美' },
  { empCode: '1319', name: '櫻井鈴菜' },
  { empCode: '531',  name: '川尻絵李奈' },
];

async function main() {
  // 1. HAM にログイン
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  const auth = new KanamickAuthService({
    url: process.env.KANAMICK_URL || 'https://portal.kanamic.net/tritrus/index/',
    username: process.env.KANAMICK_USERNAME || '',
    password: process.env.KANAMICK_PASSWORD || '',
    stationName: process.env.KANAMICK_STATION_NAME || '訪問看護ステーションあおぞら姶良',
    hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
    hamOfficeCode: process.env.KANAMICK_HAM_OFFICE_CODE || '400021814',
  });
  auth.setContext(context);
  await auth.login();
  const nav = auth.navigator;
  console.log('HAM ログイン完了\n');

  // 2. スタッフマスタへ遷移 → 全件検索
  await auth.navigateToStaffMaster();
  await sleep(1500);
  await nav.submitForm({ action: 'act_edit', waitForPageId: 'h1-1a', timeout: 15000 });
  await sleep(2000);
  await searchAll(nav);
  console.log('スタッフ一覧取得完了\n');

  // 3. 各対象スタッフを修正
  for (const target of TARGETS) {
    console.log(`--- ${target.name} (${target.empCode}) ---`);
    try {
      const listFrame = await nav.getMainFrame();
      const nameNorm = target.name.replace(/[\s\u3000]+/g, '');
      const targetIndex = await listFrame.evaluate((searchName: string) => {
        const btns = document.querySelectorAll('input[type="button"][name="act_edit"][value="詳細"]');
        for (let i = 0; i < btns.length; i++) {
          const row = btns[i].closest('tr');
          const cells = row?.querySelectorAll('td');
          if (cells && cells.length >= 3) {
            const hamName = (cells[2]?.textContent || '').replace(/[\s\u3000]+/g, '').trim();
            if (hamName === searchName) return i;
          }
        }
        return -1;
      }, nameNorm);

      if (targetIndex < 0) {
        console.log(`  見つからない — スキップ\n`);
        continue;
      }

      // 詳細クリック → h1-1b
      await listFrame.evaluate(() => { (window as any).submited = 0; });
      const detailBtns = await listFrame.$$('input[type="button"][name="act_edit"][value="詳細"]');
      await detailBtns[targetIndex].click();
      await sleep(3000);

      const h1_1bFrame = await nav.waitForMainFrame('h1-1b', 15000);

      // 修正前の状態確認
      const before = await h1_1bFrame.evaluate(() => {
        const cb = document.querySelector('input[name="licence5s"]') as HTMLInputElement | null;
        const r1 = document.querySelector('input[name="licence5"][value="1"]') as HTMLInputElement | null;
        const r2 = document.querySelector('input[name="licence5"][value="2"]') as HTMLInputElement | null;
        return {
          checked: cb?.checked ?? false,
          radio1: r1?.checked ?? false,
          radio2: r2?.checked ?? false,
        };
      });
      console.log(`  修正前: checkbox=${before.checked}, 看護師=${before.radio1}, 准看護師=${before.radio2}`);

      // licence5s を ON、licence5 radio を 1(看護師) に変更
      await h1_1bFrame.evaluate(() => {
        const cb = document.querySelector('input[name="licence5s"]') as HTMLInputElement | null;
        const r1 = document.querySelector('input[name="licence5"][value="1"]') as HTMLInputElement | null;
        if (cb) cb.checked = true;
        if (r1) r1.checked = true;
      });

      // 修正後の確認
      const after = await h1_1bFrame.evaluate(() => {
        const cb = document.querySelector('input[name="licence5s"]') as HTMLInputElement | null;
        const r1 = document.querySelector('input[name="licence5"][value="1"]') as HTMLInputElement | null;
        return { checked: cb?.checked ?? false, radio1: r1?.checked ?? false };
      });
      console.log(`  修正後: checkbox=${after.checked}, 看護師=${after.radio1}`);

      // データ上書き保存
      await h1_1bFrame.evaluate(() => { (window as any).submited = 0; });
      const saveBtn = await h1_1bFrame.$('#Submit01, input[value="データ上書き保存"]');
      if (saveBtn) {
        await saveBtn.click();
        await sleep(3000);
        console.log(`  ✓ 保存完了\n`);
      } else {
        console.log(`  ✗ 保存ボタンが見つからない\n`);
      }

      // h1-1a に戻って再検索
      await nav.submitForm({ action: 'act_back', waitForPageId: 'h1-1a', timeout: 15000 });
      await sleep(1000);
      await searchAll(nav);
      await sleep(2000);

    } catch (err) {
      console.log(`  エラー: ${(err as Error).message}\n`);
      // 復帰
      try {
        await auth.navigateToMainMenu();
        await auth.navigateToStaffMaster();
        await sleep(1500);
        await nav.submitForm({ action: 'act_edit', waitForPageId: 'h1-1a', timeout: 15000 });
        await sleep(2000);
        await searchAll(nav);
      } catch { /* ignore */ }
    }
  }

  console.log('=== 完了 ===');
  await browser.close();
  process.exit(0);
}

async function searchAll(nav: any): Promise<void> {
  const frame = await nav.waitForMainFrame('h1-1a', 15000);
  await frame.evaluate(() => {
    (window as any).submited = 0;
    const form = document.forms[0] as any;
    form.doAction.value = 'act_search';
    form.target = 'commontarget';
    if (form.doTarget) form.doTarget.value = 'commontarget';
    form.submit();
  });
  const start = Date.now();
  while (Date.now() - start < 15000) {
    await sleep(1000);
    try {
      const f = await nav.getMainFrame();
      const count = await f.evaluate(() =>
        document.querySelectorAll('input[type="button"][name="act_edit"][value="詳細"]').length
      ).catch(() => 0);
      if (count > 0) return;
    } catch { /* retry */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => { console.error('エラー:', err); process.exit(1); });
