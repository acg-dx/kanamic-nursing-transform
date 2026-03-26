/**
 * 実データ転記テスト — Google Sheets から1件読み込み、HAM に登録
 *
 * 実行: HEADLESS=false npx tsx src/scripts/test-real-transcription.ts
 *
 * 姶良 sheetId: 12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M
 * 第3行以降のデータを読み、予定登録 → スタッフ配置 → 実績1 → 上書き保存
 */
import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import { chromium, Frame } from 'playwright';
import { KanamickAuthService, KanamickAuthConfig } from '../services/kanamick-auth.service';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { ServiceCodeResolver } from '../services/service-code-resolver';
import { getTimetype, getTimePeriod, parseTime, toHamDate, toHamMonthStart } from '../services/time-utils';
// endParts/endPeriod は不使用（終了時間は HAM 自動値のまま）

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const SCREENSHOTS_DIR = './screenshots';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * フレーム内の全フォーム要素をダンプ（デバッグ用）
 */
async function dumpFrame(frame: Frame, label: string) {
  console.log(`\n  --- ${label} (${frame.url().substring(0, 80)}) ---`);
  const info = await frame.evaluate(() => {
    const results: string[] = [];
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opts = Array.from(sel.options).slice(0, 5).map(o => `${o.value}="${o.text.substring(0, 30)}"`);
      results.push(`SELECT name="${sel.name}" id="${sel.id}" opts=[${opts.join(', ')}${sel.options.length > 5 ? `... (${sel.options.length})` : ''}]`);
    }
    const inputs = Array.from(document.querySelectorAll('input')).filter(i => i.type !== 'hidden');
    for (const inp of inputs) {
      results.push(`INPUT type="${inp.type}" name="${inp.name}" id="${inp.id}" value="${inp.value.substring(0, 40)}"`);
    }
    const hiddens = Array.from(document.querySelectorAll('input[type="hidden"]'));
    for (const h of hiddens) {
      if (h.name) results.push(`HIDDEN name="${h.name}" value="${h.value.substring(0, 60)}"`);
    }
    results.push(`BODY_TEXT: ${document.body?.innerText?.replace(/\n/g, ' | ').substring(0, 300)}`);
    return results;
  }).catch(e => [`ERROR: ${(e as Error).message}`]);
  for (const line of info) console.log(`    ${line}`);
}

