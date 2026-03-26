/**
 * 事業所設定の問題診断スクリプト
 *
 * 井上由美 (userId=5004965) のstaffInfoページを開き、
 * 事業所設定を手動ステップで実行して各ステップのスクリーンショットを取得
 */
import dotenv from 'dotenv';
dotenv.config();

import { chromium, Page } from 'playwright';

const BASE_URL = 'https://portal.kanamic.net';
const AIRA_OFFICE_NAME = '訪問看護ステーションあおぞら姶良';

// 井上由美の userId（前回の同期で登録済み）
const TARGET_USER_ID = '5004965';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // ダイアログを自動的にキャプチャ（aceept せず、内容をログ出力）
  page.on('dialog', async (dialog) => {
    console.log(`🔔 DIALOG [${dialog.type()}]: "${dialog.message()}"`);
    await page.screenshot({ path: 'tmp/debug-dialog.png' });
    await dialog.accept();
  });

  try {
    // === Step 1: TRITRUS ログイン ===
    console.log('=== Step 1: TRITRUS ログイン ===');
    await page.goto(process.env.KANAMICK_URL!, { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('#josso_username', process.env.KANAMICK_USERNAME!);
    await page.fill('#josso_password', process.env.KANAMICK_PASSWORD!);
    await page.click('input.submit-button[type="button"]');
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    await sleep(2000);
    console.log(`ログイン完了: ${page.url()}`);
    await page.screenshot({ path: 'tmp/debug-01-login.png' });

    // === Step 2: staffInfo ページへ遷移 ===
    console.log('=== Step 2: staffInfo ページへ遷移 ===');
    const staffInfoUrl = `${BASE_URL}/tritrus/staffInfo/staffInfo?userId=${TARGET_USER_ID}`;
    await page.goto(staffInfoUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(1500);
    console.log(`staffInfo ページ: ${page.url()}`);
    await page.screenshot({ path: 'tmp/debug-02-staffinfo.png', fullPage: true });

    // === Step 3: 事業所設定セクションの状態確認 ===
    console.log('=== Step 3: 事業所設定セクション確認 ===');
    const officeSection = await page.evaluate(() => {
      // 事業所設定関連のリンクとテキストを全て取得
      const links = Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent?.trim(),
        href: a.getAttribute('href'),
        onclick: a.getAttribute('onclick'),
      }));
      const officeLinks = links.filter(l =>
        l.href?.includes('userOfficeSearch') ||
        l.href?.includes('TB_iframe') ||
        l.text?.includes('事業所') ||
        l.text?.includes('新規追加')
      );

      // 既存の事業所設定があるか
      const tables = Array.from(document.querySelectorAll('table'));
      const officeTableText = tables.map(t => t.textContent?.substring(0, 200)).filter(t => t?.includes('事業所'));

      return { officeLinks, officeTableText, allLinksCount: links.length };
    });
    console.log('事業所関連リンク:', JSON.stringify(officeSection.officeLinks, null, 2));
    console.log('事業所テーブルテキスト:', officeSection.officeTableText);

    // === Step 4: 新規追加リンクを探す ===
    console.log('=== Step 4: 新規追加リンク検索 ===');
    const addOfficeLink = await page.$('a[href*="userOfficeSearch"][href*="TB_iframe"]');
    if (!addOfficeLink) {
      console.log('❌ 新規追加リンクが見つかりません！');
      // 全リンクをダンプ
      const allLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a')).map(a => ({
          text: a.textContent?.trim()?.substring(0, 50),
          href: a.getAttribute('href')?.substring(0, 100),
        }))
      );
      console.log('全リンク:', JSON.stringify(allLinks, null, 2));
      return;
    }

    const linkHref = await addOfficeLink.getAttribute('href');
    console.log(`✅ 新規追加リンク発見: ${linkHref}`);

    // === Step 5: 新規追加をクリック → Thickbox ===
    console.log('=== Step 5: 新規追加クリック ===');
    await addOfficeLink.click();
    await sleep(3000);
    await page.screenshot({ path: 'tmp/debug-03-thickbox.png' });

    // === Step 6: iframe の状態確認 ===
    console.log('=== Step 6: iframe 確認 ===');
    const iframeEl = await page.$('#TB_iframeContent');
    if (!iframeEl) {
      console.log('❌ #TB_iframeContent が見つかりません');
      // Thickbox の状態を確認
      const tbState = await page.evaluate(() => ({
        tbOverlay: !!document.getElementById('TB_overlay'),
        tbWindow: !!document.getElementById('TB_window'),
        tbIframe: !!document.getElementById('TB_iframeContent'),
        bodyClass: document.body.className,
      }));
      console.log('Thickbox 状態:', tbState);
      return;
    }

    const iframe = await iframeEl.contentFrame();
    if (!iframe) {
      console.log('❌ iframe contentFrame が取得できません');
      return;
    }
    console.log(`✅ iframe 取得成功: ${iframe.url()}`);

    // iframe 内のフォーム要素を確認
    const iframeFormState = await iframe.evaluate(() => {
      const nameInput = document.querySelector('input[name="queryCareofficeName"]') as HTMLInputElement;
      const noInput = document.querySelector('input[name="queryCareofficeNo"]') as HTMLInputElement;
      const form = document.querySelector('form');
      const buttons = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"]'))
        .map(b => ({ type: b.getAttribute('type'), value: (b as HTMLInputElement).value, name: b.getAttribute('name') }));
      return {
        hasNameInput: !!nameInput,
        hasNoInput: !!noInput,
        formAction: form?.action,
        buttons,
        bodyText: document.body.textContent?.substring(0, 500),
      };
    });
    console.log('iframe フォーム状態:', JSON.stringify(iframeFormState, null, 2));

    // === Step 7: 事業所名で検索 ===
    console.log('=== Step 7: 事業所名で検索 ===');
    await iframe.evaluate((officeName) => {
      const el = document.querySelector('input[name="queryCareofficeName"]') as HTMLInputElement;
      if (el) el.value = officeName;
    }, AIRA_OFFICE_NAME);

    // 検索ボタンクリック
    const searchBtn = await iframe.$('input[type="submit"][value*="検索"], input[type="button"][value*="検索"]');
    if (searchBtn) {
      console.log('✅ 検索ボタン発見');
      await searchBtn.click();
    } else {
      console.log('⚠️ 検索ボタン不明、フォームsubmit');
      await iframe.evaluate(() => {
        const form = document.querySelector('form') as HTMLFormElement;
        if (form) form.submit();
      });
    }
    await sleep(3000);

    // 検索後のスクリーンショット
    await page.screenshot({ path: 'tmp/debug-04-search-result.png' });

    // === Step 8: 検索後の iframe を再取得して結果確認 ===
    console.log('=== Step 8: 検索結果確認 ===');
    const iframeElAfter = await page.$('#TB_iframeContent');
    const iframeAfter = iframeElAfter ? await iframeElAfter.contentFrame() : null;
    if (!iframeAfter) {
      console.log('❌ 検索後の iframe 再取得失敗');
      return;
    }

    const searchResult = await iframeAfter.evaluate(() => {
      const checkbox = document.getElementById('mkbn_0') as HTMLInputElement;
      const cbByName = document.querySelector('input[name="mStaffServiceOffice.officeIdList"]') as HTMLInputElement;
      const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .map(cb => ({ id: cb.id, name: cb.getAttribute('name'), value: (cb as HTMLInputElement).value }));
      const tableRows = document.querySelectorAll('table tr').length;
      const bodyText = document.body.textContent?.substring(0, 1000);
      const errorEls = Array.from(document.querySelectorAll('.error, .errorMessage, [class*="error"]'))
        .map(el => el.textContent?.trim());
      // a タグで checkOffice を呼ぶもの
      const checkOfficeLinks = Array.from(document.querySelectorAll('a[onclick*="checkOffice"]'))
        .map(a => ({ text: a.textContent?.trim(), onclick: a.getAttribute('onclick') }));

      return {
        hasMkbn0: !!checkbox,
        hasCbByName: !!cbByName,
        allCheckboxes,
        tableRows,
        bodyTextPreview: bodyText,
        errorEls,
        checkOfficeLinks,
      };
    });
    console.log('検索結果:', JSON.stringify(searchResult, null, 2));

    // === Step 9: チェックボックスを選択 ===
    if (searchResult.hasMkbn0 || searchResult.hasCbByName) {
      console.log('=== Step 9: チェックボックス選択 ===');
      await iframeAfter.evaluate(() => {
        const cb = document.getElementById('mkbn_0') as HTMLInputElement;
        if (cb) {
          cb.checked = true;
          return;
        }
        const cbByName = document.querySelector('input[name="mStaffServiceOffice.officeIdList"]') as HTMLInputElement;
        if (cbByName) cbByName.checked = true;
      });
      await page.screenshot({ path: 'tmp/debug-05-checkbox.png' });

      // === Step 10: checkOffice() 実行前のスナップショット ===
      console.log('=== Step 10: checkOffice() 呼び出し ===');

      // checkOffice 関数の存在確認
      const hasCheckOffice = await iframeAfter.evaluate(() => {
        return typeof (window as any).checkOffice === 'function';
      });
      console.log(`checkOffice 関数: ${hasCheckOffice ? '✅ 存在' : '❌ 不存在'}`);

      if (hasCheckOffice) {
        // checkOffice のソースを表示
        const fnSource = await iframeAfter.evaluate(() => {
          return (window as any).checkOffice?.toString()?.substring(0, 500);
        });
        console.log(`checkOffice ソース: ${fnSource}`);
      }

      // checkOffice リンクを確認
      const checkLink = searchResult.checkOfficeLinks[0];
      console.log(`checkOffice リンク: ${JSON.stringify(checkLink)}`);

      // checkOffice() を実行
      const checkResult = await iframeAfter.evaluate(() => {
        try {
          const win = window as any;
          if (typeof win.checkOffice === 'function') {
            const link = document.querySelector('a[onclick*="checkOffice"]');
            if (link) {
              win.checkOffice(link);
              return { success: true, error: null };
            }
            return { success: false, error: 'checkOffice link not found' };
          }
          return { success: false, error: 'checkOffice function not found' };
        } catch (e: any) {
          return { success: false, error: e.message || String(e) };
        }
      });
      console.log(`checkOffice 結果: ${JSON.stringify(checkResult)}`);

      await sleep(3000);
      await page.screenshot({ path: 'tmp/debug-06-after-checkoffice.png' });

      // === Step 11: Thickbox / エラー状態確認 ===
      console.log('=== Step 11: 後処理確認 ===');
      const afterState = await page.evaluate(() => {
        const tbOverlay = document.getElementById('TB_overlay');
        const tbWindow = document.getElementById('TB_window');
        const tbIframe = document.getElementById('TB_iframeContent');
        const errorText = document.querySelector('.error, .errorMessage, [class*="error"]')?.textContent;
        return {
          tbOverlay: !!tbOverlay,
          tbWindow: !!tbWindow,
          tbIframe: !!tbIframe,
          bodyTextPreview: document.body.textContent?.substring(0, 500),
          errorText,
          url: window.location.href,
        };
      });
      console.log('後処理状態:', JSON.stringify(afterState, null, 2));

    } else {
      console.log('❌ チェックボックスが見つかりません。事業所が既に設定済みかもしれません。');
    }

    // 最終スクリーンショット
    await page.screenshot({ path: 'tmp/debug-07-final.png', fullPage: true });
    console.log('\n=== 診断完了 ===');
    console.log('スクリーンショットは tmp/ フォルダに保存されています');

  } catch (error) {
    console.error('エラー:', error);
    await page.screenshot({ path: 'tmp/debug-error.png' }).catch(() => {});
  } finally {
    // ブラウザを開いたまま10秒待機（手動確認用）
    console.log('10秒後にブラウザを閉じます...');
    await sleep(10000);
    await browser.close();
  }
}

main().catch(console.error);
