/**
 * 転記フロー逐ステップデバッグ
 *
 * 各ステップ前後でフレーム構造・URL・form 状態を記録し、
 * syserror.jsp が発生するタイミングを正確に特定する。
 */
import dotenv from 'dotenv';
dotenv.config();

import { chromium, Page, Frame, BrowserContext } from 'playwright';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { HamNavigator } from '../core/ham-navigator';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 全フレーム + 全ページの URL をダンプ */
async function dumpState(context: BrowserContext, label: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[STATE] ${label}`);
  console.log(`${'='.repeat(60)}`);

  const pages = context.pages();
  console.log(`  ページ数: ${pages.length}`);
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const title = await p.title().catch(() => '?');
    console.log(`  Page[${i}]: title="${title}" url="${p.url().substring(0, 150)}"`);

    // syserror チェック
    if (p.url().includes('syserror')) {
      console.log(`  *** SYSERROR DETECTED in Page[${i}] URL! ***`);
    }

    const frames = p.frames();
    for (const f of frames) {
      const url = f.url();
      if (url === 'about:blank') continue;
      console.log(`    frame: name="${f.name()}" url="${url.substring(0, 150)}"`);
      if (url.includes('syserror')) {
        console.log(`    *** SYSERROR DETECTED in frame "${f.name()}"! ***`);
      }
    }
  }
}

/** mainFrame の form 情報をダンプ */
async function dumpForm(nav: HamNavigator, pageIdHint?: string) {
  try {
    const frame = await nav.getMainFrame(pageIdHint);
    console.log(`  mainFrame URL: ${frame.url().substring(0, 150)}`);

    const formInfo = await frame.evaluate(() => {
      const form = document.forms[0];
      if (!form) return { hasForm: false, target: '', doAction: '', doTarget: '', fields: [] as string[] };

      const doAction = (form as any).doAction as HTMLInputElement | undefined;
      const doTarget = (form as any).doTarget as HTMLInputElement | undefined;

      // commontarget frame の存在チェック
      let commontargetExists = false;
      try {
        commontargetExists = !!window.parent.frames['commontarget' as any];
      } catch { /* cross-origin */ }

      // もう一つの方法
      let commontargetExists2 = false;
      try {
        const p = window.parent;
        if (p && p !== window) {
          for (let i = 0; i < p.frames.length; i++) {
            try {
              if (p.frames[i].name === 'commontarget') {
                commontargetExists2 = true;
                break;
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }

      const fields: string[] = [];
      const hiddens = Array.from(form.querySelectorAll('input[type="hidden"]'));
      for (const h of hiddens) {
        const inp = h as HTMLInputElement;
        if (['doAction', 'doTarget', 'lockCheck', 'submited'].includes(inp.name)) {
          fields.push(`${inp.name}="${inp.value}"`);
        }
      }

      return {
        hasForm: true,
        target: form.target || '(empty)',
        action: form.action || '(empty)',
        doAction: doAction?.value || '(none)',
        doTarget: doTarget?.value || '(none)',
        commontargetFrame: commontargetExists || commontargetExists2,
        fields,
      };
    });

    console.log(`  form: ${JSON.stringify(formInfo, null, 2)}`);
  } catch (e) {
    console.log(`  form dump error: ${(e as Error).message}`);
  }
}

/** 新しいポップアップウィンドウをチェックして閉じる */
async function checkAndClosePopups(context: BrowserContext, expectedPageCount: number): Promise<boolean> {
  const pages = context.pages();
  if (pages.length > expectedPageCount) {
    console.log(`  *** ポップアップ検出! ページ数 ${pages.length} > 期待値 ${expectedPageCount} ***`);
    for (let i = expectedPageCount; i < pages.length; i++) {
      const url = pages[i].url();
      const title = await pages[i].title().catch(() => '?');
      console.log(`  *** ポップアップ[${i}]: title="${title}" url="${url}" ***`);
      if (url.includes('syserror')) {
        console.log(`  *** syserror.jsp ポップアップを閉じます ***`);
        await pages[i].close();
      }
    }
    return true;
  }
  return false;
}

/** submitForm の代わりに手動で submit し、詳細を記録 */
async function debugSubmitForm(
  nav: HamNavigator,
  context: BrowserContext,
  opts: {
    action: string;
    hiddenFields?: Record<string, string>;
    setLockCheck?: boolean;
    pageIdHint?: string;
    label: string;
  }
): Promise<void> {
  const expectedPageCount = context.pages().length;

  console.log(`\n  --- submitForm: ${opts.label} ---`);
  console.log(`    action="${opts.action}" lockCheck=${opts.setLockCheck || false}`);
  if (opts.hiddenFields) console.log(`    hiddenFields=${JSON.stringify(opts.hiddenFields)}`);

  const frame = await nav.getMainFrame(opts.pageIdHint);
  console.log(`    frame URL: ${frame.url().substring(0, 150)}`);

  // submit 前にフォーム状態を確認
  const preSubmit = await frame.evaluate(() => {
    const form = document.forms[0];
    if (!form) return { error: 'no form' };

    // commontarget 探索
    let ctFound = false;
    let ctMethod = 'none';
    try {
      // 方法1: parent.frames で名前検索
      const p = window.parent;
      if (p && p !== window) {
        for (let i = 0; i < p.frames.length; i++) {
          try {
            const fname = p.frames[i].name;
            if (fname === 'commontarget') {
              ctFound = true;
              ctMethod = 'parent.frames[i].name';
              break;
            }
          } catch { /* cross-origin */ }
        }
      }
    } catch { /* skip */ }

    // 方法2: top.frames
    if (!ctFound) {
      try {
        const t = window.top;
        if (t) {
          for (let i = 0; i < t.frames.length; i++) {
            try {
              const fname = t.frames[i].name;
              if (fname === 'commontarget') {
                ctFound = true;
                ctMethod = 'top.frames[i].name';
                break;
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }

    // 方法3: iframe element
    if (!ctFound) {
      try {
        const iframes = window.top?.document.querySelectorAll('iframe, frame');
        if (iframes) {
          for (const ifr of Array.from(iframes)) {
            if (ifr.getAttribute('name') === 'commontarget') {
              ctFound = true;
              ctMethod = 'top.document.querySelector';
              break;
            }
          }
        }
      } catch { /* skip */ }
    }

    // submited 状態
    const win = window as any;
    return {
      submited: win.submited,
      doAction: (form as any).doAction?.value,
      formTarget: form.target,
      commontargetFound: ctFound,
      commontargetMethod: ctMethod,
      frameNames: (() => {
        const names: string[] = [];
        try {
          const p = window.parent;
          if (p) {
            for (let i = 0; i < p.frames.length; i++) {
              try { names.push(p.frames[i].name || `(unnamed-${i})`); } catch { names.push(`(error-${i})`); }
            }
          }
        } catch { /* skip */ }
        return names;
      })(),
    };
  });
  console.log(`    pre-submit: ${JSON.stringify(preSubmit)}`);

  // submit 実行
  await frame.evaluate((o) => {
    const win = window as any;
    win.submited = 0;
    const form = document.forms[0];
    if (!form) throw new Error('form not found');

    if (o.setLockCheck && (form as any).lockCheck) {
      (form as any).lockCheck.value = '1';
    }
    (form as any).doAction.value = o.action;

    if (o.hiddenFields) {
      for (const [key, val] of Object.entries(o.hiddenFields)) {
        if ((form as any)[key]) {
          (form as any)[key].value = val;
        } else {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = key;
          input.value = val;
          form.appendChild(input);
        }
      }
    }

    form.target = 'commontarget';
    if ((form as any).doTarget) {
      (form as any).doTarget.value = 'commontarget';
    }

    form.submit();
  }, {
    action: opts.action,
    setLockCheck: opts.setLockCheck || false,
    hiddenFields: opts.hiddenFields || {},
  });

  console.log(`    submitted! waiting...`);
  await sleep(3000);

  // ポップアップチェック
  await checkAndClosePopups(context, expectedPageCount);

  // submit 後の状態
  await dumpState(context, `After ${opts.label}`);
}

async function main() {
  console.log('=== 転記フローデバッグ開始 ===\n');

  const auth = new KanamickAuthService({
    url: process.env.KANAMICK_URL!,
    username: process.env.KANAMICK_USERNAME!,
    password: process.env.KANAMICK_PASSWORD!,
    stationName: process.env.KANAMICK_STATION_NAME || '訪問看護ステーションあおぞら姶良',
    hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
    hamOfficeCode: process.env.KANAMICK_HAM_OFFICE_CODE || '400021814',
  });

  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  try {
    auth.setContext(context);

    // === Login ===
    console.log('\n[STEP 0] ログイン...');
    const nav = await auth.login();
    await sleep(2000);
    await dumpState(context, 'After Login');
    await dumpForm(nav);

    // === Step 1: t1-2 → k1_1 ===
    console.log('\n[STEP 1] t1-2 → k1_1 (業務ガイド)');
    await debugSubmitForm(nav, context, {
      action: 'act_k1_1',
      label: 'Step1: act_k1_1',
    });
    await dumpForm(nav, 'k1_1');

    // === Step 2: k1_1 → k2_1 ===
    console.log('\n[STEP 2] k1_1 → k2_1 (利用者検索)');
    await debugSubmitForm(nav, context, {
      action: 'act_k2_1',
      label: 'Step2: act_k2_1',
    });
    await dumpForm(nav, 'k2_1');

    // === Step 3: k2_1 検索実行 ===
    console.log('\n[STEP 3] k2_1 検索 (act_search)');
    // searchdate を設定
    const frame = await nav.getMainFrame('k2_1');
    await frame.evaluate(() => {
      const form = document.forms[0];
      const sel = form?.searchdate as HTMLSelectElement;
      if (sel) {
        // 2026年02月の値を設定（月初日形式）
        for (const opt of Array.from(sel.options)) {
          if (opt.text.includes('2026') && opt.text.includes('02')) {
            sel.value = opt.value;
            console.log(`searchdate set to: ${opt.value} (${opt.text})`);
            break;
          }
        }
      }
    });
    await debugSubmitForm(nav, context, {
      action: 'act_search',
      pageIdHint: 'k2_1',
      label: 'Step3: act_search',
    });
    await dumpForm(nav, 'k2_1');

    // 患者リストがあるか確認
    const searchFrame = await nav.getMainFrame('k2_1');
    const patientCount = await searchFrame.evaluate(() => {
      const buttons = document.querySelectorAll('input[name="act_result"][value="決定"]');
      return buttons.length;
    }).catch(() => 0);
    console.log(`  決定ボタン数 (患者数): ${patientCount}`);

    if (patientCount > 0) {
      // 最初の患者の情報
      const firstPatient = await searchFrame.evaluate(() => {
        const btn = document.querySelector('input[name="act_result"][value="決定"]');
        if (!btn) return null;
        const onclick = btn.getAttribute('onclick') || '';
        const tr = btn.closest('tr');
        const text = tr?.textContent?.trim().substring(0, 100) || '';
        return { onclick: onclick.substring(0, 200), text };
      });
      console.log(`  最初の患者: ${JSON.stringify(firstPatient)}`);

      // === Step 4: submitTargetFormEx で k2_2 へ遷移 ===
      console.log('\n[STEP 4] k2_1 → k2_2 (決定ボタン = submitTargetFormEx)');
      const expectedPages = context.pages().length;

      // HAM のネイティブ submitTargetFormEx を呼ぶ
      const submitResult = await searchFrame.evaluate(() => {
        const win = window as any;
        const form = document.forms[0];

        // submitTargetFormEx 存在チェック
        const hasFunc = typeof win.submitTargetFormEx === 'function';

        // careuserid フィールド存在チェック
        const hasField = !!(form as any).careuserid;

        // 最初の決定ボタン onclick を取得
        const btn = document.querySelector('input[name="act_result"][value="決定"]');
        const onclick = btn?.getAttribute('onclick') || '';

        // careuserid 抽出
        const m = onclick.match(/careuserid\s*,\s*'(\d+)'/);
        const patientId = m ? m[1] : null;

        return {
          hasSubmitTargetFormEx: hasFunc,
          hasCareuseridField: hasField,
          onclick,
          patientId,
          // 他のネイティブ関数チェック
          hasSubmitTargetForm: typeof win.submitTargetForm === 'function',
          hasSubmitForm: typeof win.submitForm === 'function',
        };
      });
      console.log(`  submitTargetFormEx 状態: ${JSON.stringify(submitResult, null, 2)}`);

      if (submitResult.patientId) {
        console.log(`  患者ID: ${submitResult.patientId}`);
        console.log(`  submitTargetFormEx で submit 実行...`);

        // 方法A: ネイティブ関数を呼ぶ
        if (submitResult.hasSubmitTargetFormEx) {
          console.log('  → submitTargetFormEx を直接呼び出し');
          await searchFrame.evaluate((pid) => {
            const win = window as any;
            const form = document.forms[0];
            win.submitTargetFormEx(form, 'k2_2', form.careuserid, pid);
          }, submitResult.patientId);
        } else {
          // 方法B: onclick を直接実行
          console.log('  → submitTargetFormEx が見つからないため、onclick を直接実行');
          const btn = await searchFrame.$('input[name="act_result"][value="決定"]');
          if (btn) {
            await btn.click();
          }
        }

        console.log('  submitted! waiting...');
        await sleep(5000);
        await checkAndClosePopups(context, expectedPages);
        await dumpState(context, 'After Step 4 (submitTargetFormEx)');
        await dumpForm(nav);
      } else {
        console.log('  患者ID 抽出失敗、Step 4 スキップ');
      }
    }

    console.log('\n=== デバッグ完了 ===');
    console.log('ブラウザを閉じるには Ctrl+C を押してください...');
    await sleep(60000);

  } catch (e) {
    console.error(`\nエラー: ${(e as Error).message}`);
    console.error((e as Error).stack);
    await dumpState(context, 'Error state');
    console.log('ブラウザを閉じるには Ctrl+C を押してください...');
    await sleep(60000);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
