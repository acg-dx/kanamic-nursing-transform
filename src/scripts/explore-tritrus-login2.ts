/**
 * TRITRUS → HAM ログインフロー探索 Part 2
 * 
 * 発見: goCicHam.jsp がリダイレクトページ。k=6 のリンクを使用。
 * リダイレクト完了後の HAM ページ構造を解析する。
 */
import dotenv from 'dotenv';
dotenv.config();

import { chromium, Page, BrowserContext } from 'playwright';

const SCREENSHOTS_DIR = './screenshots';

async function screenshot(page: Page, name: string) {
  try {
    const path = `${SCREENSHOTS_DIR}/${name}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(`  📸 ${path}`);
  } catch (e) {
    console.log(`  📸 Screenshot failed: ${(e as Error).message}`);
  }
}

async function main() {
  console.log('=== TRITRUS → HAM Login Explorer Part 2 ===\n');
  
  const url = process.env.KANAMICK_URL || 'https://portal.kanamic.net/tritrus/index/';
  const username = process.env.KANAMICK_USERNAME || '';
  const password = process.env.KANAMICK_PASSWORD || '';
  
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    slowMo: 50,
  });
  
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'ja-JP',
  });
  
  // Auto-accept dialogs on ALL pages
  context.on('page', (page) => {
    page.on('dialog', async (dialog) => {
      console.log(`  💬 Dialog [${dialog.type()}]: ${dialog.message()}`);
      await dialog.accept();
    });
  });

  try {
    // Step 1: Login
    console.log('Step 1: TRITRUS Login...');
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    
    // Fill credentials
    await page.fill('#josso_username', username);
    await page.fill('#josso_password', password);
    console.log('  Credentials filled');
    
    // Click login button
    await page.click('input.submit-button[type="button"]');
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    await page.waitForTimeout(2000);
    console.log(`  Logged in. URL: ${page.url()}`);
    await screenshot(page, '10-logged-in');
    
    // Step 2: Filter to 訪問看護
    console.log('\nStep 2: Filter service type...');
    // Set service type to 訪問看護 (value=4)
    await page.evaluate(() => {
      const sel = document.getElementById('searchServiceTypeText') as HTMLSelectElement;
      if (sel) {
        sel.value = '4';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    console.log('  Set searchServiceTypeText = 4 (訪問看護)');
    
    // Click search  
    await page.click('button.btn-search');
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    await page.waitForTimeout(2000);
    console.log('  Search clicked');
    await screenshot(page, '11-filtered');
    
    // Step 3: Find the correct HAM link (k=6 for 姶良)
    console.log('\nStep 3: Find HAM link with k=6...');
    
    // List all goCicHam links
    const hamLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href*="goCicHam"]'))
        .map(a => ({
          text: a.textContent?.trim(),
          href: a.getAttribute('href'),
          target: a.getAttribute('target'),
        }));
    });
    console.log(`  Found ${hamLinks.length} goCicHam links:`);
    for (const link of hamLinks) {
      console.log(`    "${link.text}" href="${link.href}" target="${link.target}"`);
    }
    
    // Find the k=6 link specifically
    const k6Link = await page.$('a[href*="goCicHam.jsp"][href*="k=6"]');
    if (!k6Link) {
      console.log('  ❌ k=6 link not found!');
      // Fallback: try any 姶良 link
      const airaLink = await page.$('a:has-text("姶良")');
      if (airaLink) {
        const href = await airaLink.getAttribute('href');
        console.log(`  Fallback 姶良 link: ${href}`);
      }
      await browser.close();
      return;
    }
    
    const k6Info = await k6Link.evaluate(el => ({
      text: el.textContent?.trim(),
      href: (el as HTMLAnchorElement).href,
      target: (el as HTMLAnchorElement).target,
    }));
    console.log(`  ✅ k=6 link found: "${k6Info.text}" target="${k6Info.target}"`);
    console.log(`    href="${k6Info.href}"`);
    
    // Step 4: Click the k=6 link and handle redirect
    console.log('\nStep 4: Click k=6 link and wait for redirect...');
    
    // Listen for new page
    const newPagePromise = context.waitForEvent('page', { timeout: 15000 });
    await k6Link.click();
    console.log('  Clicked k=6 link');
    
    const hamPage = await newPagePromise;
    console.log(`  New tab opened: ${hamPage.url()}`);
    
    // Wait for the goCicHam.jsp to redirect to the actual HAM URL
    // This page will redirect, so we wait for the final URL
    console.log('  Waiting for redirect...');
    
    try {
      // Wait for the page to settle on a final URL (not goCicHam.jsp)
      await hamPage.waitForURL('**/kanamic/ham/**', { timeout: 30000 });
      console.log(`  ✅ Redirected to HAM: ${hamPage.url()}`);
    } catch {
      console.log(`  Redirect did not reach expected URL pattern`);
      console.log(`  Current URL: ${hamPage.url()}`);
      
      // Try waiting for load
      try {
        await hamPage.waitForLoadState('load', { timeout: 15000 });
        console.log(`  After load: ${hamPage.url()}`);
      } catch {
        console.log(`  Load timeout, URL: ${hamPage.url()}`);
      }
    }
    
    await hamPage.waitForTimeout(3000);
    console.log(`  Final URL: ${hamPage.url()}`);
    
    try {
      const title = await hamPage.title();
      console.log(`  Title: ${title}`);
    } catch (e) {
      console.log(`  Title error: ${(e as Error).message}`);
    }
    
    await screenshot(hamPage, '12-ham-page');
    
    // Step 5: Analyze HAM page structure
    console.log('\nStep 5: Analyze HAM page structure...');
    
    // List all frames
    const frames = hamPage.frames();
    console.log(`  Frames (${frames.length}):`);
    for (const f of frames) {
      console.log(`    name="${f.name()}" url="${f.url().substring(0, 150)}"`);
    }
    
    // Check for venobox popup
    const venobox = await hamPage.$('div.vbox-close');
    if (venobox && await venobox.isVisible()) {
      console.log('  VenoBox popup detected, closing...');
      await venobox.click();
      await hamPage.waitForTimeout(1000);
      console.log('  VenoBox closed');
    } else {
      // Check for venobox overlay
      const overlay = await hamPage.$('.vbox-overlay');
      if (overlay) {
        const visible = await overlay.isVisible();
        console.log(`  VenoBox overlay: visible=${visible}`);
      } else {
        console.log('  No VenoBox popup detected');
      }
    }
    
    await screenshot(hamPage, '13-ham-after-venobox');
    
    // Step 6: Try to navigate to main frame content
    console.log('\nStep 6: Explore frame content...');
    
    // Look for kanamicmain frame
    const kanamicmain = hamPage.frame('kanamicmain');
    if (kanamicmain) {
      console.log('  ✅ Found kanamicmain frame');
      console.log(`    URL: ${kanamicmain.url()}`);
      
      // List child frames
      const children = kanamicmain.childFrames();
      console.log(`    Child frames (${children.length}):`);
      for (const child of children) {
        console.log(`      name="${child.name()}" url="${child.url().substring(0, 150)}"`);
      }
    } else {
      console.log('  kanamicmain frame not found');
    }
    
    // Look for mainFrame
    const mainFrame = hamPage.frame('mainFrame');
    if (mainFrame) {
      console.log('  ✅ Found mainFrame');
      console.log(`    URL: ${mainFrame.url()}`);
      
      // Get content of mainFrame
      try {
        const content = await mainFrame.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
        console.log(`    Content (first 500 chars): ${content}`);
      } catch (e) {
        console.log(`    Content error: ${(e as Error).message}`);
      }
    } else {
      console.log('  mainFrame not found');
    }
    
    // Find frames with goPageAction
    const actionFrames = frames.filter(f => f.url().includes('goPageAction') || f.url().includes('Action.go'));
    console.log(`  Action frames: ${actionFrames.length}`);
    for (const f of actionFrames) {
      console.log(`    name="${f.name()}" url="${f.url()}`);
    }
    
    // Step 7: Get full page HTML structure (top level only)
    console.log('\nStep 7: HAM page HTML structure...');
    try {
      const htmlStructure = await hamPage.evaluate(() => {
        const getStructure = (el: Element, depth: number): string => {
          if (depth > 3) return '';
          const indent = '  '.repeat(depth);
          const tag = el.tagName.toLowerCase();
          const attrs: string[] = [];
          if (el.id) attrs.push(`id="${el.id}"`);
          if (el.getAttribute('name')) attrs.push(`name="${el.getAttribute('name')}"`);
          if (tag === 'frame' || tag === 'iframe') {
            attrs.push(`src="${(el as HTMLFrameElement).src?.substring(0, 120)}"`);
          }
          if (tag === 'frameset') {
            if (el.getAttribute('rows')) attrs.push(`rows="${el.getAttribute('rows')}"`);
            if (el.getAttribute('cols')) attrs.push(`cols="${el.getAttribute('cols')}"`);
          }
          const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
          let result = `${indent}<${tag}${attrStr}>\n`;
          for (const child of Array.from(el.children)) {
            result += getStructure(child, depth + 1);
          }
          return result;
        };
        return getStructure(document.documentElement, 0);
      });
      console.log(htmlStructure.substring(0, 2000));
    } catch (e) {
      console.log(`  HTML structure error: ${(e as Error).message}`);
    }
    
    // Final summary
    console.log('\n=== SUMMARY ===');
    console.log(`TRITRUS URL: ${page.url()}`);
    console.log(`HAM URL: ${hamPage.url()}`);
    console.log(`Total tabs: ${context.pages().length}`);
    for (let i = 0; i < context.pages().length; i++) {
      console.log(`  Tab ${i}: ${context.pages()[i].url().substring(0, 100)}`);
    }
    
    console.log('\nBrowser closing in 3 seconds...');
    await hamPage.waitForTimeout(3000);
    
  } catch (err) {
    console.error('❌ Error:', err);
    const pages = context.pages();
    for (let i = 0; i < pages.length; i++) {
      await screenshot(pages[i], `error-tab${i}`);
    }
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
