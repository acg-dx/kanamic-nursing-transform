/**
 * 転記フロー全ステップ E2E テスト — セレクタ記録
 *
 * 実行: HEADLESS=false npx tsx src/scripts/test-transcription-selectors.ts
 *
 * 各ページの form 要素、ボタン、リンク、select、input を網羅的に記録し、
 * screenshots/ に保存する。
 */
import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import { chromium, Page, Frame, BrowserContext } from 'playwright';
import { KanamickAuthService, KanamickAuthConfig } from '../services/kanamick-auth.service';
import { HamNavigator } from '../core/ham-navigator';
import { logger } from '../core/logger';

const SCREENSHOTS_DIR = './screenshots';
const LOG_FILE = './tmp/selector-report.txt';

let reportLines: string[] = [];

function log(msg: string) {
  console.log(msg);
  reportLines.push(msg);
}

function section(title: string) {
  const bar = '='.repeat(60);
  log(`\n${bar}`);
  log(`  ${title}`);
  log(bar);
}

async function screenshot(page: Page, name: string) {
  try {
    const path = `${SCREENSHOTS_DIR}/${name}.png`;
    await page.screenshot({ path, fullPage: true });
    log(`  📸 ${path}`);
  } catch (e) {
    log(`  📸 Screenshot failed: ${(e as Error).message}`);
  }
}

async function screenshotFrame(page: Page, frame: Frame, name: string) {
  try {
    const path = `${SCREENSHOTS_DIR}/${name}.png`;
    await page.screenshot({ path, fullPage: true });
    log(`  📸 ${path}`);
  } catch {
    try {
      const path = `${SCREENSHOTS_DIR}/${name}.png`;
      await frame.page().screenshot({ path, fullPage: true });
      log(`  📸 ${path} (frame.page)`);
    } catch (e2) {
      log(`  📸 Screenshot failed: ${(e2 as Error).message}`);
    }
  }
}

/**
 * フレーム内のフォーム要素を網羅的にダンプ
 */
async function dumpFrameSelectors(frame: Frame, label: string) {
  section(`${label} — フォーム要素`);
  log(`  Frame URL: ${frame.url()}`);

  const info = await frame.evaluate(() => {
    const results: string[] = [];
    const form = document.forms[0];

    // --- select ---
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opts = Array.from(sel.options).map(o =>
        `${o.value}="${o.text.substring(0, 40)}"`
      );
      const optStr = opts.length <= 15
        ? opts.join(', ')
        : opts.slice(0, 10).join(', ') + ` ... (${opts.length} total)`;
      results.push(`SELECT name="${sel.name}" id="${sel.id}" class="${sel.className}" selectedValue="${sel.value}" options=[${optStr}]`);
    }

    // --- input (visible) ---
    const inputs = Array.from(document.querySelectorAll('input'));
    for (const el of inputs) {
      if (el.type === 'hidden') continue;
      results.push(`INPUT type="${el.type}" name="${el.name}" id="${el.id}" class="${el.className}" value="${el.value.substring(0, 60)}" placeholder="${el.placeholder || ''}"`);
    }

    // --- hidden inputs (important ones) ---
    const hiddens = Array.from(document.querySelectorAll('input[type="hidden"]'));
    const importantHiddens = hiddens.filter(h =>
      h.name && (
        h.name.includes('Action') || h.name.includes('action') ||
        h.name.includes('Target') || h.name.includes('target') ||
        h.name.includes('pageId') || h.name.includes('userid') ||
        h.name.includes('lockCheck') || h.name.includes('flag') ||
        h.name.includes('date') || h.name.includes('type') ||
        h.name.includes('assignid') || h.name.includes('careuserid') ||
        h.name.includes('helperid') || h.name.includes('servicetype') ||
        h.name.includes('serviceitem') || h.name.includes('servicepoint') ||
        h.name.includes('showflag') || h.name.includes('submited') ||
        h.name.includes('searchdate') || h.name.includes('editdate')
      )
    );
    for (const h of importantHiddens) {
      results.push(`HIDDEN name="${h.name}" id="${h.id}" value="${h.value.substring(0, 80)}"`);
    }

    // --- buttons ---
    const buttons = Array.from(document.querySelectorAll(
      'input[type="button"], input[type="submit"], button'
    ));
    for (const btn of buttons) {
      const inp = btn as HTMLInputElement;
      const onclick = btn.getAttribute('onclick')?.substring(0, 120) || '';
      results.push(`BUTTON tag=${btn.tagName} type="${inp.type}" name="${inp.name}" id="${inp.id}" value="${(inp.value || btn.textContent?.trim() || '').substring(0, 60)}" onclick="${onclick}"`);
    }

    // --- links with onclick ---
    const links = Array.from(document.querySelectorAll('a[onclick]'));
    for (const a of links) {
      const onclick = a.getAttribute('onclick')?.substring(0, 150) || '';
      results.push(`LINK text="${(a.textContent?.trim() || '').substring(0, 60)}" onclick="${onclick}"`);
    }

    // --- radio ---
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    for (const r of radios) {
      const inp = r as HTMLInputElement;
      results.push(`RADIO name="${inp.name}" value="${inp.value}" id="${inp.id}" checked=${inp.checked}`);
    }

    // --- checkbox ---
    const cbs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    for (const c of cbs) {
      const inp = c as HTMLInputElement;
      results.push(`CHECKBOX name="${inp.name}" value="${inp.value}" id="${inp.id}" checked=${inp.checked} class="${inp.className}"`);
    }

    // --- textarea ---
    const tas = Array.from(document.querySelectorAll('textarea'));
    for (const ta of tas) {
      results.push(`TEXTAREA name="${ta.name}" id="${ta.id}" value="${ta.value.substring(0, 60)}"`);
    }

    // --- table summary (row count) ---
    const tables = document.querySelectorAll('table');
    if (tables.length > 0) {
      results.push(`TABLES count=${tables.length}`);
      for (let i = 0; i < Math.min(tables.length, 3); i++) {
        const t = tables[i];
        results.push(`  TABLE[${i}] rows=${t.rows.length} id="${t.id}" class="${t.className.substring(0, 40)}"`);
      }
    }

    // --- page text snippet ---
    const bodyText = document.body?.innerText?.substring(0, 300) || '';
    results.push(`PAGE_TEXT_SNIPPET: ${bodyText.replace(/\n/g, ' | ').substring(0, 300)}`);

    return results;
  }).catch(e => [`ERROR: ${(e as Error).message}`]);

  for (const line of info) {
    log(`  ${line}`);
  }
}

