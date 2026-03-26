/**
 * 既存スタッフへの事業所追加スクリプト
 *
 * Google Sheet のレコードから対象事業所のスタッフ一覧を取得し、
 * staff_info.csv と突合して以下を自動実行する:
 *   - CSV に存在 → TRITRUS 上で事業所追加のみ (Phase2 setOffice)
 *   - CSV に不在 → SmartHR 経由でフル登録 (Phase1→2→3)
 *
 * 使用方法:
 *   npx tsx src/scripts/add-office-to-staff.ts --office=荒田 --dry-run
 *   npx tsx src/scripts/add-office-to-staff.ts --office=荒田
 *   npx tsx src/scripts/add-office-to-staff.ts --office=荒田 --tab=2026年02月
 *   npx tsx src/scripts/add-office-to-staff.ts --office=荒田 --limit=5 --offset=2
 */
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { logger } from '../core/logger';
import { parseStaffInfoCSV, normalizeEmpNo } from '../utils/staff-csv-parser';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { SmartHRService } from '../services/smarthr.service';
import { StaffSyncService, type OfficeInfo } from '../workflows/staff-sync/staff-sync.workflow';

// ============================================================
// 事業所設定（app.config.ts SHEET_LOCATIONS と同一）
// ============================================================

const OFFICE_CONFIGS: Record<string, {
  sheetId: string;
  stationName: string;
  hamOfficeCode: string;
  tritrusOfficeCd: string;
}> = {
  '姶良': { sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M', stationName: '訪問看護ステーションあおぞら姶良', hamOfficeCode: '400021814', tritrusOfficeCd: '4664590280' },
  '荒田': { sheetId: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4', stationName: '訪問看護ステーションあおぞら荒田', hamOfficeCode: '109152', tritrusOfficeCd: '4660190861' },
  '谷山': { sheetId: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8', stationName: '訪問看護ステーションあおぞら谷山', hamOfficeCode: '400011055', tritrusOfficeCd: '4660191471' },
  '福岡': { sheetId: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg', stationName: '訪問看護ステーションあおぞら福岡', hamOfficeCode: '103435', tritrusOfficeCd: '4060391200' },
};

// ============================================================
// CLI 引数パース
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    office: args.find(a => a.startsWith('--office='))?.split('=')[1],
    dryRun: args.includes('--dry-run'),
    tab: args.find(a => a.startsWith('--tab='))?.split('=')[1],
    startMonth: args.find(a => a.startsWith('--start-month='))?.split('=')[1], // "YYYY/MM" 例: "2026/02"
    limit: (() => { const v = args.find(a => a.startsWith('--limit='))?.split('=')[1]; return v ? parseInt(v, 10) : undefined; })(),
    offset: (() => { const v = args.find(a => a.startsWith('--offset='))?.split('=')[1]; return v ? parseInt(v, 10) : undefined; })(),
  };
}

// ============================================================
// メイン処理
// ============================================================

async function main(): Promise<void> {
  const { office: officeArg, dryRun, tab: tabArg, startMonth, limit, offset } = parseArgs();

  // バリデーション
  if (!officeArg || !OFFICE_CONFIGS[officeArg]) {
    logger.error('使用方法: npx tsx src/scripts/add-office-to-staff.ts --office=荒田 [--dry-run] [--start-month=2026/02] [--tab=2026年03月] [--limit=N] [--offset=N]');
    logger.error(`有効な事業所: ${Object.keys(OFFICE_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  const officeConfig = OFFICE_CONFIGS[officeArg];
  const officeInfo: OfficeInfo = {
    cd: officeConfig.tritrusOfficeCd,
    name: officeConfig.stationName,
  };

  // 情報有効期間の開始日（デフォルト: 2026/02/01 — 2月データがあるため）
  const validityStartDate = startMonth
    ? `${startMonth}/01`   // "2026/02" → "2026/02/01"
    : '2026/02/01';

  logger.info('========================================');
  logger.info('  事業所追加スクリプト');
  logger.info(`  対象事業所: ${officeArg} (${officeConfig.stationName})`);
  logger.info(`  情報有効期間開始: ${validityStartDate}`);
  logger.info(`  ドライラン: ${dryRun}`);
  if (tabArg) logger.info(`  タブ: ${tabArg}`);
  if (limit) logger.info(`  処理上限: ${limit}名`);
  if (offset) logger.info(`  スキップ: 先頭${offset}名`);
  logger.info('========================================');

  // ============================================================
  // Step 1: staff_info.csv パース
  // ============================================================

  const csvPath = path.resolve(__dirname, '../../staff_info.csv');
  logger.info(`CSV 読込: ${csvPath}`);
  const csvStaff = parseStaffInfoCSV(csvPath);
  logger.info(`CSV スタッフ数: ${csvStaff.size}名`);

  // ============================================================
  // Step 2: Google Sheet 読込 → ユニークスタッフ抽出
  // ============================================================

  const sheets = new SpreadsheetService(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json',
  );

  // 読込対象タブ: 指定があればそれのみ、なければ当月+前月
  const tabs: string[] = [];
  if (tabArg) {
    tabs.push(tabArg);
  } else {
    const now = new Date();
    tabs.push(`${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月`);
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    tabs.push(`${prev.getFullYear()}年${String(prev.getMonth() + 1).padStart(2, '0')}月`);
  }

  logger.info(`Google Sheet: ${officeConfig.sheetId}`);
  logger.info(`タブ: ${tabs.join(', ')}`);

  // empNo → staffName（Sheet上の表記）
  const uniqueStaff = new Map<string, string>();
  for (const tab of tabs) {
    try {
      const records = await sheets.getTranscriptionRecords(officeConfig.sheetId, tab);
      for (const rec of records) {
        const empNo = normalizeEmpNo(rec.staffNumber);
        if (empNo && empNo !== '0' && !uniqueStaff.has(empNo)) {
          uniqueStaff.set(empNo, rec.staffName);
        }
      }
      logger.info(`  ${tab}: ${records.length}件 → 累計ユニーク ${uniqueStaff.size}名`);
    } catch (error) {
      logger.warn(`  ${tab}: 読込失敗 (${(error as Error).message})`);
    }
  }

  logger.info(`Google Sheet ユニークスタッフ: ${uniqueStaff.size}名`);

  // ============================================================
  // Step 3: 突合 → 3グループに分類
  // ============================================================

  const alreadyHasOffice: Array<{ empNo: string; name: string }> = [];
  const needsOfficeAddition: Array<{ empNo: string; name: string; csvName: string }> = [];
  const needsCreation: Array<{ empNo: string; name: string }> = [];

  for (const [empNo, sheetStaffName] of uniqueStaff) {
    const csvRecord = csvStaff.get(empNo);
    if (csvRecord) {
      // CSV に存在 → 事業所チェック
      const hasTarget = csvRecord.offices.some(o => o.includes(officeArg));
      if (hasTarget) {
        alreadyHasOffice.push({ empNo, name: csvRecord.name });
      } else {
        needsOfficeAddition.push({ empNo, name: sheetStaffName, csvName: csvRecord.name });
      }
    } else {
      // CSV に不在 → 新規作成
      needsCreation.push({ empNo, name: sheetStaffName });
    }
  }

  // offset/limit は Phase A + Phase B の合算リストに適用
  const allToProcess: Array<{ empNo: string; name: string; csvName?: string; phase: 'A' | 'B' }> = [
    ...needsOfficeAddition.map(s => ({ empNo: s.empNo, name: s.name, csvName: s.csvName, phase: 'A' as const })),
    ...needsCreation.map(s => ({ empNo: s.empNo, name: s.name, phase: 'B' as const })),
  ];
  let processSlice = [...allToProcess];
  if (offset && offset > 0) processSlice = processSlice.slice(offset);
  if (limit && limit > 0) processSlice = processSlice.slice(0, limit);
  const processAddition = processSlice.filter(s => s.phase === 'A');
  const processCreation = processSlice.filter(s => s.phase === 'B');

  // ============================================================
  // Step 4: レポート出力
  // ============================================================

  logger.info('');
  logger.info('========== 分析結果 ==========');

  logger.info(`✅ 事業所設定済み（スキップ）: ${alreadyHasOffice.length}名`);
  for (const s of alreadyHasOffice) {
    logger.info(`   ${s.empNo} ${s.name}`);
  }

  logger.info(`🔧 事業所追加が必要: ${needsOfficeAddition.length}名${
    processAddition.length !== needsOfficeAddition.length
      ? ` (処理対象: ${processAddition.length}名)`
      : ''
  }`);
  for (const s of needsOfficeAddition) {
    const willProcess = processAddition.some(p => p.empNo === s.empNo);
    logger.info(`   ${willProcess ? '→' : '  '} ${s.empNo} ${s.csvName}`);
  }

  logger.info(`🆕 CSV未登録: ${needsCreation.length}名${
    processCreation.length !== needsCreation.length
      ? ` (処理対象: ${processCreation.length}名)`
      : ''
  }`);
  for (const s of needsCreation) {
    const willProcess = processCreation.some(p => p.empNo === s.empNo);
    logger.info(`   ${willProcess ? '→' : '  '} ${s.empNo} ${s.name}`);
  }

  logger.info(`\n  処理合計: ${processSlice.length}名 (Phase A: ${processAddition.length}, Phase B: ${processCreation.length})`);
  logger.info('==============================');

  if (dryRun) {
    logger.info('[DRY RUN] 分析のみ。ブラウザ操作は行いません。');
    return;
  }

  // ============================================================
  // Step 5: 実行（ブラウザ操作）
  // ============================================================

  if (processAddition.length === 0 && processCreation.length === 0) {
    logger.info('処理対象なし。終了します。');
    return;
  }

  // 認証情報チェック
  const kanamickUrl = process.env.KANAMICK_URL;
  const kanamickUser = process.env.KANAMICK_USERNAME;
  const kanamickPass = process.env.KANAMICK_PASSWORD;
  if (!kanamickUrl || !kanamickUser || !kanamickPass) {
    logger.error('KANAMICK_URL, KANAMICK_USERNAME, KANAMICK_PASSWORD が必要です');
    process.exit(1);
  }

  const aiHealing = new AIHealingService(
    process.env.OPENAI_API_KEY || '',
    process.env.AI_HEALING_MODEL || 'gpt-4o',
  );
  const selectorEngine = new SelectorEngine(aiHealing);
  const browser = new BrowserManager(selectorEngine);
  const auth = new KanamickAuthService({
    url: kanamickUrl,
    username: kanamickUser,
    password: kanamickPass,
    stationName: officeConfig.stationName,
    hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
    hamOfficeCode: officeConfig.hamOfficeCode,
  });

  try {
    await browser.launch();
    auth.setContext(browser.browserContext);

    // SmartHR 初期化（Phase B で必要、Phase A でも StaffSyncService コンストラクタに必要）
    const smarthrToken = process.env.SMARTHR_ACCESS_TOKEN || '';
    const smarthr = new SmartHRService({
      baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
      accessToken: smarthrToken,
    });
    const staffSync = new StaffSyncService(smarthr, auth, officeInfo);

    // TRITRUS + HAM ログイン（Phase3 で HAM 資格登録が必要）
    await auth.login();
    let page = auth.page;

    // ---- Phase A: 既存スタッフに事業所追加（従業員番号で検索して staffInfo に遷移）----
    if (processAddition.length > 0) {
      logger.info(`\n=== Phase A: 既存スタッフに事業所追加 (${processAddition.length}名) ===`);

      let successCount = 0;
      let errorCount = 0;

      for (const staff of processAddition) {
        try {
          // ブラウザ生存チェック — クラッシュ後は再ログイン
          if (page.isClosed()) {
            logger.warn('ページがクローズされています。再ログインします…');
            await browser.launch();
            auth.setContext(browser.browserContext);
            await auth.login();
            page = auth.page;
          }
          logger.info(`処理中: ${staff.empNo} ${staff.csvName || staff.name}`);
          // SmartHR から資格情報を取得（HAM Phase3 用）
          let staffEntry = null;
          try {
            const crew = await smarthr.getCrewByEmpCode(staff.empNo);
            if (crew) staffEntry = smarthr.toStaffMasterEntry(crew);
          } catch { /* SmartHR 取得失敗時は Phase3 スキップで継続 */ }
          await staffSync.addOfficeToStaff(page, staff.empNo, staffEntry, validityStartDate);
          successCount++;
          logger.info(`✅ 事業所追加完了: ${staff.empNo} ${staff.csvName || staff.name}`);
        } catch (error) {
          const msg = (error as Error).message;
          logger.error(`❌ 事業所追加失敗: ${staff.empNo} ${staff.csvName || staff.name} — ${msg}`);
          errorCount++;
          // ブラウザクラッシュ検出 — 次のループで再ログインさせる
          if (msg.includes('Target page') || msg.includes('browser has been closed')) {
            logger.warn('ブラウザクラッシュ検出。次の処理で再起動します。');
            try { await browser.close(); } catch { /* ignore */ }
          }
        }
      }

      logger.info(`Phase A 完了: 成功=${successCount}, エラー=${errorCount}`);
    }

    // ---- Phase B: CSV に不在のスタッフ（TRITRUS で従業員番号検索 → 存在なら事業所追加、不在なら新規作成）----
    if (processCreation.length > 0) {
      logger.info(`\n=== Phase B: CSV未登録スタッフ処理 (${processCreation.length}名) ===`);

      let addedCount = 0;
      let createdCount = 0;
      let errorCount = 0;

      for (const staff of processCreation) {
        try {
          // ブラウザ生存チェック — クラッシュ後は再ログイン
          if (page.isClosed()) {
            logger.warn('ページがクローズされています。再ログインします…');
            await browser.launch();
            auth.setContext(browser.browserContext);
            await auth.login();
            page = auth.page;
          }

          // まず従業員番号で TRITRUS 検索（CSV にないが TRITRUS には存在する場合）
          const navResult = await staffSync.navigateToStaffByEmpNo(page, staff.empNo);
          if (navResult.found) {
            // TRITRUS に存在 → 事業所追加のみ（既に staffInfo ページにいる）
            logger.info(`TRITRUS 既存: ${staff.empNo} ${staff.name} → 事業所追加`);
            let staffEntry = null;
            try {
              const crew = await smarthr.getCrewByEmpCode(staff.empNo);
              if (crew) staffEntry = smarthr.toStaffMasterEntry(crew);
            } catch { /* ignore */ }
            const staffInfoUrl = page.url();
            await staffSync.addOfficeToStaffFromCurrentPage(page, staffInfoUrl, staffEntry, validityStartDate);
            addedCount++;
            logger.info(`✅ 事業所追加完了: ${staff.empNo} ${staff.name}`);
            continue;
          }

          // TRITRUS にも不在 → SmartHR 経由で新規作成
          if (!smarthrToken) {
            logger.warn(`⚠️ SmartHR 未設定、新規作成スキップ: ${staff.empNo} ${staff.name}`);
            errorCount++;
            continue;
          }

          const crew = await smarthr.getCrewByEmpCode(staff.empNo);
          if (!crew) {
            logger.warn(`⚠️ SmartHR に emp_code=${staff.empNo} が見つかりません: ${staff.name}`);
            errorCount++;
            continue;
          }
          const entry = smarthr.toStaffMasterEntry(crew);
          logger.info(`新規登録中: ${staff.empNo} ${entry.staffName}`);

          const result = await staffSync.registerSpecificStaff([entry], validityStartDate);
          if (result.errors > 0) {
            errorCount++;
            logger.error(`❌ 新規登録失敗: ${staff.empNo} ${entry.staffName}`);
          } else {
            // registerSpecificStaff 内で有効期間設定済みのため、事後補正は不要
            if (false && validityStartDate) {
              // registerSpecificStaff() 後にページが閉じている/壊れている場合は再ログイン
              if (page.isClosed()) {
                logger.warn('新規登録後にページがクローズされています。再ログインします…');
                await browser.launch();
                auth.setContext(browser.browserContext);
                await auth.login();
                page = auth.page;
              }

              try {
                await staffSync.updateValidityPeriodForStaff(page, staff.empNo, validityStartDate);
                logger.info(`情報有効期間補正完了: ${staff.empNo} ${entry.staffName} → ${validityStartDate}`);
              } catch (validityError) {
                errorCount++;
                logger.error(`❌ 有効期間補正失敗: ${staff.empNo} ${entry.staffName} — ${(validityError as Error).message}`);
                continue;
              }
            }

            createdCount++;
            logger.info(`✅ 新規登録完了: ${staff.empNo} ${entry.staffName}`);
          }
        } catch (error) {
          const msg = (error as Error).message;
          logger.error(`❌ 処理エラー: ${staff.empNo} ${staff.name} — ${msg}`);
          errorCount++;
          // ブラウザクラッシュ検出 — 次のループで再ログイン
          if (msg.includes('Target page') || msg.includes('browser has been closed')) {
            logger.warn('ブラウザクラッシュ検出。次の処理で再起動します。');
            try { await browser.close(); } catch { /* ignore */ }
          }
        }
      }

      logger.info(`Phase B 完了: 事業所追加=${addedCount}, 新規作成=${createdCount}, エラー=${errorCount}`);
    }

    logger.info('\n========================================');
    logger.info('  全処理完了');
    logger.info('========================================');
  } catch (error) {
    logger.error(`異常終了: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ============================================================
// ヘルパー
// ============================================================

/** Google Sheet のスタッフ名から資格プレフィックスを除去: "看護師-畠中梨奈" → "畠中梨奈" */
function stripQualificationPrefix(name: string): string {
  return name.replace(/^(看護師|正看護師|准看護師|理学療法士等|作業療法士|言語聴覚士|保健師)-/, '');
}

/**
 * TRITRUS の userId マップから氏名で検索。
 * 完全一致 → スペース正規化 → スペース除去 → 資格プレフィックス除去+スペース除去 の順で試行。
 */
function findUserId(map: Map<string, string>, name: string): string | undefined {
  // 完全一致
  const exact = map.get(name);
  if (exact) return exact;

  // スペース正規化して比較（全角/半角スペースの違い吸収）
  const normalizedName = name.replace(/[\s\u3000]+/g, ' ').trim();
  for (const [mapName, mapUserId] of map) {
    if (mapName.replace(/[\s\u3000]+/g, ' ').trim() === normalizedName) {
      return mapUserId;
    }
  }

  // スペース完全除去して比較
  const noSpaceName = name.replace(/[\s\u3000]+/g, '');
  for (const [mapName, mapUserId] of map) {
    if (mapName.replace(/[\s\u3000]+/g, '') === noSpaceName) {
      return mapUserId;
    }
  }

  // 資格プレフィックス除去 + スペース除去（"看護師-畠中梨奈" → "畠中梨奈" vs "畠中 梨奈"）
  const stripped = stripQualificationPrefix(name).replace(/[\s\u3000]+/g, '');
  if (stripped !== noSpaceName) {
    for (const [mapName, mapUserId] of map) {
      if (mapName.replace(/[\s\u3000]+/g, '') === stripped) {
        return mapUserId;
      }
    }
  }

  return undefined;
}

// ============================================================
// エントリポイント
// ============================================================

main().catch(error => {
  logger.error(`致命的エラー: ${(error as Error).message}`);
  process.exit(1);
});
