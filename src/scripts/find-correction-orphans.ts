/**
 * 修正孤児検出スクリプト
 *
 * 4月 assignId 未保存バグにより、修正管理で日付/時刻/利用者を変更した際に
 * 旧 HAM エントリが削除されず孤児として残存している。本スクリプトで検出し
 * 削除Sheet に追加する。
 *
 * ロジック:
 *   1. 修正管理「処理済み」かつキーフィールド変更ありのレコードを収集 → oldKeys
 *   2. 転記済み Sheet レコードを収集 → validKeys
 *   3. HAM 8-1 CSV をパース
 *   4. CSV entry.key が oldKeys に含まれ、validKeys に含まれない → 孤児
 *   5. 孤児を削除Sheetに追加
 *
 * 使用:
 *   npx tsx src/scripts/find-correction-orphans.ts         # 全据点、CSV自動DL
 *   DRY_RUN=true npx tsx src/scripts/find-correction-orphans.ts   # 検出のみ
 *   TARGET_MONTH=202604 npx tsx src/scripts/find-correction-orphans.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { logger } from '../core/logger';
import { loadConfig } from '../config/app.config';
import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { ScheduleCsvDownloaderService } from '../services/schedule-csv-downloader.service';
import { ReconciliationService } from '../services/reconciliation.service';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { parseChangeDetail, isKeyFieldChange, buildOldKeyValues } from '../workflows/correction/correction-sheet-sync';
import { normalizeCjkName, extractPlainName, resolveStaffAlias } from '../core/cjk-normalize';

const config = loadConfig();
const DRY_RUN = process.env.DRY_RUN === 'true';
const TARGET_MONTH = process.env.TARGET_MONTH || '202604';
const TARGET_TAB = `${TARGET_MONTH.substring(0, 4)}年${TARGET_MONTH.substring(4, 6)}月`;

const ALL_LOCATIONS = [
  { name: '姶良', sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M', stationName: '訪問看護ステーションあおぞら姶良', hamOfficeCode: '400021814' },
  { name: '荒田', sheetId: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4', stationName: '訪問看護ステーションあおぞら荒田', hamOfficeCode: '109152' },
  { name: '谷山', sheetId: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8', stationName: '訪問看護ステーションあおぞら谷山', hamOfficeCode: '400011055' },
  { name: '福岡', sheetId: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg', stationName: '訪問看護ステーションあおぞら福岡', hamOfficeCode: '103435' },
];

/** キー正規化: 患者+日付+開始時刻+スタッフ姓
 *  staff は "資格-姓名" 形式の接頭辞を除去してから正規化+エイリアス解決。
 *  Sheet: "理学療法士等-阪本大樹" / HAM CSV: "阪本 大樹" を同一キーに統一。
 */
function makeKey(patient: string, date: string, time: string, staff: string): string {
  const p = normalizeCjkName(patient);
  const d = date.replace(/[\/\-]/g, '').substring(0, 8); // YYYYMMDD
  const t = time.replace(/:/g, '').substring(0, 4);       // HHMM
  const staffPlain = extractPlainName(staff);
  const s = normalizeCjkName(resolveStaffAlias(staffPlain)).substring(0, 3); // 姓3文字
  return `${p}|${d}|${t}|${s}`;
}

