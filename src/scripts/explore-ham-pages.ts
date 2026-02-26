/**
 * HAM ページ遷移探索スクリプト
 * 
 * ログイン後、各 HAM ページの form 構造と action を解析する
 */
import dotenv from 'dotenv';
dotenv.config();

import { chromium, Frame } from 'playwright';
import { KanamickAuthService, KanamickAuthConfig } from '../services/kanamick-auth.service';

async function dumpFrameForm(frame: Frame, label: string) {
  console.log(`\n=== ${label} ===`);
  console.log(`  URL: ${frame.url()}`);
  
  try {
    const formInfo = await frame.evaluate(() => {
      const form = document.forms[0];
      if (!form) return { hasForm: false, action: '', elements: [] as string[] };
      
      const elements: string[] = [];
      // Hidden fields
      const hiddens = Array.from(form.querySelectorAll('input[type="hidden"]'));
      for (const h of hiddens) {
        const inp = h as HTMLInputElement;
        elements.push(`HIDDEN: name="${inp.name}" value="${inp.value}"`);
      }
      
      // doAction field
      const doAction = form.doAction as HTMLInputElement | undefined;
      const doTarget = form.doTarget as HTMLInputElement | undefined;
      const lockCheck = form.lockCheck as HTMLInputElement | undefined;
      
      // Buttons / links with onclick
      const buttons = Array.from(form.querySelectorAll('input[type="button"], input[type="submit"], button, a[href*="javascript"]'));
      for (const b of buttons) {
        const text = b.textContent?.trim().substring(0, 50) || '';
        const onclick = b.getAttribute('onclick')?.substring(0, 200) || '';
        const value = (b as HTMLInputElement).value || '';
        elements.push(`BUTTON: tag=${b.tagName} text="${text}" value="${value}" onclick="${onclick}"`);
      }
      
      // All links
      const links = Array.from(form.querySelectorAll('a'));
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const onclick = a.getAttribute('onclick') || '';
        if (onclick || href.includes('javascript')) {
          elements.push(`LINK: text="${a.textContent?.trim().substring(0, 50)}" href="${href.substring(0, 100)}" onclick="${onclick.substring(0, 200)}"`);
        }
      }
      
      // Select elements
      const selects = Array.from(form.querySelectorAll('select'));
      for (const sel of selects) {
        const opts = Array.from(sel.options).map(o => `${o.value}="${o.text}"`).join(', ');
        elements.push(`SELECT: name="${sel.name}" id="${sel.id}" options=[${opts}]`);
      }
      
      return {
        hasForm: true,
        action: form.action,
        method: form.method,
        target: form.target,
        doAction: doAction?.value || 'N/A',
        doTarget: doTarget?.value || 'N/A',
        lockCheck: lockCheck?.value || 'N/A',
        elements,
      };
    });
    
    if (formInfo.hasForm) {
      console.log(`  Form action: ${formInfo.action}`);
      console.log(`  Form method: ${formInfo.method}`);
      console.log(`  Form target: ${formInfo.target}`);
      console.log(`  doAction: ${formInfo.doAction}`);
      console.log(`  doTarget: ${formInfo.doTarget}`);
      console.log(`  lockCheck: ${formInfo.lockCheck}`);
      console.log(`  Elements (${formInfo.elements.length}):`);
      for (const el of formInfo.elements) {
        console.log(`    ${el}`);
      }
    } else {
      console.log('  No form found');
    }
    
    // Also get text content for context
    const text = await frame.evaluate(() => document.body?.innerText?.substring(0, 800) || '');
    console.log(`  Content: ${text.substring(0, 500)}`);
  } catch (e) {
    console.log(`  Error: ${(e as Error).message}`);
  }
}

async function main() {
  console.log('=== HAM Page Explorer ===\n');
  
  const config: KanamickAuthConfig = {
    url: process.env.KANAMICK_URL || 'https://portal.kanamic.net/tritrus/index/',
    username: process.env.KANAMICK_USERNAME || '',
    password: process.env.KANAMICK_PASSWORD || '',
    stationName: process.env.KANAMICK_STATION_NAME || '訪問看護ステーションあおぞら姶良',
    hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
    hamOfficeCode: process.env.KANAMICK_HAM_OFFICE_CODE || '400021814',
  };
  
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false', slowMo: 50 });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'ja-JP' });
  context.on('page', (page) => {
    page.on('dialog', async (dialog) => { await dialog.accept(); });
  });
  
  const auth = new KanamickAuthService(config);
  auth.setContext(context);
  
  try {
    // Login
    console.log('Logging in...');
    const nav = await auth.login();
    console.log('✅ Login successful\n');
    
    // Explore t1-2 (main menu)
    const mainFrame = await nav.getMainFrame();
    await dumpFrameForm(mainFrame, 'Page t1-2 (総合メニュー)');
    
    // Navigate to k1_1 (業務ガイド)
    console.log('\n--- Navigating to k1_1 ---');
    await auth.navigateToBusinessGuide();
    const k1_1Frame = await nav.getMainFrame('k1_1');
    await dumpFrameForm(k1_1Frame, 'Page k1_1 (訪問看護業務ガイド)');
    
    // Try navigating to k2_1 from k1_1
    // First, let's see what actions are available on k1_1
    console.log('\n--- Attempting k2_1 navigation ---');
    // Look at the k1_1 form JavaScript context for xinwork functions
    const jsContext = await k1_1Frame.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      const funcs: string[] = [];
      // Check for common HAM JS functions
      for (const name of ['xinwork_goAction', 'xinwork_searchKeyword', 'goPageAction', 'doAction', 'goPage']) {
        if (typeof win[name] === 'function') {
          funcs.push(name);
        }
      }
      return {
        functions: funcs,
        hasSubmited: typeof win.submited !== 'undefined',
        submited: win.submited,
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    console.log(`  JS context: ${JSON.stringify(jsContext)}`);
    
    // Try direct doAction for k2_1
    console.log('\n  Trying doAction=act_k2_1 ...');
    try {
      await nav.submitForm({ action: 'act_k2_1', waitForPageId: 'k2_1', timeout: 10000 });
      const k2_1Frame = await nav.getMainFrame('k2_1');
      await dumpFrameForm(k2_1Frame, 'Page k2_1 (利用者検索)');
    } catch (e1) {
      console.log(`  act_k2_1 failed: ${(e1 as Error).message}`);
      
      // Try without act_ prefix
      console.log('\n  Trying doAction=k2_1 ...');
      try {
        // Go back to k1_1 first
        await nav.submitForm({ action: 'act_k1_1', waitForPageId: 'k1_1', timeout: 10000 });
        await nav.submitForm({ action: 'k2_1', waitForPageId: 'k2_1', timeout: 10000 });
        const k2_1Frame2 = await nav.getMainFrame('k2_1');
        await dumpFrameForm(k2_1Frame2, 'Page k2_1 (利用者検索)');
      } catch (e2) {
        console.log(`  k2_1 failed: ${(e2 as Error).message}`);
        
        // Dump current frame state
        const currentFrame = await nav.getMainFrame();
        console.log(`  Current frame URL: ${currentFrame.url()}`);
        await dumpFrameForm(currentFrame, 'Current Frame After k2_1 attempt');
      }
    }

    console.log('\n=== Exploration complete ===');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
  } catch (err) {
    console.error('❌ Error:', err);
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