async function main() {
  console.log('=== 実データ転記テスト（姶良） ===\n');

  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // ---- Step 0: Google Sheets データ取得 ----
  console.log('Step 0: Google Sheets データ取得...');
  const sheets = new SpreadsheetService(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json');
  const allRecords = await sheets.getTranscriptionRecords(SHEET_ID);
  console.log(`  全レコード数: ${allRecords.length}`);

  const targets = allRecords.filter(r =>
    r.rowIndex >= 3 &&
    r.patientName &&
    r.visitDate &&
    r.startTime &&
    r.endTime &&
    r.serviceType1 &&
    (r.transcriptionFlag === '' || r.transcriptionFlag === 'エラー：システム')
  );
  console.log(`  転記対象: ${targets.length}件`);

  if (targets.length === 0) {
    console.log('  転記対象がありません。');
    return;
  }

  const record = targets[0];
  console.log(`\n  処理レコード (row=${record.rowIndex}):`);
  console.log(`    記録者: ${record.staffName} (${record.staffNumber})`);
  console.log(`    利用者: ${record.patientName} (aozoraID=${record.aozoraId})`);
  console.log(`    ${record.visitDate} ${record.startTime}-${record.endTime}`);
  console.log(`    ${record.serviceType1} / ${record.serviceType2}`);

  const resolver = new ServiceCodeResolver();
  const codeResult = resolver.resolve(record);
  console.log(`    → ${codeResult.description} (showflag=${codeResult.showflag}, ${codeResult.servicetype}#${codeResult.serviceitem})`);

  const startParts = parseTime(record.startTime);
  const startPeriod = getTimePeriod(record.startTime);
  const timetype = getTimetype(record.startTime, record.endTime);
  const visitDateHam = toHamDate(record.visitDate);
  const monthStart = toHamMonthStart(record.visitDate);
  console.log(`    HAM: date=${visitDateHam} month=${monthStart} time=${timetype} period=${startPeriod}`);

  // ---- ブラウザ起動 & ログイン ----
  console.log('\n--- ブラウザ起動 ---');
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
      console.log(`  💬 Dialog [${dialog.type()}]: ${dialog.message()}`);
      await dialog.accept();
    });
  });

  const auth = new KanamickAuthService({
    url: process.env.KANAMICK_URL || 'https://portal.kanamic.net/tritrus/index/',
    username: process.env.KANAMICK_USERNAME || '',
    password: process.env.KANAMICK_PASSWORD || '',
    stationName: process.env.KANAMICK_STATION_NAME || '訪問看護ステーションあおぞら姶良',
    hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
    hamOfficeCode: process.env.KANAMICK_HAM_OFFICE_CODE || '400021814',
  });
  auth.setContext(context);

  try {
    // ---- ログイン ----
    console.log('ログイン中...');
    const nav = await auth.login();
    const hamPage = nav.hamPage;
    console.log(`  ✅ ログイン成功`);

    // ---- Step 1-2: 業務ガイド → 利用者検索 ----
    console.log('\nStep 1-2: 業務ガイド → 利用者検索...');
    await auth.navigateToBusinessGuide();
    await auth.navigateToUserSearch();
    await sleep(1000);

    const k2_1Frame = await nav.waitForMainFrame('k2_1', 15000);
    console.log(`  pageId: ${await nav.getCurrentPageId()}`);
    await dumpFrame(k2_1Frame, 'k2_1 利用者検索');
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-02-k2_1.png` });

    // ---- Step 3: searchdate 設定 & 検索 ----
    console.log(`\nStep 3: 年月設定 & 検索 (monthStart=${monthStart})...`);
    await nav.setSelectValue('searchdate', monthStart);

    await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_1' });
    await sleep(1000);
    console.log('  ✅ 検索完了');

    const k2_1After = await nav.waitForMainFrame('k2_1', 15000);
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-03-search-result.png` });

    // ---- Step 4: 患者特定 → k2_2 ----
    console.log(`\nStep 4: 患者「${record.patientName}」検索...`);
    const patientId = await k2_1After.evaluate((name) => {
      const normalizedName = name.replace(/[\s\u3000\u00a0]+/g, '').trim();
      const btns = Array.from(document.querySelectorAll('input[name="act_result"][value="決定"]'));
      for (const btn of btns) {
        const tr = btn.closest('tr');
        if (!tr) continue;
        const rowText = (tr.textContent || '').replace(/[\s\u3000\u00a0]+/g, '').trim();
        if (rowText.includes(normalizedName)) {
          const onclick = btn.getAttribute('onclick') || '';
          const m = onclick.match(/careuserid\s*,\s*'(\d+)'/) || onclick.match(/careuserid\.value\s*=\s*['"](\d+)['"]/);
          if (m) return m[1];
        }
      }
      return null;
    }, record.patientName);

    if (!patientId) {
      // 患者リストをダンプ
      const patients = await k2_1After.evaluate(() => {
        const btns = document.querySelectorAll('input[name="act_result"][value="決定"]');
        return Array.from(btns).slice(0, 15).map(btn => {
          const tr = btn.closest('tr');
          return tr?.textContent?.trim().replace(/\s+/g, ' ').substring(0, 80) || '';
        });
      });
      console.log('  患者一覧:');
      for (const p of patients) console.log(`    ${p}`);
      throw new Error(`患者「${record.patientName}」が見つかりません`);
    }
    console.log(`  ✅ 患者ID: ${patientId}`);

    // k2_2 遷移
    await k2_1After.evaluate((pid) => {
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
    }, patientId);
    await nav.waitForMainFrame('k2_2', 15000);
    await sleep(2000);
    console.log(`  ✅ k2_2 月間スケジュール`);
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-04-k2_2.png` });

    // ---- Step 4.5: 修正レコードの場合 → 既存スケジュール先行削除 ----
    if (record.transcriptionFlag === '修正あり') {
      console.log(`\nStep 4.5: 修正レコード → 既存スケジュール削除...`);
      const k2_2DelFrame = await nav.getMainFrame('k2_2');
      const dayNum = parseInt(visitDateHam.substring(6, 8));
      const dayDisplay = `${dayNum}日`;

      const deleteInfo = await k2_2DelFrame.evaluate(({ dd, st }) => {
        const rows = Array.from(document.querySelectorAll('tr'));
        for (const row of rows) {
          const rowText = row.textContent || '';
          if (!rowText.includes(dd)) continue;
          if (!rowText.includes(st)) continue;
          const delBtn = row.querySelector('input[name="act_delete"][value="削除"]') as HTMLInputElement | null;
          if (!delBtn) continue;
          const onclick = delBtn.getAttribute('onclick') || '';
          const m = onclick.match(/confirmDelete\(\s*'(\d+)'\s*,\s*'(\d+)'\s*\)/);
          if (!m) continue;
          return { found: true, assignid: m[1], record2flag: m[2], rowText: rowText.replace(/\s+/g, ' ').trim().substring(0, 100) };
        }
        return { found: false };
      }, { dd: dayDisplay, st: record.startTime });

      if (deleteInfo.found) {
        console.log(`  既存エントリ検出: ${deleteInfo.rowText}`);
        console.log(`  assignid=${deleteInfo.assignid}, record2flag=${deleteInfo.record2flag}`);

        if (deleteInfo.record2flag === '1') {
          console.log('  ⚠️ 記録書IIが存在。削除スキップ');
        } else {
          // 削除ボタン Playwright native click
          const delBtn = await k2_2DelFrame.$(`input[name="act_delete"][onclick*="confirmDelete('${deleteInfo.assignid}'"]`);
          if (delBtn) {
            await k2_2DelFrame.evaluate(() => { (window as any).submited = 0; });
            await delBtn.click();
            await sleep(2000);
          }
          // 上書き保存
          await nav.submitForm({ action: 'act_update', setLockCheck: true, waitForPageId: 'k2_2' });
          await sleep(2000);
          console.log('  ✅ 既存スケジュール削除 + 上書き保存完了');
          await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-04_5-deleted.png` });
        }
      } else {
        console.log('  既存エントリなし → 新規追加として続行');
      }
    }

    // ---- Step 5: 追加 → k2_3 ----
    console.log(`\nStep 5: 追加 (date=${visitDateHam})...`);
    await nav.submitForm({
      action: 'act_addnew',
      setLockCheck: true,
      hiddenFields: { editdate: visitDateHam },
      waitForPageId: 'k2_3',
    });
    await sleep(1500);
    console.log(`  ✅ k2_3 (pageId=${await nav.getCurrentPageId()})`);

    // k2_3 のフォームをダンプ
    let k2_3Frame = await nav.getMainFrame('k2_3');
    await dumpFrame(k2_3Frame, 'k2_3 スケジュール追加');
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-05-k2_3.png` });

    // ---- Step 6: 時間設定 → k2_3a ----
    console.log(`\nStep 6: 時間設定 ${record.startTime}-${record.endTime} (type=${timetype})...`);

    // k2_3 の全 select 名と選択肢をダンプ（デバッグ用）
    const k2_3Selects = await k2_3Frame.evaluate(() => {
      const results: string[] = [];
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        const opts = Array.from(sel.options).slice(0, 8).map(o => `${o.value}`);
        const more = sel.options.length > 8 ? `...(${sel.options.length})` : '';
        results.push(`${sel.name}: [${opts.join(',')}${more}] current="${sel.value}"`);
      }
      return results;
    });
    console.log('  k2_3 selects:');
    for (const s of k2_3Selects) console.log(`    ${s}`);

    console.log(`  設定値: starttype=${startPeriod} start=${startParts.hour}:${startParts.minute} timetype=${timetype}`);

    // ---- starttype 設定（onchange で act_changetime が発火しページリロード）----
    // starttype の初期値を確認し、変更が必要な場合のみ onchange を発火
    const currentStartType = await k2_3Frame.evaluate(() => {
      const form = document.forms[0];
      return (form?.starttype as HTMLSelectElement)?.value || '';
    });

    if (currentStartType !== startPeriod) {
      console.log(`  starttype 変更: ${currentStartType} → ${startPeriod} (onchange 発火)...`);
      // starttype を変更し、onchange を発火（submitTargetForm → ページリロード）
      await k2_3Frame.evaluate((val) => {
        const win = window as any;
        win.submited = 0;
        const form = document.forms[0];
        const sel = form.starttype as HTMLSelectElement;
        sel.value = val;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }, startPeriod);
      // ページリロード待ち（starttime0 の選択肢が更新される）
      await sleep(3000);
      // リロード後のフレームを再取得
      k2_3Frame = await nav.waitForMainFrame('k2_3', 15000);
      console.log(`  starttype 変更後のフレーム再取得完了`);
    } else {
      console.log(`  starttype は既に ${startPeriod} (変更不要)`);
    }

    // starttime0 の利用可能な選択肢を確認
    const availableHours = await k2_3Frame.evaluate(() => {
      const form = document.forms[0];
      const sel = form?.starttime0 as HTMLSelectElement;
      if (!sel) return [];
      return Array.from(sel.options).map(o => o.value).filter(v => v !== '');
    });
    console.log(`  starttime0 利用可能時間: [${availableHours.join(',')}]`);

    // 時間設定（starttype リロード後）
    await nav.setSelectValue('starttime0', startParts.hour, k2_3Frame);
    await nav.setSelectValue('starttime1', startParts.minute, k2_3Frame);
    await nav.setSelectValue('timetype', timetype, k2_3Frame);
    // 終了時間は HAM 自動値のまま手動修正しない（専務確認済み 2026-02-26）

    // 設定結果を確認
    const k2_3After = await k2_3Frame.evaluate(() => {
      const form = document.forms[0];
      const vals: string[] = [];
      ['starttype', 'starttime0', 'starttime1', 'timetype'].forEach(n => {
        vals.push(n + '=' + ((form?.[n] as HTMLSelectElement)?.value || 'N/A'));
      });
      return vals.join(' ');
    });
    console.log(`  設定結果: ${k2_3After}`);
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-05b-k2_3-set.png` });

    await nav.submitForm({ action: 'act_next', waitForPageId: 'k2_3a' });
    await sleep(1500);
    console.log(`  ✅ k2_3a (pageId=${await nav.getCurrentPageId()})`);

    const k2_3aFrame = await nav.getMainFrame('k2_3a');
    await dumpFrame(k2_3aFrame, 'k2_3a サービスコード（初期）');
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-06-k2_3a.png` });

    // ---- Step 7: 保険種別切替 + サービスコード選択 ----
    console.log(`\nStep 7: showflag=${codeResult.showflag} 切替...`);
    await nav.switchInsuranceType(codeResult.showflag);
    await sleep(2000);

    const k2_3aSwitched = await nav.getMainFrame('k2_3a');
    await dumpFrame(k2_3aSwitched, 'k2_3a 保険切替後');
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-07-k2_3a-switched.png` });

    // サービスコード一覧
    const codes = await k2_3aSwitched.evaluate(() => {
      return Array.from(document.querySelectorAll('input[name="radio"]')).map(r => {
        const inp = r as HTMLInputElement;
        const tr = r.closest('tr');
        return { value: inp.value, text: tr?.textContent?.trim().replace(/\s+/g, ' ').substring(0, 80) || '' };
      });
    });
    console.log(`  サービスコード (${codes.length}):`);
    for (const c of codes) {
      const mark = c.value === `${codeResult.servicetype}#${codeResult.serviceitem}` ? ' ★選択' : '';
      console.log(`    ${c.value} → ${c.text}${mark}`);
    }

    await nav.selectServiceCode(codeResult.servicetype, codeResult.serviceitem, undefined, codeResult.textPattern);
    console.log(`  ✅ コード選択: ${codeResult.servicetype}#${codeResult.serviceitem} (pattern="${codeResult.textPattern}")`);

    // 次へ → k2_3b
    await nav.submitForm({ action: 'act_next', waitForPageId: 'k2_3b' });
    await sleep(1000);
    console.log(`  ✅ k2_3b 確認`);
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-07_5-k2_3b.png` });

    // ---- Step 8: 決定 → k2_2 ----
    console.log('\nStep 8: 決定 → k2_2...');
    await nav.submitForm({ action: 'act_do', waitForPageId: 'k2_2' });
    await sleep(2000);
    console.log(`  ✅ k2_2 に戻った`);
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-08-k2_2.png` });

    // ---- Step 9: 配置ボタン → k2_2f ----
    // k2_2 の HTML 構造:
    //   配置ボタン onclick="...submitTargetFormEx(this.form, 'act_modify', assignid, 'XXX')"
    //   日付表示: "1日  日" (X日 形式)
    //   スタッフ未配置の新規行は担当スタッフ欄が空
    console.log('\nStep 9: 配置ボタン → k2_2f...');
    const k2_2Frame = await nav.getMainFrame('k2_2');

    // 新規追加行の assignid を取得
    // HAM の日付表示は "X日" 形式（例: "1日"）
    const day = parseInt(visitDateHam.substring(6, 8));
    const dayDisplay = `${day}日`;

    const assignResult = await k2_2Frame.evaluate((dd) => {
      const btns = Array.from(document.querySelectorAll('input[name="act_modify"][value="配置"]'));
      const all: { assignId: string; rowText: string; hasStaff: boolean }[] = [];

      for (const btn of btns) {
        const onclick = btn.getAttribute('onclick') || '';
        const m = onclick.match(/assignid\s*,\s*'(\d+)'/) || onclick.match(/assignid\.value\s*=\s*'(\d+)'/);
        if (!m) continue;

        const tr = btn.closest('tr');
        const rowText = (tr?.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 120);
        // スタッフ配置済みかどうか: 担当スタッフ欄に名前があるか
        const staffCell = tr?.querySelector('td[bgcolor="#DDEEFF"]');
        const hasStaff = !!(staffCell?.textContent?.trim());

        all.push({ assignId: m[1], rowText, hasStaff });
      }

      // 方法1: 指定日の未配置行（新規追加分）
      for (const item of all) {
        if (item.rowText.includes(dd) && !item.hasStaff) {
          return { ...item, method: 'day+unassigned' };
        }
      }
      // 方法2: 未配置行（最後のもの）
      const unassigned = all.filter(i => !i.hasStaff);
      if (unassigned.length > 0) {
        return { ...unassigned[unassigned.length - 1], method: 'last-unassigned' };
      }
      // 方法3: 最後の配置ボタン
      if (all.length > 0) {
        return { ...all[all.length - 1], method: 'last-any' };
      }
      return null;
    }, dayDisplay);

    if (!assignResult) throw new Error('配置ボタンが見つかりません');
    const assignId = assignResult.assignId;
    console.log(`  assignId: ${assignId} (${assignResult.method})`);
    console.log(`  行: ${assignResult.rowText}`);

    // submitTargetFormEx を直接呼び出して配置画面に遷移
    // submitForm (commontarget) ではなく、HAM ネイティブの submitTargetFormEx を使用
    await k2_2Frame.evaluate((aid) => {
      const win = window as any;
      const form = document.forms[0];
      // lockCheck 設定（ボタンの onclick と同じ）
      const lockChecks = document.getElementsByName('lockCheck');
      if (lockChecks[0]) (lockChecks[0] as HTMLInputElement).value = '1';
      // submitTargetFormEx(form, action, hiddenField, value)
      win.submited = 0;
      if (typeof win.submitTargetFormEx === 'function') {
        win.submitTargetFormEx(form, 'act_modify', form.assignid, aid);
      } else {
        form.assignid.value = aid;
        form.doAction.value = 'act_modify';
        form.target = 'commontarget';
        if (form.doTarget) form.doTarget.value = 'commontarget';
        form.submit();
      }
    }, assignId);

    await nav.waitForMainFrame('k2_2f', 15000);
    await sleep(2000);
    console.log(`  ✅ k2_2f スタッフ配置`);

    // k2_2f ダンプ
    const k2_2fFrame = await nav.getMainFrame('k2_2f');
    await dumpFrame(k2_2fFrame, 'k2_2f スタッフ配置');
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-09-k2_2f.png` });

    // ---- Step 10: スタッフ配置 ----
    // k2_2f は2段階操作:
    //   Stage 1: 時間設定 + 配置ボタン（スタッフ欄は空 or デフォルト）
    //            配置ボタン onclick: setTime(...);return submitTargetForm(form, 'act_select')
    //            or: setIndex('0');setSeq('1');setHelperid('...');return submitTargetForm(form, 'act_select')
    //   Stage 2: 配置ボタンクリック後 → 従業員選択リストが表示
    //            各行に 確認/選択 ボタン
    //            選択: onclick="return choice(this, 'helperId', '氏名', 1)"
    console.log(`\nStep 10: スタッフ「${record.staffName}」配置...`);

    // Stage 1: k2_2f の「配置」ボタンを Playwright native click
    // submitTargetForm は HAM 独自関数なので evaluate ではなく native click を使う
    console.log('  Stage 1: k2_2f の配置ボタンを Playwright click...');

    // submited ロック解除
    await k2_2fFrame.evaluate(() => {
      (window as any).submited = 0;
    });

    // 配置ボタンを native click（onclick ハンドラが正しく実行される）
    const haichi1Btn = await k2_2fFrame.$('input[name="act_select"][value="配置"]');
    if (haichi1Btn) {
      await haichi1Btn.click();
      console.log('  ✅ 配置ボタン click 完了');
    } else {
      console.log('  ⚠️ 配置ボタンが見つかりません。フォーム送信にフォールバック');
      await nav.submitForm({ action: 'act_select' });
    }
    await sleep(3000);
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-10a-after-haichi.png` });

    // Stage 2: 従業員選択リストが表示されるまで待機
    // 「選択」ボタンが出現するフレームを探す（mainFrame or commontarget）
    let staffFrame: any = null;
    for (let i = 0; i < 20; i++) {
      // 全フレームから「選択」ボタンを検索
      const allFrames = hamPage.frames();
      for (const f of allFrames) {
        const hasList = await f.evaluate(() =>
          document.querySelectorAll('input[name="act_select"][value="選択"]').length > 0
        ).catch(() => false);
        if (hasList) { staffFrame = f; break; }
      }
      if (staffFrame) break;
      console.log(`  従業員リスト待機中... (${i + 1}/20)`);
      await sleep(1000);
    }

    if (!staffFrame) {
      // デバッグ: 全フレームの状態をダンプ
      const allFrames = hamPage.frames();
      console.log(`  全フレーム (${allFrames.length}):`);
      for (const f of allFrames) {
        const url = f.url().substring(0, 80);
        const text = await f.evaluate(() => document.body?.innerText?.substring(0, 100) || '').catch(() => 'N/A');
        console.log(`    name="${f.name()}" url="${url}" text="${text}"`);
      }
      throw new Error('従業員選択リストが表示されません');
    }
    console.log(`  ✅ 従業員リスト検出 (frame="${staffFrame.name()}")`);

    const staffSearchName = record.staffName.replace(/[\s\u3000]+/g, '');
    console.log(`  Stage 2: 従業員リストから「${staffSearchName}」を検索...`);

    // 従業員リストのフレームで直接 choice() を呼び出す
    // choice(element, helperId, staffName, flag) は HAM 組み込み関数
    const choiceResult = await staffFrame.evaluate((searchName: string) => {
      const rows = Array.from(document.querySelectorAll('tr'));
      for (const row of rows) {
        const rowText = (row.textContent || '').replace(/[\s\u3000\u00a0]+/g, '');
        if (!rowText.includes(searchName)) continue;

        const selectBtn = row.querySelector('input[name="act_select"][value="選択"]') as HTMLInputElement | null;
        if (!selectBtn || selectBtn.disabled) continue;

        const onclick = selectBtn.getAttribute('onclick') || '';
        const m = onclick.match(/choice\(this,\s*'(\d+)',\s*'([^']+)',\s*(\d+)\)/);
        if (!m) continue;

        const helperId = m[1];
        const staffName = m[2];

        const cells = row.querySelectorAll('td');
        const empNo = cells[0]?.textContent?.trim() || '';

        // choice() を直接呼び出し
        (window as any).submited = 0;
        const win = window as any;
        if (typeof win.choice === 'function') {
          win.choice(selectBtn, helperId, staffName, 1);
          return { found: true, method: 'choice()', helperId, staffName, empNo };
        }

        // フォールバック: selectBtn.click()
        selectBtn.click();
        return { found: true, method: 'click()', helperId, staffName, empNo };
      }

      // 一覧ダンプ
      const allStaff: string[] = [];
      for (const row of rows) {
        const selectBtn = row.querySelector('input[name="act_select"][value="選択"]');
        if (selectBtn) {
          const cells = row.querySelectorAll('td');
          allStaff.push(`${cells[0]?.textContent?.trim()} ${cells[1]?.textContent?.trim()}${(selectBtn as HTMLInputElement).disabled ? ' (disabled)' : ''}`);
        }
      }
      return { found: false, allStaff };
    }, staffSearchName);

    console.log(`  choice結果: ${JSON.stringify(choiceResult, null, 2)}`);

    if (!choiceResult.found) {
      console.log('  ⚠️ スタッフが見つかりません。一覧:');
      for (const s of (choiceResult as any).allStaff || []) console.log(`    ${s}`);
      throw new Error(`スタッフ「${record.staffName}」が見つかりません`);
    }

    await sleep(3000);
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-10b-after-choice.png` });

    // choice() 後の確認画面: 「上記のスタッフでよろしければ、決定ボタンをクリック」
    // 全フレームから決定ボタンを探してクリック
    console.log('  確認画面の決定ボタンを検索...');
    let confirmClicked = false;
    for (let retry = 0; retry < 10; retry++) {
      const allFrames2 = hamPage.frames();
      for (const f of allFrames2) {
        try {
          const hasConfirm = await f.evaluate(() => {
            const body = document.body?.innerText || '';
            return body.includes('スタッフでよろしければ') || body.includes('決定');
          }).catch(() => false);

          if (hasConfirm) {
            const ketteBtn = await f.$('input[value="決定"]');
            if (ketteBtn) {
              await f.evaluate(() => { (window as any).submited = 0; });
              await ketteBtn.click();
              confirmClicked = true;
              console.log(`  ✅ 確認画面の決定ボタンクリック (frame="${f.name()}")`);
              break;
            }
          }
        } catch { /* ignore */ }
      }
      if (confirmClicked) break;
      await sleep(1000);
    }

    if (!confirmClicked) {
      console.log('  ⚠️ 確認画面が見つかりません（直接 k2_2 に遷移した可能性）');
    }

    await sleep(3000);

    // 決定後は k2_2f（スタッフ配置画面）に戻る（k2_2 ではない！）
    // k2_2f で 上書き保存 をクリック → k2_2 に遷移
    console.log(`  ✅ スタッフ配置完了: ${choiceResult.staffName} (helperId=${choiceResult.helperId})`);
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-10-after-assign.png` });

    // ---- Step 10.5: k2_2f で「戻る」→ k2_2 に戻る ----
    console.log('\nStep 10.5: k2_2f で戻る → k2_2 へ...');

    // 「戻る」リンクをクリック（前の画面にもどりたい時はこちらから）
    let backClicked = false;
    const allFramesForBack = hamPage.frames();
    for (const f of allFramesForBack) {
      try {
        // 「戻る」はリンク（aタグ）の場合が多い
        const backLink = await f.$('a:has-text("戻る")');
        if (backLink) {
          await backLink.click();
          backClicked = true;
          console.log(`  ✅ 戻るクリック (frame="${f.name()}")`);
          break;
        }
      } catch { /* ignore */ }
    }

    if (!backClicked) {
      console.log('  ⚠️ 戻るリンク未検出。act_back にフォールバック');
      await nav.submitForm({ action: 'act_back' });
    }
    await sleep(3000);

    // k2_2 に戻るまで待機（全1ボタンが存在するフレームを検出）
    let k2_2MainFrame: Frame | null = null;
    for (let i = 0; i < 20; i++) {
      const allF = hamPage.frames();
      for (const f of allF) {
        const hasAll1 = await f.evaluate(() =>
          !!document.querySelector('input[name="act_chooseall"]')
        ).catch(() => false);
        if (hasAll1) { k2_2MainFrame = f; break; }
      }
      if (k2_2MainFrame) break;
      console.log(`  k2_2 待機中... (${i + 1}/20)`);
      await sleep(1500);
    }

    if (!k2_2MainFrame) {
      k2_2MainFrame = await nav.getMainFrame();
      console.log('  ⚠️ k2_2 フレーム未検出。getMainFrame フォールバック');
    }
    console.log('  ✅ k2_2 に戻った');
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-10_5-back-to-k2_2.png` });

    // ---- Step 11: 全1ボタン → 上書き保存 → 完了 ----
    console.log('\nStep 11: 全1ボタン（実績=1）+ 上書き保存...');

    // 全1ボタン Playwright native click
    const all1Btn = await k2_2MainFrame.$('input[name="act_chooseall"]');
    if (all1Btn) {
      await all1Btn.click();
      console.log('  ✅ 全1ボタンクリック');
    } else {
      // フォールバック: evaluate で checkAllAndSet1 呼び出し
      await k2_2MainFrame.evaluate(() => {
        const win = window as any;
        if (typeof win.checkAllAndSet1 === 'function') {
          win.checkAllAndSet1('results');
        }
      });
      console.log('  ✅ 全1 (evaluate)');
    }
    await sleep(1000);
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-11-all1.png` });

    // 上書き保存
    console.log('  上書き保存...');
    const saveBtnK2_2 = await k2_2MainFrame.$('input[value="上書き保存"]');
    if (saveBtnK2_2) {
      await k2_2MainFrame.evaluate(() => { (window as any).submited = 0; });
      await saveBtnK2_2.click();
    } else {
      await nav.submitForm({ action: 'act_update', setLockCheck: true });
    }
    await sleep(3000);
    console.log('  ✅ 上書き保存完了');
    await hamPage.screenshot({ path: `${SCREENSHOTS_DIR}/real-12-saved.png` });

    // ---- Step 13: 検証 ----
    const k2_2Saved = await nav.getMainFrame('k2_2');
    const savedText = await k2_2Saved.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
    if (savedText.includes('エラー') && !savedText.includes('エラー：')) {
      console.log(`  ❌ 保存エラー: ${savedText.substring(0, 200)}`);
    } else {
      console.log('  ✅ 保存検証OK');
    }

    // ---- Step 14: Sheets ステータス更新 ----
    console.log('\nStep 14: Sheets ステータス更新...');
    await sheets.updateTranscriptionStatus(SHEET_ID, record.rowIndex, '転記済み');
    await sheets.writeDataFetchedAt(SHEET_ID, record.rowIndex, new Date().toISOString());
    console.log(`  ✅ row=${record.rowIndex} → 転記済み`);

    await auth.navigateToMainMenu();
    console.log('\n=== 転記テスト完了 ===');
    console.log('10秒後にブラウザを閉じます...');
    await sleep(10000);

  } catch (err) {
    console.error('\n❌ エラー:', (err as Error).message);
    console.error((err as Error).stack);
    try {
      for (const p of context.pages()) {
        await p.screenshot({ path: `${SCREENSHOTS_DIR}/real-error-${Date.now()}.png`, fullPage: true });
      }
    } catch { /* ignore */ }
  } finally {
    await browser.close();
    console.log('ブラウザ終了');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
