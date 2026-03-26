# Add Office to Existing Staff Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate adding 荒田/谷山/福岡 office associations to existing TRITRUS employees, and register new employees who don't yet exist, by cross-referencing Google Sheet records with staff_info.csv.

**Architecture:** Script reads the target office's Google Sheet to extract unique staffNumbers, parses staff_info.csv (Shift-JIS) to determine which staff already exist in TRITRUS, then either adds the office association (existing) or creates the full registration (new). TRITRUS staff index page is scraped to get name→userId mapping for navigating to individual staff pages.

**Tech Stack:** TypeScript, Playwright (TRITRUS browser automation), googleapis (Google Sheets API), iconv-lite (Shift-JIS CSV), existing StaffSyncService/SpreadsheetService.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/utils/staff-csv-parser.ts` | Create | Parse staff_info.csv (Shift-JIS), return empNo→record lookup map |
| `src/workflows/staff-sync/staff-sync.workflow.ts` | Modify | Add `addOfficeForExistingStaff()` public method + `getStaffUserIdMap()` helper |
| `src/scripts/add-office-to-staff.ts` | Create | Main CLI script: --office, --dry-run, --tab, --limit, --offset flags |

---

## Context for Implementers

### staff_info.csv Structure
- Encoding: Shift-JIS (use `iconv.decode(buf, 'Shift_JIS')`)
- 211 records (including header), multiline quoted fields
- Key columns: [0]=氏名(フリガナ), [1]=氏名(漢字), [18]=従業員番号, [19]=事業所名
- empNo formats: 2-digit ("78"), 3-digit ("175"), 4-digit ("1482"), 8-digit zero-padded ("00000001")
- Normalize empNo by stripping leading zeros for comparison

### Google Sheet staffNumber
- Column D (index 3) = 従業員番号 (staffNumber)
- Column E (index 4) = スタッフ名 (staffName)
- Tab name format: `YYYY年MM月` (e.g., "2026年03月")
- Use `SpreadsheetService.getTranscriptionRecords(sheetId, tab)` to read

### 4 Office Configs (from app.config.ts)
```
姶良: tritrusOfficeCd=4664590280, stationName=訪問看護ステーションあおぞら姶良
荒田: tritrusOfficeCd=4660190861, stationName=訪問看護ステーションあおぞら荒田
谷山: tritrusOfficeCd=4660191471, stationName=訪問看護ステーションあおぞら谷山
福岡: tritrusOfficeCd=4060391200, stationName=訪問看護ステーションあおぞら福岡
```

### TRITRUS Staff Index Page
- URL: `https://portal.kanamic.net/tritrus/staffInfo/index`
- Table rows contain staff name + link with `href*="staffInfo?userId=XXX"`
- Name cells match regex: `/^[\u3000-\u9FFF\uFF00-\uFFEF]+[\s\u3000]+[\u3000-\u9FFF\uFF00-\uFFEF]+$/`
- `phase2_setOffice()` is already implemented on StaffSyncService (L1086-1301)

### Existing Already-Associated Staff (from CSV col[19])
- 荒田: 管理者(00000045,00000048), 木之瀬(175), 赤松(2073), 坂口(799), 萩山(884)
- 谷山: 管理者(00000045,00000048), 赤松(2073), 萩山(884)
- 福岡: 12 entries (mostly admin/care manager accounts)

---

## Chunk 1: CSV Parser + Dry-Run Script

### Task 1: Create staff-csv-parser.ts

**Files:**
- Create: `src/utils/staff-csv-parser.ts`

- [ ] **Step 1: Create the CSV parser utility**

