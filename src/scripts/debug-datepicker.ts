/**
 * 深度调查 warekidatepicker 为什么不弹出日历
 */
import dotenv from 'dotenv';
dotenv.config();
import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { PremisesNavigator } from '../core/premises-navigator';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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
  const nav = new PremisesNavigator(page);

  await nav.navigateToPremisesList();
  await nav.openFacilityDetail(10470);
  console.log('✓ うらら施設詳細');

  // 利用者追加
  const userCount = await nav.getDetailUserCount();
  if (userCount === 0) {
    await nav.openAddUserDialog();
    await nav.selectUserInDialog('小濵士郎', '訪問看護ステーションあおぞら姶良');
    await nav.confirmAddUsers();
    console.log(`✓ 利用者追加完了 (${await nav.getDetailUserCount()}件)`);
  }

  // ── warekidatepicker 初期化状態を詳しく調査 ──
  console.log('\n=== warekidatepicker 初期化調査 ===');
  const wpInfo = await page.evaluate(() => {
    const $ = (window as any).jQuery;
    const el = document.getElementById('applydateStart_0') as HTMLInputElement;

    if (!el) return { error: 'applydateStart_0 not found' };
    if (!$) return { error: 'jQuery not found' };

    const $el = $(el);

    // datepicker が初期化されているか
    const hasDataDatepicker = !!el.getAttribute('data-datepicker');
    const hasClass = el.classList.contains('hasDatepicker') || el.classList.contains('hasWarekidatepicker');
    
    // jQuery data にインスタンスがあるか
    let dpInst: any = null;
    try { dpInst = $.data(el, 'datepicker'); } catch {}
    
    let wpInst: any = null;
    try { wpInst = $.data(el, 'warekidatepicker'); } catch {}

    // $.datepicker シングルトン
    const hasDpGlobal = !!$.datepicker;
    let dpMethods: string[] = [];
    if ($.datepicker) {
      dpMethods = Object.keys($.datepicker).filter(k => typeof $.datepicker[k] === 'function').slice(0, 20);
    }

    // warekidatepicker function
    const hasWpFn = typeof $.fn.warekidatepicker === 'function';
    const hasDpFn = typeof $.fn.datepicker === 'function';

    // ページに読み込まれた script タグ（datepicker関連）
    const scripts = Array.from(document.querySelectorAll('script[src]'))
      .map(s => (s as HTMLScriptElement).src)
      .filter(src => src.includes('datepicker') || src.includes('wareki') || src.includes('jquery.ui'));

    return {
      elementFound: true,
      className: el.className,
      hasClass,
      hasDpData: !!dpInst,
      hasWpData: !!wpInst,
      hasDpGlobal,
      dpMethods,
      hasWpFn,
      hasDpFn,
      datepickerScripts: scripts,
      jqueryVersion: $.fn.jquery,
      // input 周辺の HTML
      parentHTML: el.parentElement?.innerHTML?.substring(0, 500) || '',
    };
  });
  console.log(JSON.stringify(wpInfo, null, 2));

  // ── warekidatepicker を手動で初期化してみる ──
  if (wpInfo.hasWpFn && !wpInfo.hasClass) {
    console.log('\n=== warekidatepicker 未初期化 → 手動初期化テスト ===');
    const initResult = await page.evaluate(() => {
      const $ = (window as any).jQuery;
      const el = document.getElementById('applydateStart_0');
      if (!$ || !el) return { error: 'not found' };

      try {
        // class名に warekidatepicker があるのに初期化されていない場合
        // → $().warekidatepicker() で初期化
        $(el).warekidatepicker();
        return {
          success: true,
          hasClass: el.classList.contains('hasWarekidatepicker'),
          hasDpData: !!$.data(el, 'datepicker'),
        };
      } catch (e: any) {
        return { error: e.message };
      }
    });
    console.log(JSON.stringify(initResult, null, 2));
  }

  // ── 再度クリックして日历が出るか ──
  console.log('\n=== 再度 input クリック ===');
  await page.click('#applydateStart_0');
  await sleep(2000);
  
  const calAfter = await page.evaluate(() => {
    const dp = document.getElementById('ui-datepicker-div');
    if (!dp) return { found: false };
    return {
      found: true,
      display: window.getComputedStyle(dp).display,
      childCount: dp.children.length,
    };
  });
  console.log(`日历: ${JSON.stringify(calAfter)}`);
  await page.screenshot({ path: 'tmp/calendar-retry.png', fullPage: false });

  // ── setDate テスト（日历が出なくても） ──
  console.log('\n=== setDate テスト ===');
  const setResult = await page.evaluate(() => {
    const $ = (window as any).jQuery;
    const el = document.getElementById('applydateStart_0') as HTMLInputElement;
    if (!$ || !el) return { error: 'not found' };

    const before = el.value;
    try {
      $(el).warekidatepicker('setDate', new Date(2025, 1, 3));
      const after = el.value;
      
      // _selectDate も試す
      if ($.datepicker && $.datepicker._selectDate) {
        $.datepicker._selectDate(el);
      }
      const final = el.value;
      
      return { before, afterSetDate: after, afterSelectDate: final };
    } catch (e: any) {
      return { error: e.message, before };
    }
  });
  console.log(JSON.stringify(setResult, null, 2));

  await page.screenshot({ path: 'tmp/after-setdate.png', fullPage: false });

  // 保存しないで戻る
  await page.evaluate(() => document.getElementById('applydateStart_0')?.blur());
  await sleep(300);
  await nav.returnWithoutSave();
  console.log('\n✓ 完了');
  await bm.close();
}

main().catch(e => { console.error(e); process.exit(1); });