/**
 * 全フレーム構造をダンプ
 */
async function dumpFrames(page: Page, label: string) {
  const frames = page.frames();
  log(`\n  ${label} — フレーム構造 (${frames.length}):`);
  for (const f of frames) {
    log(`    name="${f.name()}" url="${f.url().substring(0, 130)}"`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  log('=== 転記フロー全ステップ セレクタ記録テスト ===');
  log(`実行日時: ${new Date().toISOString()}\n`);

  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  if (!fs.existsSync('./tmp')) fs.mkdirSync('./tmp', { recursive: true });

  const config: KanamickAuthConfig = {
    url: process.env.KANAMICK_URL || 'https://portal.kanamic.net/tritrus/index/',
    username: process.env.KANAMICK_USERNAME || '',
    password: process.env.KANAMICK_PASSWORD || '',
    stationName: process.env.KANAMICK_STATION_NAME || '訪問看護ステーションあおぞら姶良',
    hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
    hamOfficeCode: process.env.KANAMICK_HAM_OFFICE_CODE || '400021814',
  };

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false' ? true : false,
    slowMo: parseInt(process.env.SLOW_MO || '80', 10),
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'ja-JP',
  });

  context.on('page', page => {
    page.on('dialog', async dialog => {
      log(`  💬 Dialog [${dialog.type()}]: ${dialog.message()}`);
      await dialog.accept();
    });
  });

  const auth = new KanamickAuthService(config);
  auth.setContext(context);

  try {
    // ================================================================
    // STEP 0: ログイン → HAM メインメニュー (t1-2)
    // ================================================================
    section('STEP 0: TRITRUS → HAM ログイン');
    const nav = await auth.login();
    const hamPage = nav.hamPage;
    log(`  HAM URL: ${hamPage.url()}`);
    log(`  タイトル: ${await hamPage.title()}`);
    await dumpFrames(hamPage, 'HAM ログイン後');
    await screenshot(hamPage, 'step00-ham-main-menu');

    // t1-2 の mainFrame を記録
    const t12Frame = await nav.getMainFrame();
    await dumpFrameSelectors(t12Frame, 'STEP 0: t1-2 メインメニュー (mainFrame)');

    // ================================================================
    // STEP 1: t1-2 → k1_1 (訪問看護業務ガイド)
    // ================================================================
    section('STEP 1: t1-2 → k1_1 訪問看護業務ガイド');
    await auth.navigateToBusinessGuide();
    await sleep(1500);
    const k1_1Frame = await nav.getMainFrame('k1_1');
    log(`  pageId: ${await nav.getCurrentPageId()}`);
    await dumpFrameSelectors(k1_1Frame, 'STEP 1: k1_1 業務ガイド');
    await screenshotFrame(hamPage, k1_1Frame, 'step01-k1_1-business-guide');

    // ================================================================
    // STEP 2: k1_1 → k2_1 (利用者検索)
    // ================================================================
    section('STEP 2: k1_1 → k2_1 利用者検索');
    await auth.navigateToUserSearch();
    await sleep(1500);
    const k2_1Frame = await nav.getMainFrame('k2_1');
    log(`  pageId: ${await nav.getCurrentPageId()}`);
    await dumpFrameSelectors(k2_1Frame, 'STEP 2: k2_1 利用者検索（初期）');
    await screenshotFrame(hamPage, k2_1Frame, 'step02-k2_1-user-search-initial');

    // ================================================================
    // STEP 3: k2_1 で年月設定・検索実行
    // ================================================================
    section('STEP 3: k2_1 年月設定・検索');
    const now = new Date();
    const monthStart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}01`;
    log(`  searchdate = ${monthStart}`);

    await nav.setSelectValue('searchdate', monthStart);
    await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_1' });
    await sleep(2000);

    const k2_1AfterSearch = await nav.getMainFrame('k2_1');
    await dumpFrameSelectors(k2_1AfterSearch, 'STEP 3: k2_1 検索結果');
    await screenshotFrame(hamPage, k2_1AfterSearch, 'step03-k2_1-search-results');

    // 患者リスト（最初の5名）を記録
    const patientList = await k2_1AfterSearch.evaluate(() => {
      const btns = document.querySelectorAll('input[name="act_result"][value="決定"]');
      const results: string[] = [];
      for (let i = 0; i < Math.min(btns.length, 5); i++) {
        const btn = btns[i];
        const tr = btn.closest('tr');
        const text = tr?.textContent?.trim().replace(/\s+/g, ' ').substring(0, 100) || '';
        const onclick = btn.getAttribute('onclick')?.substring(0, 120) || '';
        results.push(`[${i}] text="${text}" onclick="${onclick}"`);
      }
      return { count: btns.length, samples: results };
    });
    log(`  患者数: ${patientList.count}`);
    for (const p of patientList.samples) {
      log(`  ${p}`);
    }

    // ================================================================
    // STEP 4: k2_1 → k2_2 (最初の患者を選択 → 月間スケジュール)
    // ================================================================
    section('STEP 4: k2_1 → k2_2 月間スケジュール（最初の患者）');

    const firstPatientId = await k2_1AfterSearch.evaluate(() => {
      const btn = document.querySelector('input[name="act_result"][value="決定"]');
      if (!btn) return null;
      const onclick = btn.getAttribute('onclick') || '';
      const m = onclick.match(/careuserid\s*,\s*'(\d+)'/);
      if (m) return m[1];
      const m2 = onclick.match(/careuserid\.value\s*=\s*'(\d+)'/);
      return m2 ? m2[1] : null;
    });

    if (!firstPatientId) {
      log('  ❌ 患者IDが取得できませんでした。テスト中断。');
      throw new Error('No patient ID found');
    }
    log(`  選択患者ID: ${firstPatientId}`);

    // submitTargetFormEx で k2_2 に遷移
    await k2_1AfterSearch.evaluate((pid) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      const form = document.forms[0];
      if (typeof win.submitTargetFormEx === 'function') {
        win.submitTargetFormEx(form, 'k2_2', form.careuserid, pid);
      } else {
        win.submited = 0;
        form.careuserid.value = pid;
        form.doAction.value = 'k2_2';
        form.target = 'mainFrame';
        form.submit();
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }, firstPatientId);

    await nav.waitForMainFrame('k2_2', 15000);
    await sleep(2000);

    const k2_2Frame = await nav.getMainFrame('k2_2');
    log(`  pageId: ${await nav.getCurrentPageId()}`);
    await dumpFrameSelectors(k2_2Frame, 'STEP 4: k2_2 月間スケジュール');
    await screenshotFrame(hamPage, k2_2Frame, 'step04-k2_2-monthly-schedule');

    // k2_2 の既存スケジュール行を記録
    const scheduleRows = await k2_2Frame.evaluate(() => {
      const rows = document.querySelectorAll('tr');
      const results: string[] = [];
      for (const row of Array.from(rows)) {
        const text = row.textContent?.trim().replace(/\s+/g, ' ') || '';
        if (text.includes('配置') || text.includes('削除') || text.includes('予定') || text.includes('実績')) {
          results.push(text.substring(0, 120));
        }
      }
      return results.slice(0, 10);
    });
    log(`  既存スケジュール行 (最大10):`);
    for (const row of scheduleRows) {
      log(`    ${row}`);
    }

    // ================================================================
    // STEP 5: k2_2 → k2_3 (追加ボタン → スケジュール追加)
    // ================================================================
    section('STEP 5: k2_2 → k2_3 スケジュール追加');

    // 今月1日の日付
    const editdate = monthStart;
    log(`  editdate = ${editdate}`);

    await nav.submitForm({
      action: 'act_addnew',
      setLockCheck: true,
      hiddenFields: { editdate },
      waitForPageId: 'k2_3',
    });
    await sleep(2000);

    const k2_3Frame = await nav.getMainFrame('k2_3');
    log(`  pageId: ${await nav.getCurrentPageId()}`);
    await dumpFrameSelectors(k2_3Frame, 'STEP 5: k2_3 スケジュール追加（時間設定）');
    await screenshotFrame(hamPage, k2_3Frame, 'step05-k2_3-schedule-add');

    // ================================================================
    // STEP 6: k2_3 で時間設定 → 次へ → k2_3a
    // ================================================================
    section('STEP 6: k2_3 時間設定 → k2_3a');

    // テスト用: 日中・10時開始・1時間未満
    await nav.setSelectValue('starttype', '1');     // 日中
    await nav.setSelectValue('starttime0', '10');    // 10時
    await nav.setSelectValue('starttime1', '00');    // 00分
    await nav.setSelectValue('timetype', '60');      // 1時間未満
    log(`  時間設定: starttype=1(日中), 10:00, timetype=60(1h未満)`);

    // 終了時刻を確認（自動入力されるか）
    const endTimeAfter = await k2_3Frame.evaluate(() => {
      const form = document.forms[0];
      const endtype = (form['endtype'] as unknown as HTMLSelectElement)?.value || '';
      const endtime0 = (form['endtime0'] as unknown as HTMLSelectElement)?.value || '';
      const endtime1 = (form['endtime1'] as unknown as HTMLSelectElement)?.value || '';
      return { endtype, endtime0, endtime1 };
    });
    log(`  自動終了時刻: endtype=${endTimeAfter.endtype}, ${endTimeAfter.endtime0}:${endTimeAfter.endtime1}`);

    // 終了時刻を手動設定
    await nav.setSelectValue('endtype', '1');       // 日中
    await nav.setSelectValue('endtime0', '10');      // 10時
    await nav.setSelectValue('endtime1', '30');      // 30分

    // 次へ → k2_3a
    await nav.submitForm({ action: 'act_next', waitForPageId: 'k2_3a' });
    await sleep(2000);

    const k2_3aFrame = await nav.getMainFrame('k2_3a');
    log(`  pageId: ${await nav.getCurrentPageId()}`);
    await dumpFrameSelectors(k2_3aFrame, 'STEP 6: k2_3a サービスコード選択（初期表示）');
    await screenshotFrame(hamPage, k2_3aFrame, 'step06-k2_3a-service-code-initial');

    // ================================================================
    // STEP 7: k2_3a — 保険種別ボタンの存在確認
    // ================================================================
    section('STEP 7: k2_3a 保険種別切替ボタン');

    const insuranceButtons = await k2_3aFrame.evaluate(() => {
      const results: string[] = [];
      // showflag ボタン（訪問看護 / 予防訪問看護 / 訪問看護医療費）
      const inputs = document.querySelectorAll('input[type="button"], input[type="submit"]');
      for (const btn of Array.from(inputs)) {
        const inp = btn as HTMLInputElement;
        const onclick = btn.getAttribute('onclick')?.substring(0, 150) || '';
        if (onclick.includes('showflag') || onclick.includes('change') || inp.name.includes('flag')) {
          results.push(`INSURANCE_BTN name="${inp.name}" value="${inp.value}" onclick="${onclick}"`);
        }
      }
      // links with showflag
      const links = document.querySelectorAll('a');
      for (const a of Array.from(links)) {
        const onclick = a.getAttribute('onclick') || '';
        const text = a.textContent?.trim() || '';
        if (onclick.includes('showflag') || text.includes('訪問看護') || text.includes('予防') || text.includes('医療費')) {
          results.push(`INSURANCE_LINK text="${text.substring(0, 60)}" onclick="${onclick.substring(0, 150)}"`);
        }
      }
      return results;
    });
    for (const btn of insuranceButtons) {
      log(`  ${btn}`);
    }

    // showflag=3 (医療) に切替
    log(`  showflag=3 (医療保険) に切替...`);
    await nav.switchInsuranceType('3');
    await sleep(2000);

    const k2_3aAfterSwitch = await nav.getMainFrame('k2_3a');
    await dumpFrameSelectors(k2_3aAfterSwitch, 'STEP 7: k2_3a 医療保険切替後');
    await screenshotFrame(hamPage, k2_3aAfterSwitch, 'step07-k2_3a-iryo-switched');

    // サービスコード radio ボタンの一覧
    const serviceCodes = await k2_3aAfterSwitch.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[name="radio"]'));
      return radios.map(r => {
        const inp = r as HTMLInputElement;
        const tr = r.closest('tr');
        const text = tr?.textContent?.trim().replace(/\s+/g, ' ').substring(0, 100) || '';
        return `value="${inp.value}" checked=${inp.checked} rowText="${text}"`;
      });
    });
    log(`  サービスコード radio (${serviceCodes.length}):`);
    for (const sc of serviceCodes) {
      log(`    ${sc}`);
    }

    // 資格チェックボックス
    const qualCheckboxes = await k2_3aAfterSwitch.evaluate(() => {
      const cbs = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
      return cbs
        .filter(c => {
          const name = (c as HTMLInputElement).name;
          return name.includes('shikaku') || name.includes('staff') || name.includes('licence');
        })
        .map(c => {
          const inp = c as HTMLInputElement;
          const label = inp.closest('label')?.textContent?.trim() || '';
          const parent = inp.parentElement?.textContent?.trim().substring(0, 60) || '';
          return `type="${inp.type}" name="${inp.name}" value="${inp.value}" id="${inp.id}" label="${label}" parent="${parent}"`;
        });
    });
    log(`  資格チェック/ラジオ (${qualCheckboxes.length}):`);
    for (const qc of qualCheckboxes) {
      log(`    ${qc}`);
    }

    // ================================================================
    // STEP 7.5: サービスコード選択してnext → k2_3b
    // ================================================================
    section('STEP 7.5: k2_3a サービスコード選択 → k2_3b');

    // 最初のサービスコードを選択
    const firstServiceCode = await k2_3aAfterSwitch.evaluate(() => {
      const radio = document.querySelector('input[name="radio"]') as HTMLInputElement;
      if (!radio) return null;
      radio.checked = true;
      const form = document.forms[0];
      const parts = radio.value.split('#');
      if (parts.length === 2 && form.servicetype && form.serviceitem) {
        form.servicetype.value = parts[0];
        form.serviceitem.value = parts[1];
      }
      return radio.value;
    });
    log(`  選択サービスコード: ${firstServiceCode}`);

    // 次へ → k2_3b
    await nav.submitForm({ action: 'act_next', waitForPageId: 'k2_3b' });
    await sleep(2000);

    const k2_3bFrame = await nav.getMainFrame('k2_3b');
    log(`  pageId: ${await nav.getCurrentPageId()}`);
    await dumpFrameSelectors(k2_3bFrame, 'STEP 7.5: k2_3b 確認画面');
    await screenshotFrame(hamPage, k2_3bFrame, 'step07_5-k2_3b-confirm');

    // ================================================================
    // STEP 8: k2_3b 決定 → k2_2 に戻る
    // ================================================================
    section('STEP 8: k2_3b 決定 → k2_2');
    await nav.submitForm({ action: 'act_do', waitForPageId: 'k2_2' });
    await sleep(2000);

    const k2_2After = await nav.getMainFrame('k2_2');
    log(`  pageId: ${await nav.getCurrentPageId()}`);
    await dumpFrameSelectors(k2_2After, 'STEP 8: k2_2 スケジュール追加後');
    await screenshotFrame(hamPage, k2_2After, 'step08-k2_2-after-schedule-add');

    // 新規追加行の assignid を取得
    const newAssignInfo = await k2_2After.evaluate((targetDate) => {
      const modifyBtns = document.querySelectorAll('input[name="act_modify"]');
      const results: string[] = [];
      for (const btn of Array.from(modifyBtns)) {
        const onclick = btn.getAttribute('onclick') || '';
        const tr = btn.closest('tr');
        const text = tr?.textContent?.trim().replace(/\s+/g, ' ').substring(0, 120) || '';
        results.push(`onclick="${onclick.substring(0, 120)}" row="${text}"`);
      }
      return { count: modifyBtns.length, samples: results.slice(-3) };
    }, editdate);
    log(`  配置ボタン数: ${newAssignInfo.count}`);
    for (const s of newAssignInfo.samples) {
      log(`    ${s}`);
    }

    // ================================================================
    // STEP 9: k2_2 → k2_2f (スタッフ配置)
    // ================================================================
    section('STEP 9: k2_2 → k2_2f スタッフ配置');

    // 最後の配置ボタンの assignid を取得
    const assignId = await k2_2After.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[name="act_modify"]'));
      if (btns.length === 0) return null;
      const lastBtn = btns[btns.length - 1];
      const onclick = lastBtn.getAttribute('onclick') || '';
      const m = onclick.match(/assignid\.value\s*=\s*'(\d+)'/);
      return m ? m[1] : null;
    });

    if (!assignId) {
      log('  ❌ assignId が取得できませんでした');
      // 上書き保存前にキャンセル
      log('  スケジュールを削除して終了...');
      // act_back で戻る
      await nav.submitForm({ action: 'act_back' });
      await sleep(1000);
      throw new Error('No assignId found');
    }
    log(`  assignId: ${assignId}`);

    await nav.submitForm({
      action: 'act_modify',
      setLockCheck: true,
      hiddenFields: { assignid: assignId },
      waitForPageId: 'k2_2f',
    });
    await sleep(2000);

    const k2_2fFrame = await nav.getMainFrame('k2_2f');
    log(`  pageId: ${await nav.getCurrentPageId()}`);
    await dumpFrameSelectors(k2_2fFrame, 'STEP 9: k2_2f スタッフ配置');
    await screenshotFrame(hamPage, k2_2fFrame, 'step09-k2_2f-staff-assign');

    // スタッフ select の選択肢
    const staffOptions = await k2_2fFrame.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        if (sel.name.includes('helper') || sel.name.includes('staff') || sel.options.length > 5) {
          const opts = Array.from(sel.options).map(o => `${o.value}="${o.text.substring(0, 40)}"`);
          return { name: sel.name, id: sel.id, options: opts };
        }
      }
      return null;
    });
    if (staffOptions) {
      log(`  スタッフ SELECT: name="${staffOptions.name}" id="${staffOptions.id}"`);
      for (const opt of staffOptions.options.slice(0, 15)) {
        log(`    ${opt}`);
      }
    }

    // 配置ボタンクリック用のセレクタも確認
    const assignButtons = await k2_2fFrame.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[type="button"]'));
      return btns.map(b => {
        const inp = b as HTMLInputElement;
        return `name="${inp.name}" value="${inp.value}" onclick="${(b.getAttribute('onclick') || '').substring(0, 100)}"`;
      });
    });
    log(`  k2_2f ボタン一覧:`);
    for (const b of assignButtons) {
      log(`    ${b}`);
    }

    // ================================================================
    // STEP 10: k2_2f → 配置実行 → k2_2 に戻る
    // ================================================================
    section('STEP 10: k2_2f 配置実行 → k2_2');

    // スタッフ時間を設定
    await nav.setSelectValue('newstarthour', '10');
    await nav.setSelectValue('newstartminute', '00');
    await nav.setSelectValue('newendhour', '10');
    await nav.setSelectValue('newendminute', '30');

    // 最初のスタッフを自動選択
    const selectedStaff = await k2_2fFrame.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, input[type="button"]'));
      for (const link of links) {
        const onclick = link.getAttribute('onclick') || '';
        if (onclick.includes('helperid') || onclick.includes('act_select')) {
          const text = link.textContent?.trim() || (link as HTMLInputElement).value || '';
          return { text: text.substring(0, 40), onclick: onclick.substring(0, 150) };
        }
      }
      return null;
    });
    if (selectedStaff) {
      log(`  スタッフ選択リンク: text="${selectedStaff.text}" onclick="${selectedStaff.onclick}"`);
    }

    // act_select で配置
    await nav.submitForm({ action: 'act_select', waitForPageId: 'k2_2' });
    await sleep(2000);

    const k2_2AfterAssign = await nav.getMainFrame('k2_2');
    await dumpFrameSelectors(k2_2AfterAssign, 'STEP 10: k2_2 配置後');
    await screenshotFrame(hamPage, k2_2AfterAssign, 'step10-k2_2-after-assign');

    // ================================================================
    // STEP 10.5: 全1ボタン（実績フラグ一括設定）
    // ================================================================
    section('STEP 10.5: k2_2 全1ボタン');

    // 全1ボタンのセレクタを確認
    const allOneButton = await k2_2AfterAssign.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[type="button"]'));
      const results: string[] = [];
      for (const btn of btns) {
        const inp = btn as HTMLInputElement;
        const onclick = btn.getAttribute('onclick') || '';
        if (inp.value.includes('全') || onclick.includes('checkAll') || onclick.includes('results')) {
          results.push(`name="${inp.name}" value="${inp.value}" onclick="${onclick.substring(0, 120)}"`);
        }
      }
      return results;
    });
    log(`  全1関連ボタン:`);
    for (const b of allOneButton) {
      log(`    ${b}`);
    }

    // 全1実行
    await k2_2AfterAssign.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      if (typeof win.checkAllAndSet1 === 'function') {
        win.checkAllAndSet1('results');
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    await sleep(1000);

    // results チェックボックスの状態
    const resultCheckboxes = await k2_2AfterAssign.evaluate(() => {
      const cbs = document.querySelectorAll('input[name="results"]');
      return Array.from(cbs).map(c => {
        const inp = c as HTMLInputElement;
        return `value="${inp.value}" checked=${inp.checked}`;
      });
    });
    log(`  results チェックボックス (${resultCheckboxes.length}):`);
    for (const cb of resultCheckboxes.slice(-5)) {
      log(`    ${cb}`);
    }

    // 緊急時加算チェックボックス
    const urgentCheckboxes = await k2_2AfterAssign.evaluate(() => {
      const cbs = document.querySelectorAll('input[name="urgentflags"]');
      return Array.from(cbs).map(c => {
        const inp = c as HTMLInputElement;
        return `value="${inp.value}" checked=${inp.checked} id="${inp.id}"`;
      });
    });
    log(`  urgentflags チェックボックス (${urgentCheckboxes.length}):`);
    for (const cb of urgentCheckboxes.slice(-3)) {
      log(`    ${cb}`);
    }

    await screenshotFrame(hamPage, k2_2AfterAssign, 'step10_5-k2_2-after-all1');

    // ================================================================
    // STEP 11-12: 上書き保存（実際の保存は行わない → キャンセル操作）
    // ================================================================
    section('STEP 11-12: 上書き保存関連セレクタ（保存はスキップ）');

    const saveButtons = await k2_2AfterAssign.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[type="button"]'));
      return btns
        .filter(b => {
          const inp = b as HTMLInputElement;
          const onclick = b.getAttribute('onclick') || '';
          return inp.value.includes('保存') || inp.value.includes('戻る') ||
                 onclick.includes('act_update') || onclick.includes('act_back') ||
                 onclick.includes('act_delete');
        })
        .map(b => {
          const inp = b as HTMLInputElement;
          const onclick = b.getAttribute('onclick')?.substring(0, 150) || '';
          return `name="${inp.name}" value="${inp.value}" onclick="${onclick}"`;
        });
    });
    log(`  保存/戻るボタン:`);
    for (const b of saveButtons) {
      log(`    ${b}`);
    }

    log('\n  ⚠️ テストデータの保存は行いません。削除処理を実行します...');

    // 追加したスケジュールを削除する
    // まず新規行の削除チェックボックスを ON にする
    const deleteResult = await k2_2AfterAssign.evaluate((targetAssignId) => {
      // 削除チェックボックスを探す
      const rows = Array.from(document.querySelectorAll('tr'));
      for (const row of rows) {
        if (row.innerHTML.includes(targetAssignId)) {
          const delCb = row.querySelector('input[name="deleteflags"], input[type="checkbox"][name*="delete"]') as HTMLInputElement;
          if (delCb) {
            delCb.checked = true;
            delCb.value = '1';
            return { found: true, cbName: delCb.name, cbValue: delCb.value };
          }
        }
      }
      // フォールバック: 最後の deleteflags
      const allDels = document.querySelectorAll('input[name="deleteflags"]');
      if (allDels.length > 0) {
        const last = allDels[allDels.length - 1] as HTMLInputElement;
        last.checked = true;
        last.value = '1';
        return { found: true, cbName: last.name, cbValue: '1', fallback: true };
      }
      return { found: false };
    }, assignId);
    log(`  削除チェック: ${JSON.stringify(deleteResult)}`);

    // 上書き保存（削除を含む）
    await nav.submitForm({
      action: 'act_update',
      setLockCheck: true,
      waitForPageId: 'k2_2',
    });
    await sleep(2000);
    log('  テストデータを削除して上書き保存完了');

    await screenshotFrame(hamPage, await nav.getMainFrame(), 'step12-k2_2-after-cleanup');

    // ================================================================
    // STEP 13: I5ページ (k2_7_1) の確認（介護リハビリ用）
    // ================================================================
    section('STEP 13: k2_7_1 訪看I5入力（介護リハビリ用）確認');

    // k2_2 に戻っているので、I5ボタンの有無を確認
    const k2_2Current = await nav.getMainFrame('k2_2');
    const i5Button = await k2_2Current.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('input[type="button"]'));
      return btns
        .filter(b => {
          const inp = b as HTMLInputElement;
          const onclick = b.getAttribute('onclick') || '';
          return inp.value.includes('I5') || inp.value.includes('訪看') ||
                 onclick.includes('act_i5') || onclick.includes('k2_7');
        })
        .map(b => {
          const inp = b as HTMLInputElement;
          return `name="${inp.name}" value="${inp.value}" onclick="${(b.getAttribute('onclick') || '').substring(0, 150)}"`;
        });
    });
    log(`  I5 関連ボタン (${i5Button.length}):`);
    for (const b of i5Button) {
      log(`    ${b}`);
    }

    // I5ボタンがあれば遷移してセレクタを記録
    if (i5Button.length > 0) {
      try {
        await nav.submitForm({
          action: 'act_i5',
          setLockCheck: true,
          waitForPageId: 'k2_7_1',
          timeout: 10000,
        });
        await sleep(2000);

        const k2_7_1Frame = await nav.getMainFrame('k2_7_1');
        await dumpFrameSelectors(k2_7_1Frame, 'STEP 13: k2_7_1 訪看I5入力');
        await screenshotFrame(hamPage, k2_7_1Frame, 'step13-k2_7_1-i5-input');

        // 戻る
        await nav.submitForm({ action: 'act_back', waitForPageId: 'k2_2' });
        await sleep(1000);
      } catch (e) {
        log(`  k2_7_1 遷移エラー: ${(e as Error).message}`);
      }
    } else {
      log('  I5 ボタンが見つかりませんでした（この患者は介護リハビリ対象外かもしれません）');
    }

    // メインメニューに戻る
    section('テスト完了: メインメニューへ戻る');
    await auth.navigateToMainMenu();
    log('  メインメニューに戻りました');

    log('\n=== 全ステップ完了 ===');

  } catch (err) {
    log(`\n❌ エラー: ${(err as Error).message}`);
    log((err as Error).stack || '');
    try {
      const pages = context.pages();
      for (let i = 0; i < pages.length; i++) {
        await screenshot(pages[i], `error-tab${i}`);
      }
    } catch { /* ignore */ }
  } finally {
    // レポートをファイルに保存
    fs.writeFileSync(LOG_FILE, reportLines.join('\n'), 'utf-8');
    log(`\nレポート保存: ${LOG_FILE}`);

    log('ブラウザを5秒後に閉じます...');
    await sleep(5000);
    await browser.close();
    log('ブラウザ終了');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
