/**
 * HAM スタッフマスタの資格設定を読み取り、Sheet の staffName 前缀と比較する。
 * 実行: npx tsx src/scripts/check-ham-qualifications.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { KanamickAuthService } from '../services/kanamick-auth.service';
import { SpreadsheetService } from '../services/spreadsheet.service';

const AIRA_SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';

async function main() {
  // 1. Sheet からユニークスタッフ取得
  const sheets = new SpreadsheetService(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json');
  const records = await sheets.getTranscriptionRecords(AIRA_SHEET_ID);
  const staffMap = new Map<string, string>();
  for (const r of records) {
    if (r.staffNumber && r.staffName) {
      staffMap.set(r.staffNumber, r.staffName);
    }
  }
  console.log(`Sheet内ユニークスタッフ: ${staffMap.size}名\n`);

  // 2. HAM にログイン
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

  // 3. スタッフマスタへ遷移
  await auth.navigateToStaffMaster();
  await sleep(1500);

  await nav.submitForm({ action: 'act_edit', waitForPageId: 'h1-1a', timeout: 15000 });
  await sleep(2000);

  // 全件検索
  const h1_1aFrame = await nav.waitForMainFrame('h1-1a', 15000);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  await h1_1aFrame.evaluate(() => {
    (window as any).submited = 0;
    const form = document.forms[0] as any;
    form.doAction.value = 'act_search';
    form.target = 'commontarget';
    if (form.doTarget) form.doTarget.value = 'commontarget';
    form.submit();
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  let searchReady = false;
  const searchStart = Date.now();
  while (Date.now() - searchStart < 15000) {
    await sleep(1000);
    try {
      const frame = await nav.getMainFrame();
      const count = await frame.evaluate(() =>
        document.querySelectorAll('input[type="button"][name="act_edit"][value="詳細"]').length
      ).catch(() => 0);
      if (count > 0) { searchReady = true; break; }
    } catch { /* retry */ }
  }
  if (!searchReady) throw new Error('h1-1a 検索結果タイムアウト');

  // デバッグ: h1-1a に表示されているスタッフ一覧を出力
  const debugFrame = await nav.getMainFrame();
  const hamStaffList = await debugFrame.evaluate(() => {
    const btns = document.querySelectorAll('input[type="button"][name="act_edit"][value="詳細"]');
    const list: string[] = [];
    for (let i = 0; i < btns.length; i++) {
      const row = btns[i].closest('tr');
      const cells = row?.querySelectorAll('td');
      if (cells) {
        const cols = Array.from(cells).map((c: Element) => (c.textContent || '').trim());
        list.push(cols.slice(0, 5).join(' | '));
      }
    }
    return list;
  });
  console.log(`h1-1a スタッフ一覧 (${hamStaffList.length}件):`);
  for (const s of hamStaffList) {
    console.log(`  ${s}`);
  }
  console.log();

  // 4. 各スタッフの資格を確認
  const results: Array<{ empCode: string; sheetName: string; sheetQual: string; hamQual: string; match: boolean }> = [];

  for (const [empCode, sheetName] of staffMap) {
    const dashIdx = sheetName.indexOf('-');
    const sheetQual = dashIdx > 0 ? sheetName.substring(0, dashIdx) : '不明';
    // staffName から資格プレフィックスを除去して姓名のみ（例: "看護師-川尻絵李奈" → "川尻絵李奈"）
    const plainName = dashIdx > 0 ? sheetName.substring(dashIdx + 1) : sheetName;
    // HAM 表示は姓と名の間にスペースがある場合があるので、スペース除去で比較
    const plainNameNorm = plainName.replace(/[\s\u3000]+/g, '');

    try {
      const listFrame = await nav.getMainFrame();
      const targetIndex = await listFrame.evaluate((searchName: string) => {
        const btns = document.querySelectorAll('input[type="button"][name="act_edit"][value="詳細"]');
        for (let i = 0; i < btns.length; i++) {
          const row = btns[i].closest('tr');
          const cells = row?.querySelectorAll('td');
          if (cells && cells.length >= 3) {
            // 第3列 (index 2) がスタッフ名
            const hamName = (cells[2]?.textContent || '').replace(/[\s\u3000]+/g, '').trim();
            if (hamName === searchName) return i;
          }
        }
        return -1;
      }, plainNameNorm);

      if (targetIndex < 0) {
        console.log(`  [${empCode}] ${sheetName}: HAM に見つからない`);
        results.push({ empCode, sheetName, sheetQual, hamQual: '未登録', match: false });
        continue;
      }

      /* eslint-disable @typescript-eslint/no-explicit-any */
      await listFrame.evaluate(() => { (window as any).submited = 0; });
      /* eslint-enable @typescript-eslint/no-explicit-any */
      const detailBtns = await listFrame.$$('input[type="button"][name="act_edit"][value="詳細"]');
      await detailBtns[targetIndex].click();
      await sleep(3000);

      const h1_1bFrame = await nav.waitForMainFrame('h1-1b', 15000);
      const quals: string[] = await h1_1bFrame.evaluate(() => {
        const result: string[] = [];
        const cb5 = document.querySelector('input[name="licence5s"]') as HTMLInputElement | null;
        if (cb5?.checked) {
          const r1 = document.querySelector('input[name="licence5"][value="1"]') as HTMLInputElement | null;
          const r2 = document.querySelector('input[name="licence5"][value="2"]') as HTMLInputElement | null;
          if (r1?.checked) result.push('看護師');
          else if (r2?.checked) result.push('准看護師');
        }
        const cb10 = document.querySelector('#licence10') as HTMLInputElement | null;
        if (cb10?.checked) result.push('理学療法士');
        const cb11 = document.querySelector('#licence11') as HTMLInputElement | null;
        if (cb11?.checked) result.push('作業療法士');
        const cb12 = document.querySelector('#licence12') as HTMLInputElement | null;
        if (cb12?.checked) result.push('言語聴覚士');
        return result;
      });

      const hamQual = quals.length > 0 ? quals.join(', ') : 'なし';
      let match = false;
      if (sheetQual === '看護師') match = quals.includes('看護師');
      else if (sheetQual === '准看護師') match = quals.includes('准看護師');
      else if (sheetQual === '理学療法士等') match = quals.some(q => ['理学療法士', '作業療法士', '言語聴覚士'].includes(q));

      const status = match ? '✓' : '✗ 不一致';
      console.log(`  [${empCode}] ${sheetName} | Sheet: ${sheetQual} | HAM: ${hamQual} | ${status}`);
      results.push({ empCode, sheetName, sheetQual, hamQual, match });

      // h1-1b → h1-1a に戻る → 検索結果がリセットされるため再検索
      await nav.submitForm({ action: 'act_back', waitForPageId: 'h1-1a', timeout: 15000 });
      await sleep(1000);
      const backFrame = await nav.waitForMainFrame('h1-1a', 15000);
      /* eslint-disable @typescript-eslint/no-explicit-any */
      await backFrame.evaluate(() => {
        (window as any).submited = 0;
        const form = document.forms[0] as any;
        form.doAction.value = 'act_search';
        form.target = 'commontarget';
        if (form.doTarget) form.doTarget.value = 'commontarget';
        form.submit();
      });
      /* eslint-enable @typescript-eslint/no-explicit-any */
      await sleep(3000);

    } catch (err) {
      console.log(`  [${empCode}] ${sheetName}: エラー ${(err as Error).message}`);
      results.push({ empCode, sheetName, sheetQual, hamQual: 'エラー', match: false });
      try {
        await auth.navigateToMainMenu();
        await auth.navigateToStaffMaster();
        await sleep(1500);
        await nav.submitForm({ action: 'act_edit', waitForPageId: 'h1-1a', timeout: 15000 });
        await sleep(2000);
        const frame = await nav.waitForMainFrame('h1-1a', 15000);
        /* eslint-disable @typescript-eslint/no-explicit-any */
        await frame.evaluate(() => {
          (window as any).submited = 0;
          const form = document.forms[0] as any;
          form.doAction.value = 'act_search';
          form.target = 'commontarget';
          if (form.doTarget) form.doTarget.value = 'commontarget';
          form.submit();
        });
        /* eslint-enable @typescript-eslint/no-explicit-any */
        await sleep(3000);
      } catch { /* ignore */ }
    }
  }

  // サマリー
  console.log('\n=== サマリー ===');
  const mismatches = results.filter(r => !r.match);
  if (mismatches.length === 0) {
    console.log('全スタッフの資格が一致しています。');
  } else {
    console.log(`不一致: ${mismatches.length}件`);
    for (const m of mismatches) {
      console.log(`  [${m.empCode}] ${m.sheetName}: Sheet=${m.sheetQual}, HAM=${m.hamQual}`);
    }
  }

  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => { console.error('エラー:', err); process.exit(1); });