async function main(): Promise<void> {
  const sheetService = new SpreadsheetService(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json');

  logger.info(`=== 修正孤児検出 (month=${TARGET_MONTH}, DRY_RUN=${DRY_RUN}) ===`);

  const ai = new AIHealingService(process.env.OPENAI_API_KEY || '', process.env.AI_HEALING_MODEL || 'gpt-4o');
  const browser = new BrowserManager(new SelectorEngine(ai));
  await browser.launch();

  let totalOrphans = 0;

  try {
    for (const loc of ALL_LOCATIONS) {
      logger.info(`\n${'='.repeat(60)}`);
      logger.info(`据点: ${loc.name}`);
      logger.info('='.repeat(60));

      // === Step 1: 修正管理 処理済み + キー変更 → oldKeys ===
      const corrections = await sheetService.getCorrectionRecords(loc.sheetId);
      const processedCorrs = corrections.filter(c =>
        (c.processedFlag === '1' || c.status === '処理済み')
      );

      // 転記済みレコード (Sheet側正規キー生成用、および oldKey 生成用)
      const allRecords = await sheetService.getTranscriptionRecords(loc.sheetId, TARGET_TAB);
      const transcribed = allRecords.filter(r => r.transcriptionFlag === '転記済み');

      const recordMap = new Map<string, typeof transcribed[0]>();
      for (const r of transcribed) recordMap.set(r.recordId, r);

      // oldKeys: 旧値ベースのキー
      const oldKeyDetails = new Map<string, { patient: string; date: string; time: string; staff: string; corrId: string }>();
      for (const corr of processedCorrs) {
        const changes = parseChangeDetail(corr.changeDetail);
        const keyChanges = changes.filter(c => isKeyFieldChange(c.field));
        if (keyChanges.length === 0) continue;
        const record = recordMap.get(corr.recordId);
        if (!record) continue;
        const oldVals = buildOldKeyValues(record, keyChanges);
        const k = makeKey(oldVals.patientName, oldVals.visitDate, oldVals.startTime, record.staffName);
        oldKeyDetails.set(k, {
          patient: oldVals.patientName,
          date: oldVals.visitDate,
          time: oldVals.startTime,
          staff: record.staffName,
          corrId: corr.correctionId,
        });
      }
      logger.info(`修正キー変更: ${oldKeyDetails.size}件`);

      if (oldKeyDetails.size === 0) {
        logger.info('→ 検査対象なし、スキップ');
        continue;
      }

      // === Step 2: validKeys = 現在の転記済み Sheet レコードキー ===
      const validKeys = new Set<string>();
      for (const r of transcribed) {
        validKeys.add(makeKey(r.patientName, r.visitDate, r.startTime, r.staffName));
      }

      // === Step 3: 8-1 CSV ダウンロード + パース ===
      const auth = new KanamickAuthService({
        url: config.kanamick.url,
        username: config.kanamick.username,
        password: config.kanamick.password,
        stationName: loc.stationName,
        hamOfficeKey: '6',
        hamOfficeCode: loc.hamOfficeCode,
      });
      auth.setContext(browser.browserContext, browser);
      await auth.login();

      const csvDownloader = new ScheduleCsvDownloaderService(auth);
      const today = new Date();
      const endDay = TARGET_MONTH === `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}`
        ? String(today.getDate()).padStart(2, '0')
        : undefined; // 過去月は月末まで
      const csvPath = await csvDownloader.ensureScheduleCsv({
        targetMonth: TARGET_MONTH,
        startDay: '01',
        endDay,
        force: true, // 最新取得
        downloadDir: `./downloads/${loc.name}`, // 据点別に保存（上書き防止）
      });
      logger.info(`CSV: ${csvPath}`);

      const reconService = new ReconciliationService(sheetService);
      // 非 merge 版: リハビリ結合で旧時刻行が吸収されるのを防止
      const hamEntries = reconService.parseScheduleCsv(csvPath);
      logger.info(`HAM CSV (raw): ${hamEntries.length}件`);

      // === Step 4: 孤児抽出 ===
      const orphans: Array<{
        patientName: string;
        visitDate: string;
        startTime: string;
        endTime: string;
        staffName: string;
        serviceType1: string;
        serviceType2: string;
        corrId: string;
      }> = [];

      for (const e of hamEntries) {
        const k = makeKey(e.patientName, e.visitDate, e.startTime, e.staffName);
        const oldDetail = oldKeyDetails.get(k);
        if (!oldDetail) continue;
        if (validKeys.has(k)) continue; // 現 Sheet と一致するなら孤児でない
        orphans.push({
          patientName: e.patientName,
          visitDate: e.visitDate,
          startTime: e.startTime,
          endTime: e.endTime,
          staffName: e.staffName,
          serviceType1: e.serviceName,
          serviceType2: e.serviceContent,
          corrId: oldDetail.corrId,
        });
      }

      logger.info(`孤児検出: ${orphans.length}件`);
      for (const o of orphans.slice(0, 10)) {
        logger.info(`  [${o.corrId}] ${o.patientName} ${o.visitDate} ${o.startTime}-${o.endTime} ${o.staffName}`);
      }
      if (orphans.length > 10) logger.info(`  ...他${orphans.length - 10}件`);

      // === Step 5: 削除Sheet追加 ===
      if (orphans.length > 0) {
        if (DRY_RUN) {
          logger.info(`[DRY_RUN] 削除Sheet追加スキップ`);
        } else {
          await sheetService.appendDeletionRecords(loc.sheetId, orphans.map(o => ({
            patientName: o.patientName,
            visitDate: o.visitDate,
            startTime: o.startTime,
            endTime: o.endTime,
            staffName: o.staffName,
            serviceType1: o.serviceType1,
            serviceType2: o.serviceType2,
          })));
          logger.info(`削除Sheet追加完了: ${orphans.length}件`);
        }
        totalOrphans += orphans.length;
      }
    }
  } finally {
    await browser.close();
  }

  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`完了: 孤児合計 ${totalOrphans}件`);
  logger.info('='.repeat(60));
}

main().catch(e => {
  logger.error(`孤児検出スクリプト異常終了: ${(e as Error).message}`);
  process.exit(1);
});