```typescript
// src/utils/staff-csv-parser.ts
import fs from 'fs';
import iconv from 'iconv-lite';

export interface StaffCSVRecord {
  empNo: string;          // Raw empNo from CSV (may have leading zeros)
  normalizedEmpNo: string; // Leading zeros stripped
  name: string;           // 氏名(漢字) col[1]
  kana: string;           // 氏名(フリガナ) col[0]
  mainOffice: string;     // 代表事業所名称 col[14]
  offices: string[];      // 事業所名 col[19] split by comma
}

/**
 * Parse a properly-quoted CSV with multiline field support.
 * Returns array of rows, each row is array of field strings.
 */
function parseQuotedCSV(text: string): string[][] {
  const records: string[][] = [];
  let i = 0;
  while (i < text.length) {
    const row: string[] = [];
    while (i < text.length) {
      if (text[i] === '"') {
        i++; // skip opening quote
        let field = '';
        while (i < text.length) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; }
            else { i++; break; }
          } else { field += text[i]; i++; }
        }
        row.push(field);
      } else {
        let field = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i]; i++;
        }
        row.push(field);
      }
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '\r') i++;
      if (text[i] === '\n') { i++; break; }
      break;
    }
    if (row.length > 1 || (row.length === 1 && row[0])) records.push(row);
  }
  return records;
}

/** Strip leading zeros from empNo. "00001482" → "1482", "78" → "78" */
function normalizeEmpNo(empNo: string): string {
  const stripped = empNo.replace(/^0+/, '');
  return stripped || '0'; // edge case: "00000000" → "0"
}

/**
 * Parse staff_info.csv (Shift-JIS encoded) and return a Map keyed by normalized empNo.
 */
export function parseStaffInfoCSV(csvPath: string): Map<string, StaffCSVRecord> {
  const buf = fs.readFileSync(csvPath);
  const text = iconv.decode(buf, 'Shift_JIS');
  const rows = parseQuotedCSV(text);

  const map = new Map<string, StaffCSVRecord>();
  // Skip header (row 0)
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const empNo = (r[18] || '').trim();
    if (!empNo) continue;

    const normalized = normalizeEmpNo(empNo);
    const officesRaw = (r[19] || '').trim();

    map.set(normalized, {
      empNo,
      normalizedEmpNo: normalized,
      name: (r[1] || '').trim(),
      kana: (r[0] || '').trim(),
      mainOffice: (r[14] || '').trim(),
      offices: officesRaw ? officesRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
    });
  }

  return map;
}
```

- [ ] **Step 2: Verify with a quick smoke test**

Run: `npx tsx -e "const {parseStaffInfoCSV} = require('./src/utils/staff-csv-parser'); const m = parseStaffInfoCSV('./staff_info.csv'); console.log('count:', m.size); console.log('1482:', JSON.stringify(m.get('1482'))); console.log('175:', JSON.stringify(m.get('175')));"`
Expected: count ~106, 1482=永田美和子 with offices=[...姶良...], 175=木之瀬美津子 with offices=[...姶良..., ...荒田...]

### Task 2: Create add-office-to-staff.ts (dry-run mode)

**Files:**
- Create: `src/scripts/add-office-to-staff.ts`

- [ ] **Step 1: Create the main script with dry-run analysis**

The script should:
1. Accept CLI args: --office=荒田 (required), --dry-run, --tab=YYYY年MM月, --limit=N, --offset=N
2. Look up the office config from SHEET_LOCATIONS in app.config.ts
3. Parse staff_info.csv to build existing staff map
4. Read the Google Sheet for the target office → extract unique staffNumbers
5. Cross-reference: for each unique staffNumber from the sheet:
   - Check if it exists in CSV
   - If yes: check if the target office is already in offices[] → skip or "needs office addition"
   - If no: "needs creation"
6. Print a report

