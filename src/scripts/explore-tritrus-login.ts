/**
 * TRITRUS → HAM ログインフロー探索スクリプト
 * 
 * 目的: 各ステップでスクリーンショットを撮り、全てのセレクタと遷移先を記録する
 * 実行: HEADLESS=false npx tsx src/scripts/explore-tritrus-login.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { chromium, Page, BrowserContext } from 'playwright';

const SCREENSHOTS_DIR = './screenshots';

async function screenshot(page: Page, name: string) {
  const path = `${SCREENSHOTS_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(`  📸 Screenshot: ${path}`);
}

async function dumpPageInfo(page: Page, label: string) {
  console.log(`\n=== ${label} ===`);
  console.log(`  URL: ${page.url()}`);
  console.log(`  Title: ${await page.title()}`);
}

async function dumpFormElements(page: Page) {
  const info = await page.evaluate(() => {
    const results: string[] = [];
    
    // Inputs
    const inputs = Array.from(document.querySelectorAll('input'));
    for (const el of inputs) {
      if (el.type === 'hidden') continue;
      results.push(`  INPUT: type="${el.type}" id="${el.id}" name="${el.name}" class="${el.className}" value="${el.value}" placeholder="${el.placeholder}"`);
    }
    
    // Selects
    const selects = Array.from(document.querySelectorAll('select'));
    for (const el of selects) {
      const opts = Array.from(el.options).map(o => `${o.value}="${o.text}"`).join(', ');
      results.push(`  SELECT: id="${el.id}" name="${el.name}" options=[${opts}]`);
    }
    
    // Buttons
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
    for (const el of buttons) {
      const inp = el as HTMLInputElement;
      results.push(`  BUTTON: tag=${el.tagName} type="${inp.type}" id="${el.id}" class="${el.className}" text="${el.textContent?.trim().substring(0, 50)}" value="${inp.value || ''}"`);
    }
    
    return results;
  });
  
  console.log('  Form elements:');
  for (const line of info) {
    console.log(line);
  }
}

async function dumpAllLinks(page: Page, maxLinks = 80) {
  const links = await page.evaluate((max) => {
    return Array.from(document.querySelectorAll('a'))
      .filter(a => a.href || a.getAttribute('onclick'))
      .slice(0, max)
      .map(a => ({
        text: a.textContent?.trim().substring(0, 80) || '',
        href: a.href?.substring(0, 120) || '',
        target: a.getAttribute('target') || '',
        onclick: a.getAttribute('onclick')?.substring(0, 120) || '',
        id: a.id,
        className: a.className?.substring(0, 60) || '',
      }));
  }, maxLinks);
  
  console.log(`  Links (${links.length}):`);
  for (const link of links) {
    const parts = [`    "${link.text}"`];
    if (link.href) parts.push(`href="${link.href}"`);
    if (link.target) parts.push(`target="${link.target}"`);
    if (link.onclick) parts.push(`onclick="${link.onclick}"`);
    if (link.id) parts.push(`id="${link.id}"`);
    console.log(parts.join(' | '));
  }
}

async function dumpIframes(page: Page) {
  const frames = page.frames();
  if (frames.length > 1) {
    console.log(`  Frames (${frames.length}):`);
    for (const f of frames) {
      console.log(`    name="${f.name()}" url="${f.url().substring(0, 120)}"`);
    }
  } else {
    console.log('  No iframes detected');
  }
}

async function main() {
  console.log('=== TRITRUS → HAM Login Flow Explorer ===\n');
  
  const url = process.env.KANAMICK_URL || 'https://portal.kanamic.net/tritrus/index/';
  const username = process.env.KANAMICK_USERNAME || '';
  const password = process.env.KANAMICK_PASSWORD || '';
  
  console.log(`URL: ${url}`);
  console.log(`Username: ${username}`);
  console.log();

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    slowMo: 100,
  });
  
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'ja-JP',
  });
  
  // Track new pages/tabs
  const allPages: Page[] = [];
  context.on('page', (page) => {
    console.log(`  🆕 New tab opened: ${page.url()}`);
    allPages.push(page);
  });
  
  // Auto-accept dialogs
  context.on('page', (page) => {
    page.on('dialog', async (dialog) => {
      console.log(`  💬 Dialog [${dialog.type()}]: ${dialog.message()}`);
      await dialog.accept();
    });
  });

  try {
    // ===== STEP 1: Login page =====
    console.log('\n========== STEP 1: Navigate to login page ==========');
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await dumpPageInfo(page, 'Login Page');
    await dumpFormElements(page);
    await screenshot(page, '01-login-page');
    
    // ===== STEP 2: Fill credentials and login =====
    console.log('\n========== STEP 2: Fill credentials and login ==========');
    
    // Find username field
    const userField = await page.$('input#userId')
      || await page.$('input[name="userId"]')
      || await page.$('input[name="username"]')
      || await page.$('input[type="text"]');
    if (!userField) {
      console.log('  ❌ Username field not found!');
      await browser.close();
      return;
    }
    const userSelector = await page.evaluate((el) => {
      const e = el as HTMLInputElement;
      return `id="${e.id}" name="${e.name}" type="${e.type}"`;
    }, userField);
    console.log(`  Username field found: ${userSelector}`);
    await userField.fill(username);
    
    // Find password field
    const passField = await page.$('input#password')
      || await page.$('input[name="password"]')
      || await page.$('input[type="password"]');
    if (!passField) {
      console.log('  ❌ Password field not found!');
      await browser.close();
      return;
    }
    await passField.fill(password);
    console.log('  Password filled');
    
    // Find login button
    const loginBtnSelectors = [
      'button.btn-login', 'button:has-text("ログイン")', 'input[type="submit"]',
      'button[type="submit"]', 'a:has-text("ログイン")', '#loginButton',
      '.login-button', '.login-btn', '[onclick*="login"]', 'form button',
      'form input[type="button"]',
    ];
    let loginBtn = null;
    let loginBtnSelector = '';
    for (const sel of loginBtnSelectors) {
      loginBtn = await page.$(sel);
      if (loginBtn) {
        loginBtnSelector = sel;
        break;
      }
    }
    if (!loginBtn) {
      console.log('  ❌ Login button not found!');
      await dumpFormElements(page);
      await browser.close();
      return;
    }
    console.log(`  Login button found: ${loginBtnSelector}`);
    
    // Click login and wait
    const tabCountBefore = context.pages().length;
    await loginBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    await page.waitForTimeout(2000);
    
    const tabCountAfter = context.pages().length;
    console.log(`  Tabs: ${tabCountBefore} → ${tabCountAfter}`);
    
    await dumpPageInfo(page, 'After Login');
    await screenshot(page, '02-after-login');
    
    // ===== STEP 3: Post-login page analysis =====
    console.log('\n========== STEP 3: Post-login page deep analysis ==========');
    await dumpFormElements(page);
    await dumpAllLinks(page);
    await dumpIframes(page);
    
    // Look for HAM-related links specifically
    const hamLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a'))
        .filter(a => {
          const href = a.href || '';
          const text = a.textContent || '';
          const onclick = a.getAttribute('onclick') || '';
          return href.includes('ham') || href.includes('kanamic') || 
                 text.includes('HAM') || text.includes('姶良') || 
                 text.includes('訪問看護') || onclick.includes('ham');
        })
        .map(a => ({
          text: a.textContent?.trim().substring(0, 100),
          href: a.href?.substring(0, 150),
          target: a.getAttribute('target'),
          onclick: a.getAttribute('onclick')?.substring(0, 200),
          outerHTML: a.outerHTML.substring(0, 300),
        }));
    });
    console.log('\n  HAM/Kanamick-related links:');
    for (const link of hamLinks) {
      console.log(`    text="${link.text}"`);
      console.log(`    href="${link.href}"`);
      console.log(`    target="${link.target}"`);
      console.log(`    onclick="${link.onclick}"`);
      console.log(`    outerHTML="${link.outerHTML}"`);
      console.log();
    }
    
    // ===== STEP 4: Service type selection =====
    console.log('\n========== STEP 4: Service type selection ==========');
    
    // Try to find service type select
    const selectInfo = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      return selects.map(s => {
        const options = Array.from(s.options).map(o => ({ value: o.value, text: o.text }));
        return { id: s.id, name: s.name, className: s.className, options };
      });
    });
    console.log(`  Found ${selectInfo.length} select elements:`);
    for (const sel of selectInfo) {
      console.log(`    SELECT id="${sel.id}" name="${sel.name}" class="${sel.className}"`);
      for (const opt of sel.options) {
        console.log(`      option value="${opt.value}" text="${opt.text}"`);
      }
    }
    
    // Find select with 訪問看護 option and set it
    const houkanSelect = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const houkanOpt = Array.from(sel.options).find(o => o.text.includes('訪問看護'));
        if (houkanOpt) {
          sel.value = houkanOpt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          try {
            const jq = (window as unknown as { jQuery?: (el: HTMLElement) => { trigger: (ev: string) => void } }).jQuery;
            if (jq) jq(sel).trigger('chosen:updated');
          } catch { /* ignore */ }
          return { id: sel.id, name: sel.name, value: houkanOpt.value, text: houkanOpt.text };
        }
      }
      return null;
    });
    
    if (houkanSelect) {
      console.log(`  Selected 訪問看護: ${JSON.stringify(houkanSelect)}`);
    } else {
      console.log('  ❌ No 訪問看護 option found in any select');
    }
    
    // Look for the station name select or another way to filter
    const stationSelect = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const airaOpt = Array.from(sel.options).find(o => o.text.includes('姶良'));
        if (airaOpt) {
          return { id: sel.id, name: sel.name, value: airaOpt.value, text: airaOpt.text };
        }
      }
      return null;
    });
    if (stationSelect) {
      console.log(`  Station select found: ${JSON.stringify(stationSelect)}`);
    }
    
    await screenshot(page, '03-service-selected');
    
    // Click search button
    const searchBtnSelectors = [
      'input[value="検索"]', 'button:has-text("検索")', 'a:has-text("検索")',
      '#searchButton', 'input[type="button"][value*="検索"]',
    ];
    let searchBtn = null;
    let searchBtnSel = '';
    for (const sel of searchBtnSelectors) {
      searchBtn = await page.$(sel);
      if (searchBtn) {
        searchBtnSel = sel;
        break;
      }
    }
    
    if (searchBtn) {
      console.log(`  Search button found: ${searchBtnSel}`);
      await searchBtn.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await page.waitForTimeout(2000);
      console.log('  Search clicked');
    } else {
      console.log('  No search button found');
    }
    
    await screenshot(page, '04-after-search');
    
    // ===== STEP 5: Find and analyze the office link =====
    console.log('\n========== STEP 5: Find office link for 姶良 ==========');
    await dumpAllLinks(page, 100);
    
    // Look specifically for 姶良 link with detailed analysis
    const airaLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a'))
        .filter(a => {
          const text = a.textContent || '';
          const href = a.href || '';
          return text.includes('姶良') || href.includes('姶良');
        })
        .map(a => ({
          text: a.textContent?.trim(),
          href: a.href,
          target: a.getAttribute('target'),
          onclick: a.getAttribute('onclick'),
          outerHTML: a.outerHTML.substring(0, 500),
          parentHTML: a.parentElement?.outerHTML.substring(0, 500),
        }));
    });
    console.log('\n  姶良 links analysis:');
    for (const link of airaLinks) {
      console.log(`    text: "${link.text}"`);
      console.log(`    href: "${link.href}"`);
      console.log(`    target: "${link.target}"`);
      console.log(`    onclick: "${link.onclick}"`);
      console.log(`    outerHTML: "${link.outerHTML}"`);
      console.log(`    parentHTML: "${link.parentHTML}"`);
      console.log();
    }
    
    // Also look for hamfromout links
    const hamfromoutLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href*="hamfromout"], a[href*="ham"], a[onclick*="ham"]'))
        .map(a => ({
          text: a.textContent?.trim().substring(0, 80),
          href: (a as HTMLAnchorElement).href?.substring(0, 200),
          target: a.getAttribute('target'),
          onclick: a.getAttribute('onclick')?.substring(0, 200),
          outerHTML: a.outerHTML.substring(0, 400),
        }));
    });
    console.log('  HAM links on current page:');
    for (const link of hamfromoutLinks) {
      console.log(`    text="${link.text}" href="${link.href}" target="${link.target}" onclick="${link.onclick}"`);
      console.log(`    html: ${link.outerHTML}`);
    }
    
    await screenshot(page, '05-before-click-office');
    
    // ===== STEP 6: Click the office link =====
    console.log('\n========== STEP 6: Click office link ==========');
    
    // Find the link
    const officeLink = await page.$('a:has-text("姶良")')
      || await page.$('a:has-text("訪問看護ステーションあおぞら姶良")');
    
    if (!officeLink) {
      console.log('  ❌ Office link not found! Looking for any clickable element with 姶良...');
      const anyAira = await page.$('*:has-text("姶良")');
      if (anyAira) {
        const tagName = await anyAira.evaluate(el => el.tagName);
        console.log(`  Found element: ${tagName}`);
      }
      // Try table rows or list items
      const tableInfo = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('tr'));
        return rows
          .filter(r => r.textContent?.includes('姶良'))
          .map(r => ({
            html: r.outerHTML.substring(0, 500),
            text: r.textContent?.trim().substring(0, 200),
          }));
      });
      console.log('  Table rows with 姶良:');
      for (const row of tableInfo) {
        console.log(`    text: ${row.text}`);
        console.log(`    html: ${row.html}`);
      }
    } else {
      const linkInfo = await officeLink.evaluate(el => ({
        text: el.textContent?.trim(),
        href: (el as HTMLAnchorElement).href,
        target: (el as HTMLAnchorElement).target,
        onclick: el.getAttribute('onclick'),
      }));
      console.log(`  Office link details: ${JSON.stringify(linkInfo, null, 2)}`);
      
      // Monitor for new tabs
      const pagesBeforeClick = context.pages().length;
      console.log(`  Pages before click: ${pagesBeforeClick}`);
      
      // Wait for potential new tab
      const newPagePromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
      
      await officeLink.click();
      console.log('  Clicked office link');
      
      const newPage = await newPagePromise;
      const pagesAfterClick = context.pages().length;
      console.log(`  Pages after click: ${pagesAfterClick}`);
      
      if (newPage) {
        console.log(`  ✅ New tab opened!`);
        await newPage.waitForLoadState('load', { timeout: 30000 });
        await dumpPageInfo(newPage, 'New Tab (HAM?)');
        await dumpIframes(newPage);
        await screenshot(newPage, '06-new-tab');
      } else {
        console.log('  ⚠️ No new tab opened. Same-tab navigation.');
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
        
        await dumpPageInfo(page, 'After Click (Same Tab)');
        await screenshot(page, '06-after-click-same-tab');
        
        // Deep analysis of intermediate page
        console.log('\n  === Intermediate Page Analysis ===');
        await dumpFormElements(page);
        await dumpIframes(page);
        
        // Look for HAM launch elements on this page
        const hamElements = await page.evaluate(() => {
          const results: string[] = [];
          
          // Links with HAM-related hrefs
          const links = Array.from(document.querySelectorAll('a'));
          for (const a of links) {
            if (a.href?.includes('ham') || a.href?.includes('kanamic.net') || 
                a.getAttribute('onclick')?.includes('ham') || 
                a.textContent?.includes('HAM')) {
              results.push(`LINK: text="${a.textContent?.trim()}" href="${a.href}" target="${a.target}" onclick="${a.getAttribute('onclick')}" html="${a.outerHTML.substring(0, 400)}"`);
            }
          }
          
          // Icons/images that might be HAM launch buttons
          const imgs = Array.from(document.querySelectorAll('img'));
          for (const img of imgs) {
            const parent = img.parentElement;
            if (parent?.tagName === 'A') {
              const a = parent as HTMLAnchorElement;
              if (a.href?.includes('ham') || a.href?.includes('kanamic')) {
                results.push(`IMG-LINK: src="${img.src}" alt="${img.alt}" parent-href="${a.href}" target="${a.target}"`);
              }
            }
          }
          
          // Any element with onclick containing window.open or ham
          const allElements = Array.from(document.querySelectorAll('[onclick]'));
          for (const el of allElements) {
            const onclick = el.getAttribute('onclick') || '';
            if (onclick.includes('open') || onclick.includes('ham') || onclick.includes('kanamic')) {
              results.push(`ONCLICK: tag="${el.tagName}" text="${el.textContent?.trim().substring(0, 80)}" onclick="${onclick.substring(0, 300)}"`);
            }
          }
          
          // iframes
          const iframes = Array.from(document.querySelectorAll('iframe'));
          for (const iframe of iframes) {
            results.push(`IFRAME: src="${iframe.src}" name="${iframe.name}" id="${iframe.id}"`);
          }
          
          return results;
        });
        
        console.log('  HAM-related elements on intermediate page:');
        for (const el of hamElements) {
          console.log(`    ${el}`);
        }
        
        // Dump ALL links on this page
        console.log('\n  ALL links on intermediate page:');
        await dumpAllLinks(page, 100);
        
        // ===== STEP 7: Try to find and click HAM link on intermediate page =====
        console.log('\n========== STEP 7: Look for HAM link on intermediate page ==========');
        
        // Try various HAM link patterns
        const hamLinkPatterns = [
          'a[href*="hamfromout"]',
          'a[href*="www2.kanamic.net"]',
          'a[href*="kanamic.net/kanamic/ham"]',
          'a[target="_blank"]',
          'a:has-text("HAM")',
          'img[alt*="HAM"]',
          'a[onclick*="window.open"]',
          'a[onclick*="ham"]',
        ];
        
        for (const pattern of hamLinkPatterns) {
          const element = await page.$(pattern);
          if (element) {
            const info = await element.evaluate(el => ({
              tag: el.tagName,
              text: el.textContent?.trim().substring(0, 100),
              href: (el as HTMLAnchorElement).href || '',
              target: (el as HTMLAnchorElement).target || '',
              onclick: el.getAttribute('onclick') || '',
              outerHTML: el.outerHTML.substring(0, 400),
            }));
            console.log(`  ✅ Found HAM element with pattern "${pattern}":`);
            console.log(`    ${JSON.stringify(info, null, 2)}`);
            
            // Try clicking it
            console.log('  Attempting to click...');
            const tabsBefore = context.pages().length;
            const newPagePromise2 = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
            await element.click();
            const newPage2 = await newPagePromise2;
            const tabsAfter = context.pages().length;
            console.log(`  Tabs: ${tabsBefore} → ${tabsAfter}`);
            
            if (newPage2) {
              console.log('  ✅✅ HAM opened in new tab!');
              await newPage2.waitForLoadState('load', { timeout: 30000 });
              await dumpPageInfo(newPage2, 'HAM Page');
              await dumpIframes(newPage2);
              await screenshot(newPage2, '07-ham-page');
              
              // Analyze HAM frames
              const frames = newPage2.frames();
              console.log(`\n  HAM Frames (${frames.length}):`);
              for (const f of frames) {
                console.log(`    name="${f.name()}" url="${f.url().substring(0, 150)}"`);
              }
              break;
            } else {
              console.log('  No new tab from this click');
              await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
              await page.waitForTimeout(2000);
              await screenshot(page, `07-after-click-${pattern.replace(/[^a-z0-9]/g, '_')}`);
              
              // Check if URL changed
              console.log(`  Current URL: ${page.url()}`);
            }
          }
        }
        
        // Final state dump
        console.log('\n========== FINAL STATE ==========');
        const allPagesNow = context.pages();
        console.log(`Total tabs: ${allPagesNow.length}`);
        for (let i = 0; i < allPagesNow.length; i++) {
          console.log(`  Tab ${i}: ${allPagesNow[i].url()}`);
        }
      }
    }
    
    console.log('\n=== Exploration complete ===');
    console.log('Closing browser in 5 seconds...');
    await page.waitForTimeout(5000);
    
  } catch (err) {
    console.error('❌ Error:', err);
    const pages = context.pages();
    if (pages.length > 0) {
      await screenshot(pages[pages.length - 1], 'error-state');
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
