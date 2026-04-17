/**
 * 回填スクリプト: 転記済みだが AA列(assignId) が空のレコードに対して、
 * HAM k2_2 ページから assignId を取得して Google Sheets に書き込む。
 *
 * 使用方法:
 *   npx tsx src/scripts/backfill-assignids.ts                    # 全据点
 *   RUN_LOCATIONS=姶良 npx tsx src/scripts/backfill-assignids.ts  # 指定据点
 *   DRY_RUN=true npx tsx src/scripts/backfill-assignids.ts       # ドライラン
 *
 * 動作:
 *   1. 各据点の指定月タブから「転記済み」かつ assignId 空のレコードを取得
 *   2. 患者ごとにグループ化（同一患者をまとめて HAM 遷移回数を削減）
 *   3. HAM にログイン → k2_1 (利用者検索) → k2_2 (月間スケジュール)
 *   4. k2_2 の配置ボタン onclick から assignId を抽出
 *   5. Google Sheets AA列 に書き込み
 */
import dotenv from 'dotenv';
dotenv.config();

import { google, sheets_v4 } from 'googleapis';
import path from 'path';
import { logger } from '../core/logger';
import { loadConfig } from '../config/app.config';
import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { HamNavigator } from '../core/ham-navigator';
import { CJK_VARIANT_MAP_SERIALIZABLE, normalizeCjkName, resolveStaffAlias, extractPlainName } from '../core/cjk-normalize';
import { toHamDate, toHamMonthStart } from '../services/time-utils';

const config = loadConfig();
const DRY_RUN = process.env.DRY_RUN === 'true';
const TARGET_TAB = process.env.TARGET_TAB || '2026年04月';

/** 回填は全据点を対象とする（RUN_LOCATIONS を無視） */
const ALL_LOCATIONS = [
  { name: '姶良', sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M', stationName: '訪問看護ステーションあおぞら姶良', hamOfficeCode: '400021814' },
  { name: '荒田', sheetId: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4', stationName: '訪問看護ステーションあおぞら荒田', hamOfficeCode: '109152' },
  { name: '谷山', sheetId: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8', stationName: '訪問看護ステーションあおぞら谷山', hamOfficeCode: '400011055' },
  { name: '福岡', sheetId: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg', stationName: '訪問看護ステーションあおぞら福岡', hamOfficeCode: '103435' },
];

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

interface BackfillRecord {
  rowIndex: number;
  recordId: string;
  patientName: string;
  aozoraId: string;
  visitDate: string;
  startTime: string;
  staffName: string;
}

/** Google Sheets API 初期化 */
async function initSheets(): Promise<sheets_v4.Sheets> {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(keyPath),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

/** 転記済み + assignId 空のレコードを取得 */
async function getMissingRecords(sheets: sheets_v4.Sheets, sheetId: string): Promise<BackfillRecord[]> {
  const range = `'${TARGET_TAB}'!A2:AA`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  const rows = res.data.values || [];
  const records: BackfillRecord[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const recordId = row[0] || '';
    if (!recordId) continue;
    const transcriptionFlag = row[19] || ''; // T column
    const assignId = row[26] || ''; // AA column
    if (transcriptionFlag === '転記済み' && !assignId) {
      records.push({
        rowIndex: i + 2,
        recordId,
        patientName: row[6] || '',
        aozoraId: row[5] || '',
        visitDate: row[7] || '',
        startTime: row[8] || '',
        staffName: row[4] || '',
      });
    }
  }
  return records;
}

/** Sheet の列数が AA(27列) に足りなければ拡張し、残留 FALSE をクリアする */
async function ensureColumnAA(sheets: sheets_v4.Sheets, sheetId: string): Promise<void> {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(columnCount,rowCount)))',
  });
  for (const s of (res.data.sheets || [])) {
    if (s.properties?.title === TARGET_TAB) {
      const cols = s.properties.gridProperties?.columnCount || 0;
      const rowCount = s.properties.gridProperties?.rowCount || 0;
      if (cols < 27) {
        logger.info(`[${TARGET_TAB}] 列数=${cols} → 27 に拡張`);
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sheetId,
          requestBody: {
            requests: [{
              updateSheetProperties: {
                properties: {
                  sheetId: s.properties.sheetId!,
                  gridProperties: { columnCount: 27 },
                },
                fields: 'gridProperties.columnCount',
              },
            }],
          },
        });
        // 列拡張後、AA列に Z列の FALSE が溢出している場合があるのでクリア
        const aaRange = `'${TARGET_TAB}'!AA2:AA${rowCount}`;
        const aaRes = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: aaRange });
        const aaRows = aaRes.data.values || [];
        const dirtyCount = aaRows.filter(r => r[0] === 'FALSE' || r[0] === 'TRUE').length;
        if (dirtyCount > 0) {
          logger.info(`[${TARGET_TAB}] AA列の残留ブール値 ${dirtyCount}件 をクリア`);
          const emptyValues = aaRows.map(r => [(r[0] === 'FALSE' || r[0] === 'TRUE') ? '' : (r[0] || '')]);
          await sheets.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range: aaRange,
            valueInputOption: 'RAW',
            requestBody: { values: emptyValues },
          });
        }
      }
      return;
    }
  }
  throw new Error(`タブ "${TARGET_TAB}" が見つかりません (sheetId=${sheetId})`);
}