```typescript
// src/scripts/add-office-to-staff.ts
import dotenv from 'dotenv';
dotenv.config();

import { logger } from '../core/logger';
import { parseStaffInfoCSV } from '../utils/staff-csv-parser';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { AIHealingService } from '../core/ai-healing-service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { SmartHRService } from '../services/smarthr.service';
import { StaffSyncService, OfficeInfo } from '../workflows/staff-sync/staff-sync.workflow';
import path from 'path';

// 4 office configs (mirrored from app.config.ts SHEET_LOCATIONS)
const OFFICE_CONFIGS: Record<string, { sheetId: string; stationName: string; hamOfficeCode: string; tritrusOfficeCd: string }> = {
  '姶良': { sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M', stationName: '訪問看護ステーションあおぞら姶良', hamOfficeCode: '400021814', tritrusOfficeCd: '4664590280' },
  '荒田': { sheetId: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4', stationName: '訪問看護ステーションあおぞら荒田', hamOfficeCode: '109152', tritrusOfficeCd: '4660190861' },
  '谷山': { sheetId: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8', stationName: '訪問看護ステーションあおぞら谷山', hamOfficeCode: '400011055', tritrusOfficeCd: '4660191471' },
  '福岡': { sheetId: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg', stationName: '訪問看護ステーションあおぞら福岡', hamOfficeCode: '103435', tritrusOfficeCd: '4060391200' },
};

function normalizeEmpNo(empNo: string): string {
  const stripped = empNo.replace(/^0+/, '');
  return stripped || '0';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const officeArg = args.find(a => a.startsWith('--office='))?.split('=')[1];
  const dryRun = args.includes('--dry-run');
  const tabArg = args.find(a => a.startsWith('--tab='))?.split('=')[1];
  const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? parseInt(limitArg, 10) : undefined;
  const offsetArg = args.find(a => a.startsWith('--offset='))?.split('=')[1];
  const offset = offsetArg ? parseInt(offsetArg, 10) : undefined;

  if (!officeArg || !OFFICE_CONFIGS[officeArg]) {
    logger.error(`使用方法: npx tsx src/scripts/add-office-to-staff.ts --office=荒田 [--dry-run] [--tab=2026年03月]`);
    logger.error(`有効な事業所: ${Object.keys(OFFICE_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  const officeConfig = OFFICE_CONFIGS[officeArg];
  const officeInfo: OfficeInfo = {
    cd: officeConfig.tritrusOfficeCd,
    name: officeConfig.stationName,
  };

  logger.info('========================================');
  logger.info('  事業所追加スクリプト');
  logger.info(`  対象事業所: ${officeArg} (${officeConfig.stationName})`);
  logger.info(`  ドライラン: ${dryRun}`);
  if (tabArg) logger.info(`  タブ: ${tabArg}`);
  if (limit) logger.info(`  処理上限: ${limit}名`);
  if (offset) logger.info(`  スキップ: 先頭${offset}名`);
  logger.info('========================================');

  // Step 1: Parse staff_info.csv
  const csvPath = path.resolve(__dirname, '../../staff_info.csv');
  logger.info(`CSV 読込: ${csvPath}`);
  const csvStaff = parseStaffInfoCSV(csvPath);
  logger.info(`CSV スタッフ数: ${csvStaff.size}名`);

  // Step 2: Read Google Sheet for the target office
  const sheets = new SpreadsheetService(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json'
  );

  // Read current month + optionally specified tab
  const tabs: string[] = [];
  if (tabArg) {
    tabs.push(tabArg);
  } else {
    // Read both current and previous month to capture all staff
    const now = new Date();
    const curTab = `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月`;
    tabs.push(curTab);
    // Previous month
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevTab = `${prev.getFullYear()}年${String(prev.getMonth() + 1).padStart(2, '0')}月`;
    tabs.push(prevTab);
  }

  logger.info(`Google Sheet 読込: ${officeConfig.sheetId}`);
  logger.info(`タブ: ${tabs.join(', ')}`);

  const uniqueStaff = new Map<string, string>(); // normalizedEmpNo → staffName
  for (const tab of tabs) {
    try {
      const records = await sheets.getTranscriptionRecords(officeConfig.sheetId, tab);
      for (const rec of records) {
        const empNo = normalizeEmpNo(rec.staffNumber);
        if (empNo && empNo !== '0' && !uniqueStaff.has(empNo)) {
          uniqueStaff.set(empNo, rec.staffName);
        }
      }
      logger.info(`  ${tab}: ${records.length}件 → 累計ユニークスタッフ ${uniqueStaff.size}名`);
    } catch (error) {
      logger.warn(`  ${tab}: 読込失敗 (${(error as Error).message})`);
    }
  }

  logger.info(`Google Sheet ユニークスタッフ: ${uniqueStaff.size}名`);

  // Step 3: Cross-reference
  const needsOfficeAddition: Array<{ empNo: string; name: string; csvRecord: any }> = [];
  const alreadyHasOffice: Array<{ empNo: string; name: string }> = [];
  const needsCreation: Array<{ empNo: string; name: string }> = [];

  for (const [empNo, sheetStaffName] of uniqueStaff) {
    const csvRecord = csvStaff.get(empNo);
    if (csvRecord) {
      // Exists in CSV — check if target office already associated
      const hasTargetOffice = csvRecord.offices.some(o => o.includes(officeArg));
      if (hasTargetOffice) {
        alreadyHasOffice.push({ empNo, name: csvRecord.name });
      } else {
        needsOfficeAddition.push({ empNo, name: csvRecord.name, csvRecord });
      }
    } else {
      // Not in CSV — needs full creation
      needsCreation.push({ empNo, name: sheetStaffName });
    }
  }

  // Apply offset/limit to needsOfficeAddition
  let processAddition = [...needsOfficeAddition];
  if (offset && offset > 0) {
    processAddition = processAddition.slice(offset);
  }
  if (limit && limit > 0) {
    processAddition = processAddition.slice(0, limit);
  }

  // Step 4: Report
  logger.info('');
  logger.info('========== 分析結果 ==========');
  logger.info(`✅ 事業所設定済み（スキップ）: ${alreadyHasOffice.length}名`);
  for (const s of alreadyHasOffice) {
    logger.info(`   ${s.empNo} ${s.name}`);
  }
  logger.info(`🔧 事業所追加が必要: ${needsOfficeAddition.length}名${processAddition.length !== needsOfficeAddition.length ? ` (処理対象: ${processAddition.length}名)` : ''}`);
  for (const s of needsOfficeAddition) {
    const willProcess = processAddition.includes(s);
    logger.info(`   ${willProcess ? '→' : '  '} ${s.empNo} ${s.name}`);
  }
  logger.info(`🆕 新規作成が必要: ${needsCreation.length}名`);
  for (const s of needsCreation) {
    logger.info(`   ${s.empNo} ${s.name}`);
  }
  logger.info('==============================');

  if (dryRun) {
    logger.info('[DRY RUN] 分析のみ。ブラウザ操作は行いません。');
    return;
  }

  // Step 5: Execute (browser automation)
  if (processAddition.length === 0 && needsCreation.length === 0) {
    logger.info('処理対象なし。終了します。');
    return;
  }

  // Kanamick credentials check
  const kanamickUrl = process.env.KANAMICK_URL;
  const kanamickUser = process.env.KANAMICK_USERNAME;
  const kanamickPass = process.env.KANAMICK_PASSWORD;
  if (!kanamickUrl || !kanamickUser || !kanamickPass) {
    logger.error('KANAMICK_URL, KANAMICK_USERNAME, KANAMICK_PASSWORD が必要です');
    process.exit(1);
  }

  const aiHealing = new AIHealingService(
    process.env.OPENAI_API_KEY || '',
    process.env.AI_HEALING_MODEL || 'gpt-4o'
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

    // Phase A: Add office to existing staff
    if (processAddition.length > 0) {
      logger.info(`\n=== Phase A: 既存スタッフに事業所追加 (${processAddition.length}名) ===`);
      // SmartHR is not needed for office addition, but StaffSyncService constructor requires it
      const smarthrToken = process.env.SMARTHR_ACCESS_TOKEN || '';
      const smarthr = new SmartHRService({
        baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
        accessToken: smarthrToken,
      });
      const staffSync = new StaffSyncService(smarthr, auth, officeInfo);

      // Login to TRITRUS
      await auth.loginTritrusOnly();

      // Get staff userId mapping from TRITRUS index
      const page = auth.page;
      const userIdMap = await staffSync.getStaffUserIdMap(page);
      logger.info(`TRITRUS スタッフ userId マッピング: ${userIdMap.size}名`);

      let successCount = 0;
      let errorCount = 0;
      for (const staff of processAddition) {
        try {
          // Find userId by name
          const userId = userIdMap.get(staff.name);
          if (!userId) {
            // Try alternate name formats
            let found = false;
            for (const [mapName, mapUserId] of userIdMap) {
              if (mapName.replace(/\s+/g, '') === staff.name.replace(/\s+/g, '')) {
                await staffSync.addOfficeToStaff(page, mapUserId);
                successCount++;
                found = true;
                logger.info(`✅ 事業所追加完了: ${staff.empNo} ${staff.name}`);
                break;
              }
            }
            if (!found) {
              logger.warn(`⚠️ TRITRUS で見つかりません: ${staff.empNo} ${staff.name}`);
              errorCount++;
            }
          } else {
            await staffSync.addOfficeToStaff(page, userId);
            successCount++;
            logger.info(`✅ 事業所追加完了: ${staff.empNo} ${staff.name}`);
          }
        } catch (error) {
          logger.error(`❌ 事業所追加失敗: ${staff.empNo} ${staff.name} — ${(error as Error).message}`);
          errorCount++;
        }
      }
      logger.info(`Phase A 完了: 成功=${successCount}, エラー=${errorCount}`);
    }

    // Phase B: Create new staff (not in CSV)
    if (needsCreation.length > 0) {
      logger.info(`\n=== Phase B: 新規スタッフ作成 (${needsCreation.length}名) ===`);
      const smarthrToken = process.env.SMARTHR_ACCESS_TOKEN;
      if (!smarthrToken) {
        logger.warn('SMARTHR_ACCESS_TOKEN 未設定。新規作成をスキップします。');
      } else {
        const smarthr = new SmartHRService({
          baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
          accessToken: smarthrToken,
        });
        const staffSync = new StaffSyncService(smarthr, auth, officeInfo);

        let successCount = 0;
        let errorCount = 0;
        for (const staff of needsCreation) {
          try {
            const crew = await smarthr.getCrewByEmpCode(staff.empNo);
            if (!crew) {
              logger.warn(`⚠️ SmartHR に emp_code=${staff.empNo} が見つかりません: ${staff.name}`);
              errorCount++;
              continue;
            }
            const entry = smarthr.toStaffMasterEntry(crew);
            const result = await staffSync.registerSpecificStaff([entry]);
            if (result.errors > 0) {
              errorCount++;
              logger.error(`❌ 新規登録失敗: ${staff.empNo} ${staff.name}`);
            } else {
              successCount++;
              logger.info(`✅ 新規登録完了: ${staff.empNo} ${staff.name}`);
            }
          } catch (error) {
            logger.error(`❌ 新規登録エラー: ${staff.empNo} ${staff.name} — ${(error as Error).message}`);
            errorCount++;
          }
        }
        logger.info(`Phase B 完了: 成功=${successCount}, エラー=${errorCount}`);
      }
    }

  } catch (error) {
    logger.error(`異常終了: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  logger.error(`致命的エラー: ${(error as Error).message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Run dry-run to verify cross-reference**

Run: `npx tsx src/scripts/add-office-to-staff.ts --office=荒田 --dry-run`
Expected: List of staff categorized as ✅ already set, 🔧 needs addition, 🆕 needs creation

### Task 3: Add methods to StaffSyncService

**Files:**
- Modify: `src/workflows/staff-sync/staff-sync.workflow.ts`

- [ ] **Step 1: Add `getStaffUserIdMap()` method**

Add after `getExistingStaffNames()` (around line 1350):

```typescript
/**
 * TRITRUS スタッフ管理ページから {氏名 → userId} マッピングを取得。
 * 各テーブル行のリンク href から userId を抽出する。
 */
async getStaffUserIdMap(page: Page): Promise<Map<string, string>> {
  await this.navigateToStaffIndex(page);

  const entries: Array<{ name: string; userId: string }> = await page.evaluate(() => {
    const results: Array<{ name: string; userId: string }> = [];
    const rows = document.querySelectorAll('table tr');
    for (const row of Array.from(rows)) {
      // Find link with userId in this row
      const link = row.querySelector('a[href*="userId="]');
      if (!link) continue;
      const href = link.getAttribute('href') || '';
      const match = href.match(/userId=(\d+)/);
      if (!match) continue;

      // Find the name cell (CJK with space pattern)
      const cells = row.querySelectorAll('td');
      let name = '';
      for (const cell of Array.from(cells)) {
        const text = cell.textContent?.trim() || '';
        if (/^[\u3000-\u9FFF\uFF00-\uFFEF]+[\s\u3000]+[\u3000-\u9FFF\uFF00-\uFFEF]+$/.test(text)) {
          name = text.replace(/\s+/g, ' ').trim();
          break;
        }
      }
      if (name) {
        results.push({ name, userId: match[1] });
      }
    }
    return results;
  });

  const map = new Map<string, string>();
  for (const entry of entries) {
    map.set(entry.name, entry.userId);
  }
  logger.debug(`getStaffUserIdMap: ${map.size}名取得`);
  return map;
}
```

- [ ] **Step 2: Add `addOfficeToStaff()` method**

Add after `getStaffUserIdMap()`:

```typescript
/**
 * 既存スタッフの TRITRUS ページに事業所を追加する。
 * userId で staffInfo ページに直接遷移 → phase2_setOffice() を実行。
 */
async addOfficeToStaff(page: Page, userId: string): Promise<void> {
  const staffInfoUrl = `https://portal.kanamic.net/tritrus/staffInfo/staffInfo?userId=${userId}`;
  logger.debug(`addOfficeToStaff: ${staffInfoUrl}`);
  await page.goto(staffInfoUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await this.sleep(1500);

  // 事業所設定を実行
  await this.phase2_setOffice(page, staffInfoUrl);

  // スタッフ管理ページに戻る
  await this.tryRecoverToStaffIndex(page);
}
```

- [ ] **Step 3: Make `navigateToStaffIndex` and `tryRecoverToStaffIndex` accessible**

These methods are already called from public methods. `getStaffUserIdMap` and `addOfficeToStaff` need them.
Since these new methods are public, verify that `navigateToStaffIndex` and `tryRecoverToStaffIndex` are accessible (they are private but called from within the class — OK since new methods are on the same class).

- [ ] **Step 4: Verify tsc compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run --dry-run for 荒田 to verify analysis**

Run: `npx tsx src/scripts/add-office-to-staff.ts --office=荒田 --dry-run`
Expected: Proper categorization of staff

- [ ] **Step 6: Commit**

```bash
git add src/utils/staff-csv-parser.ts src/scripts/add-office-to-staff.ts src/workflows/staff-sync/staff-sync.workflow.ts
git commit -m "feat(staff-sync): add script to add office associations for existing staff"
```
