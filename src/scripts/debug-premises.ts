import dotenv from 'dotenv';
dotenv.config();
import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { KanamickAuthService } from '../services/kanamick-auth.service';

async function main() {
  const ai = new AIHealingService('', 'gpt-4o');
  const se = new SelectorEngine(ai);
  const bm = new BrowserManager(se);
  const auth = new KanamickAuthService({
    url: process.env.KANAMICK_URL!,
    username: process.env.KANAMICK_USERNAME!,
    password: process.env.KANAMICK_PASSWORD!,
    stationName: '訪問看護ステーションあおぞら姶良',
  });

  await bm.launch();
  auth.setContext(bm.browserContext);
  const page = await auth.loginTritrusOnly();

  // 施設一覧へ
  await page.goto('https://portal.kanamic.net/tritrus/premisesIndex/index', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await page.waitForSelector('button[onclick*="transferPremisesUpdate"]', { timeout: 15000 });

  // 四元(8953)の行HTMLをダンプ
  const rowInfo = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tbody tr'));
    for (const tr of rows) {
      const btn = tr.querySelector('button[onclick*="transferPremisesUpdate(8953)"]');
      if (btn) {
        const allBtns = Array.from(tr.querySelectorAll('button'));
        return {
          html: tr.outerHTML.substring(0, 2000),
          buttons: allBtns.map(b => ({
            class: b.className,
            text: (b.textContent || '').trim(),
            onclick: b.getAttribute('onclick'),
          })),
        };
      }
    }
    return null;
  });
  console.log('=== 四元 ROW INFO ===');
  console.log(JSON.stringify(rowInfo, null, 2));

  // .select_editBtn があるか確認
  const editBtnExists = await page.evaluate(() => {
    return {
      selectEditBtn: document.querySelectorAll('.select_editBtn').length,
      selectAddBtn: document.querySelectorAll('.select_addBtn-wh').length,
      allButtonClasses: Array.from(new Set(
        Array.from(document.querySelectorAll('button')).map(b => b.className)
      )),
    };
  });
  console.log('=== BUTTON CLASSES ON PAGE ===');
  console.log(JSON.stringify(editBtnExists, null, 2));

  // 共生ホーム武(10458) — 事業所設定済みの施設でテスト
  const testId = 10458;
  console.log(`\n=== clicking transferPremisesUpdate(${testId}) ===`);
  await page.evaluate((id: number) => {
    (window as any).transferPremisesUpdate(id);
  }, testId);
  await page.waitForLoadState('networkidle', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));

  // 利用者を追加ボタンをクリック
  console.log('=== clicking openCareuserWindow ===');
  await page.evaluate(() => {
    (window as any).openCareuserWindow();
  });
  await new Promise(r => setTimeout(r, 3000));

  // 弾窗HTML構造をダンプ
  const dialogInfo = await page.evaluate(() => {
    // remodal のモーダルを探す
    const modals = Array.from(document.querySelectorAll('[data-remodal-id], .remodal, .remodal-wrapper'));
    const modalHtml = modals.map(m => ({
      tag: m.tagName,
      class: m.className,
      id: m.id,
      dataRemodal: m.getAttribute('data-remodal-id'),
      visible: (m as HTMLElement).offsetParent !== null,
      innerHtml: m.innerHTML.substring(0, 3000),
    }));

    // #chkCareuserSelectAll を探す
    const selectAll = document.getElementById('chkCareuserSelectAll');
    // careuser_name_0 を探す
    const name0 = document.getElementById('careuser_name_0');

    // iframe を探す
    const iframes = Array.from(document.querySelectorAll('iframe'));

    return {
      modals: modalHtml,
      selectAllFound: !!selectAll,
      selectAllVisible: selectAll ? (selectAll as HTMLElement).offsetParent !== null : false,
      name0Found: !!name0,
      iframeCount: iframes.length,
      iframeSrcs: iframes.map(f => f.src),
    };
  });
  console.log('=== DIALOG INFO ===');
  console.log(JSON.stringify(dialogInfo, null, 2));

  await page.waitForLoadState('networkidle', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));

  // 施設詳細ページの構造をダンプ
  const detailInfo = await page.evaluate(() => {
    const allBtns = Array.from(document.querySelectorAll('button'));
    return {
      url: location.href,
      title: document.title,
      buttonCount: allBtns.length,
      buttons: allBtns.slice(0, 20).map(b => ({
        class: b.className,
        text: (b.textContent || '').trim().substring(0, 80),
        onclick: b.getAttribute('onclick'),
      })),
      bodyText: document.body.innerText.substring(0, 3000),
    };
  });
  console.log('=== DETAIL PAGE INFO ===');
  console.log(JSON.stringify(detailInfo, null, 2));

  await bm.close();
}

main().catch(e => { console.error(e); process.exit(1); });