/** AA列に assignId を書き込み */
async function writeAssignId(sheets: sheets_v4.Sheets, sheetId: string, rowIndex: number, assignId: string): Promise<void> {
  if (DRY_RUN) {
    logger.info(`[DRY_RUN] row=${rowIndex} に assignId=${assignId} を書き込み（スキップ）`);
    return;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `'${TARGET_TAB}'!AA${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[assignId]] },
  });
}

/** k2_2 から指定日+時刻+スタッフの配置済み行 assignId を全て取得 */
async function extractAssignIds(
  nav: HamNavigator,
  visitDateHam: string,
  startTime: string,
  staffName?: string,
): Promise<string[]> {
  const frame = await nav.getMainFrame('k2_2');
  const dayNum = parseInt(visitDateHam.substring(6, 8));
  const staffSurname = staffName
    ? normalizeCjkName(resolveStaffAlias(extractPlainName(staffName))).substring(0, 3)
    : '';

  return frame.evaluate(({ targetDay, st, surname, variantMap }) => {
    function normCjk(s: string): string {
      let r = s.normalize('NFKC');
      r = r.replace(/[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, '');
      r = r.replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g, '');
      for (const [old, rep] of variantMap) { r = r.replaceAll(old, rep); }
      r = r.replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
      r = r.replace(/\u30F2/g, '\u30AA');
      r = r.replace(/\u30F1/g, '\u30A8');
      return r.replace(/[\s\u3000\u00a0]+/g, '');
    }

    const dayPattern = /(?:^|[^0-9])(\d{1,2})日/;
    const allRows = Array.from(document.querySelectorAll('tr'));
    const rowDayMap = new Map<Element, number>();
    let currentDay = -1;
    for (const row of allRows) {
      const m = (row.textContent || '').match(dayPattern);
      if (m) currentDay = parseInt(m[1]);
      rowDayMap.set(row, currentDay);
    }

    const stRegex = new RegExp(st.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*～');
    const ids: string[] = [];
    const seen = new Set<string>();

    // assignId 抽出: 行内の配置/削除ボタンの onclick から取得
    function extractIdFromRow(row: Element): string | null {
      // 配置ボタン: submitTargetFormEx(this.form, 'act_modify', assignid, 'XXXXX')
      const haichiBtn = row.querySelector('input[name="act_modify"][value="配置"]');
      if (haichiBtn) {
        const oc = haichiBtn.getAttribute('onclick') || '';
        const m = oc.match(/assignid\s*,\s*'(\d+)'/) || oc.match(/assignid\.value\s*=\s*'(\d+)'/);
        if (m) return m[1];
      }
      // 削除ボタン: confirmDelete('XXXXX', 'YYY')
      const delBtn = row.querySelector('input[name="act_delete"][value="削除"]');
      if (delBtn) {
        const oc = delBtn.getAttribute('onclick') || '';
        const m = oc.match(/confirmDelete\(\s*'(\d+)'/);
        if (m) return m[1];
      }
      return null;
    }

    const allTrs = document.querySelectorAll('tr');
    for (const tr of Array.from(allTrs)) {
      const rowDay = rowDayMap.get(tr) ?? -1;
      if (rowDay !== targetDay) continue;

      const rowText = tr.textContent || '';
      if (!stRegex.test(rowText)) continue;

      const staffCell = tr.querySelector('td[bgcolor="#DDEEFF"]');
      const rawStaffText = (staffCell?.textContent || '').replace(/[\s\u3000]+/g, '');
      if (!rawStaffText) continue;

      if (surname) {
        const staffText = normCjk(rawStaffText);
        if (!staffText.includes(surname)) continue;
      }

      const id = extractIdFromRow(tr);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }, { targetDay: dayNum, st: startTime, surname: staffSurname, variantMap: CJK_VARIANT_MAP_SERIALIZABLE });
}

/** k2_1 で患者名から careuserid を取得 */
async function findPatientId(nav: HamNavigator, patientName: string): Promise<string | null> {
  const frame = await nav.getMainFrame('k2_1');
  return frame.evaluate(
    (args: { name: string; vm: [string, string][] }) => {
      function norm(s: string): string {
        let r = s.normalize('NFKC');
        r = r.replace(/[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, '');
        r = r.replace(/[\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g, '');
        for (const [o, n] of args.vm) { if (r.includes(o)) r = r.replaceAll(o, n); }
        r = r.replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));
        r = r.replace(/\u30F2/g, '\u30AA');
        r = r.replace(/\u30F1/g, '\u30A8');
        return r.replace(/[\s\u3000\u00a0]+/g, '').trim();
      }
      const t = norm(args.name);
      for (const btn of Array.from(document.querySelectorAll('input[name="act_result"][value="決定"]'))) {
        const tr = btn.closest('tr');
        if (!tr || (tr.textContent || '').includes('(非表示)')) continue;
        if (norm(tr.textContent || '').includes(t)) {
          const m = (btn.getAttribute('onclick') || '').match(/careuserid\s*,\s*'(\d+)'/);
          if (m) return m[1];
        }
      }
      return null;
    },
    { name: patientName, vm: CJK_VARIANT_MAP_SERIALIZABLE },
  );
}

/** k2_1 → k2_2 遷移 */
async function navigateToK2_2(nav: HamNavigator, patientId: string): Promise<void> {
  const frame = await nav.getMainFrame('k2_1');
  await frame.evaluate((pid: string) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = window as any;
    const f = document.forms[0];
    w.submited = 0;
    if (typeof w.submitTargetFormEx === 'function') {
      w.submitTargetFormEx(f, 'k2_2', f.careuserid, pid);
    } else {
      f.careuserid.value = pid;
      f.doAction.value = 'k2_2';
      f.target = 'mainFrame';
      f.submit();
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, patientId);
  await nav.waitForMainFrame('k2_2', 15000);
  await sleep(1000);
}

/** k2_2 → k2_1 に戻る */
async function backToK2_1(nav: HamNavigator): Promise<void> {
  const hamPage = nav.hamPage;
  const allFrames = hamPage.frames();
  for (const f of allFrames) {
    try {
      const backBtn = await f.$('input[value="戻る"]');
      if (backBtn) {
        await backBtn.click();
        await nav.waitForMainFrame('k2_1', 10000);
        await sleep(500);
        return;
      }
    } catch { /* ignore */ }
  }
  // フォールバック
  await nav.submitForm({ action: 'act_back' });
  await sleep(2000);
}

async function main(): Promise<void> {
  const sheets = await initSheets();
  const locations = ALL_LOCATIONS;

  logger.info(`=== assignId 回填開始 (tab=${TARGET_TAB}, DRY_RUN=${DRY_RUN}) ===`);

  // Phase 1: 全据点のデータを先に読み込む
  const locationData: Array<{
    name: string;
    sheetId: string;
    stationName: string;
    hamOfficeCode: string;
    records: BackfillRecord[];
  }> = [];

  for (const loc of locations) {
    // AA列(27列目)が存在しない場合は拡張
    await ensureColumnAA(sheets, loc.sheetId);
    const records = await getMissingRecords(sheets, loc.sheetId);
    logger.info(`[${loc.name}] 転記済み+assignId空: ${records.length}件`);
    if (records.length > 0) {
      locationData.push({
        name: loc.name,
        sheetId: loc.sheetId,
        stationName: loc.stationName,
        hamOfficeCode: loc.hamOfficeCode,
        records,
      });
    }
  }

  const totalRecords = locationData.reduce((sum, l) => sum + l.records.length, 0);
  if (totalRecords === 0) {
    logger.info('回填対象なし。終了します。');
    return;
  }
  logger.info(`回填対象合計: ${totalRecords}件 (${locationData.length}据点)`);

  if (DRY_RUN) {
    logger.info('[DRY_RUN] HAM ログインをスキップ。対象レコードのみ表示。');
    for (const loc of locationData) {
      for (const r of loc.records) {
        logger.info(`[DRY_RUN] [${loc.name}] ${r.recordId} ${r.patientName} ${r.visitDate} ${r.startTime}`);
      }
    }
    return;
  }

  // Phase 2: HAM ブラウザ起動+ログイン → 据点ごとに処理
  const ai = new AIHealingService(process.env.OPENAI_API_KEY || '', process.env.AI_HEALING_MODEL || 'gpt-4o');
  const browser = new BrowserManager(new SelectorEngine(ai));
  await browser.launch();

  let totalFilled = 0;
  let totalFailed = 0;

  try {
    for (const loc of locationData) {
      logger.info(`\n${'='.repeat(60)}`);
      logger.info(`据点: ${loc.name} (${loc.records.length}件)`);
      logger.info('='.repeat(60));

      // 据点ごとにログイン（事業所が異なるため）
      const auth = new KanamickAuthService({
        url: config.kanamick.url,
        username: config.kanamick.username,
        password: config.kanamick.password,
        stationName: loc.stationName,
        hamOfficeKey: '6',
        hamOfficeCode: loc.hamOfficeCode,
      });
      auth.setContext(browser.browserContext, browser);
      const nav = await auth.login();

      await auth.navigateToBusinessGuide();
      await auth.navigateToUserSearch();

      // 患者名でグループ化（同一患者の HAM 遷移を 1 回にまとめる）
      const patientGroups = new Map<string, BackfillRecord[]>();
      for (const rec of loc.records) {
        const key = rec.patientName;
        if (!patientGroups.has(key)) patientGroups.set(key, []);
        patientGroups.get(key)!.push(rec);
      }
      logger.info(`患者数: ${patientGroups.size}（レコード ${loc.records.length}件）`);

      // 当月の検索日を設定（全レコード同月なので先頭で十分）
      const monthStart = toHamMonthStart(loc.records[0].visitDate);
      await nav.setSelectValue('searchdate', monthStart);
      await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_1' });
      await sleep(2000);

      let patientIdx = 0;
      for (const [patientName, records] of patientGroups) {
        patientIdx++;
        logger.info(`[${patientIdx}/${patientGroups.size}] ${patientName} (${records.length}件)`);

        try {
          // 患者ID取得（未検出時は再検索して1回リトライ）
          let pid = await findPatientId(nav, patientName);
          if (!pid) {
            logger.debug(`患者未検出: ${patientName} → 再検索してリトライ`);
            await nav.setSelectValue('searchdate', monthStart);
            await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_1' });
            await sleep(2000);
            pid = await findPatientId(nav, patientName);
          }
          if (!pid) {
            logger.warn(`患者未検出（再検索後も）: ${patientName} → スキップ`);
            totalFailed += records.length;
            continue;
          }

          // k2_2 に遷移
          await navigateToK2_2(nav, pid);

          // 各レコードの assignId を取得
          for (const rec of records) {
            try {
              const visitDateHam = toHamDate(rec.visitDate);
              const ids = await extractAssignIds(nav, visitDateHam, rec.startTime, rec.staffName);
              if (ids.length > 0) {
                const assignIdStr = ids.join(',');
                await writeAssignId(sheets, loc.sheetId, rec.rowIndex, assignIdStr);
                logger.info(`  row=${rec.rowIndex} ${rec.recordId} ${rec.visitDate} ${rec.startTime} → assignId=${assignIdStr}`);
                totalFilled++;
              } else {
                logger.warn(`  row=${rec.rowIndex} ${rec.recordId} ${rec.visitDate} ${rec.startTime} → assignId 未検出`);
                totalFailed++;
              }
            } catch (e) {
              logger.error(`  row=${rec.rowIndex} ${rec.recordId} エラー: ${(e as Error).message}`);
              totalFailed++;
            }
          }

          // k2_1 に戻る
          await backToK2_1(nav);

        } catch (e) {
          logger.error(`患者 ${patientName} 処理エラー: ${(e as Error).message}`);
          totalFailed += records.length;
          // k2_1 に戻る試み
          try {
            const currentPage = await nav.getCurrentPageId();
            if (currentPage === 'k2_2') {
              await backToK2_1(nav);
            } else if (currentPage !== 'k2_1') {
              await auth.navigateToMainMenu();
              await auth.navigateToBusinessGuide();
              await auth.navigateToUserSearch();
              await nav.setSelectValue('searchdate', monthStart);
              await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_1' });
              await sleep(2000);
            }
          } catch (recoveryErr) {
            logger.error(`復旧失敗: ${(recoveryErr as Error).message}`);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`回填完了: 成功=${totalFilled}, 失敗=${totalFailed}`);
  logger.info('='.repeat(60));
}

main().catch(e => {
  logger.error(`回填スクリプト異常終了: ${(e as Error).message}`);
  process.exit(1);
});
