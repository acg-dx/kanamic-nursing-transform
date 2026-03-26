# HAM 2月度 看護医療資格修正 + 漏登録補完 + HAM不要記録削除 + シート改善

## TL;DR

> **Quick Summary**: HAM 8-1 看護医療スケジュールの212件の資格誤登録（冨迫広美123件+永松アケミ89件）を修正し、12件の転記漏れを補完、4件のHAM不要記録を削除する。根本原因の k2_3a 資格選択フロー（searchKbn radio未対応）を修正し、中間シートの改善を行う。
>
> **Deliverables**:
> - k2_3a 資格選択フローの根本原因修正（searchKbn radio → 検索 → フィルタ結果選択）
> - 212件の看護医療資格修正（削除→准看護師サービス種類で再登録）
> - 12件の漏登録補完
> - 4件のHAM不要記録削除（窪田×2, 生野×1, 有田勉重複×1）
> - 中間シートに「加算対象の理由」列を追加（R-S間）
> - 中間シートのE列を「資格-姓名」形式に変更
> - dxgroup@aozora-cg.com をシート保護対象外に追加
> - 削除Sheet連動（月Sheet行自動削除）
> - reconciliation フィルタ修正（超減算除外 + SmartHR検出）
> - record2flag / retry 重複防止修正
>
> **Estimated Effort**: Large（212件のHAM操作 = 推定7-10時間 + コード修正4-6時間 + シート改善2-3時間）
> **Parallel Execution**: YES — 3 waves + FINAL
> **Critical Path**: [A1+C1+C2](Wave1並行) → [B2+B3+B1](Wave2順次) → E1(Wave3) → FINAL

---

## Context

### Original Request
ユーザーは以下を要求:
1. HAMの8-1 CSVと中間シート（Google Sheets）の突合
2. 准看護師/看護師の資格誤登録を検出・修正
3. 突合で発見された漏登録の補完
4. HAMにあるがsheetにない記録の削除
5. 中間シートの構造改善（列追加、保護設定、削除連動）

### Interview Summary
**Key Discussions**:
- **修正範囲**: 看護医療のみ（212件）、介護保険は修正しない
- **実行順序**: sheet確認 → 削除処理 → HAM不要記録削除 → 漏登録12件 → 資格修正212件
- **資格の権威ソース**: SmartHRの資格1~8カスタムフィールド
- **資格優先度ルール**: 看護師 > 准看護師（両方保有時は看護師を適用）
- **E列形式**: 方案B — "資格-姓名"形式（例: "看護師-冨迫広美"）、新列不要
- **加算対象の理由列**: R(緊急時事務員チェック)とS(転記フラグ)の間に挿入

**Research Findings**:
- CSVサービス種類は3種: 看護医療(593件), 訪問看護(236件), 予防訪問看護(80件)
- 看護医療の准看護師識別: サービス内容末尾の「・准」有無（訪問看護基本療養費（Ⅰ・Ⅱ）vs ・准）
- ★根本原因: selectQualificationInFrame()が`name.includes('shikaku')`で検索するが実際HAM HTMLは`name="searchKbn"` → 全件デフォルト看護師等で登録
- ★検索ボタン未実装: 資格radio選択後の検索クリック欠落 → フィルタ結果が表示されない
- resolveIryo()は93#1001を常時返却 — 資格区別はsearchKbnラジオによる（サービスコードではない）
- reconciliation v2の243件は不正確（永松アケミ漏れ + 有村愛誤判定）→ SmartHR照合で212件
- SmartHR確認: 冨迫広美・永松アケミは准看護師のみ保有（看護師は保有していない）
- 20件のHAM余分記録: 15件は超減算(正常), 4件が削除対象, 有田勉1件は重複

### Metis Review
**Identified Gaps** (addressed):
- **バッチ処理**: 212件=424 HAM操作=14-21時間 → 50件/バッチ + バッチ間re-login + checkpoint/resume
- **HAMセッションタイムアウト**: 長時間実行 → バッチ間で再ログインして対応
- **既存テスト**: 列変更でmockデータ影響 → `npx vitest run` ステップ追加
- **resolveKaigo准看護師**: 介護不修正のため今回はスキップ、将来修正としてフラグ

---

## Work Objectives

### Core Objective
SmartHRの資格データを権威ソースとして、HAM 2月度の看護医療212件の資格誤登録を修正し、漏登録12件を補完、不要記録4件を削除する。

### Concrete Deliverables
- 修正済みHAMデータ（212件の看護医療資格修正 + 12件の漏登録 + 4件の削除）
- `src/scripts/run-qualification-correction.ts` — 資格修正CLIスクリプト（dry-run/execute対応）
- `src/services/qualification-correction.service.ts` — 修正ロジック
- `reconciliation-report-202602-v3.txt` — 修正後検証レポート
- 修正済みのk2_3a資格選択フロー（全転記に影響する恒久修正）

### Definition of Done
- [ ] 看護医療の資格不一致 = 0件（修正後の8-1 CSV再突合で確認）
- [ ] 転記漏れ = 0件
- [ ] HAM不要記録 = 0件（超減算15件除く）
- [ ] k2_3a searchKbn radio → 検索 → フィルタ結果選択が正常動作
- [ ] `npx tsc --noEmit` エラーゼロ
- [ ] `npx vitest run` 全テスト通過

### Must Have
- SmartHR APIで資格判定（看護師 > 准看護師の優先度ルール実装）
- Dry-runモード
- 50件/バッチ + バッチ間re-login
- record2flag=1の場合は明示的エラー終了
- 削除前の完全ログ

### Must NOT Have (Guardrails)
- 介護保険の資格修正をしてはならない（看護医療のみ）
- reconciliation-report-v2.txtを修正リストのソースとして使用してはならない
- 有村愛・木場亜紗実の看護師登録を「修正」してはならない（正しい）
- 単一バッチで全212件を処理してはならない
- 15件の超減算レコードを削除してはならない

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision
- **Infrastructure exists**: YES (vitest)
- **Automated tests**: Tests-after（修正後に`npx vitest run`で既存テスト通過確認）
- **Framework**: vitest

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{ID}-{scenario-slug}.{ext}`.

- **HAM browser verification**: Playwright via existing auth service
- **Script output verification**: Bash (`npx tsx`)
- **CSV verification**: Bash — download CSV, parse, count

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — code fixes + sheet changes, ALL parallel):
├── A1: Fix k2_3a qualification selection flow (searchKbn) [deep] ★ROOT CAUSE
├── A2: Fix record2flag=1 silent-fail [quick]
├── A3: Fix retry duplicate registration bug [quick]
├── A4: Fix reconciliation 超減算 filter [quick]
├── A5: Fix reconciliation SmartHR-based detection [quick]
├── A6: Fix deletion → month sheet sync [unspecified-high]
├── C1: Insert 加算対象の理由 column + update indices [deep]
├── C2: Change E列 to "資格-姓名" format + extractPlainName() [deep]
├── C3: Add dxgroup@aozora-cg.com to sheet protection [quick]
└── D1: Build qualification correction manifest generator [deep]

Wave 2 (After Wave 1 — data operations, SEQUENTIAL):
├── B0: Check sheet current state (pending + deletions) [quick]
├── B1: Delete 4 extra HAM records [unspecified-high]
├── B2: Register 12 missing records [unspecified-high]
└── B3: Execute 212 qualification corrections (dry-run → batched) [deep]

Wave 3 (After Wave 2 — verification):
└── E1: Download fresh CSV + final reconciliation v3 [unspecified-high]

Wave FINAL (After ALL — review, 4 parallel):
├── F1: Plan compliance audit [oracle]
├── F2: Data integrity review [unspecified-high]
├── F3: Reconciliation QA [unspecified-high]
└── F4: Scope fidelity check [deep]

Critical Path: A1 + C1 + C2 (parallel) → B2 → B3 → E1 → FINAL
Parallel Speedup: Wave 1 runs 10 tasks in parallel
Max Concurrent: 10 (Wave 1)
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| A1   | —         | B1, B2, B3 |
| A2   | —         | B3     |
| A3   | —         | —      |
| A4   | —         | E1     |
| A5   | —         | E1     |
| A6   | —         | —      |
| C1   | —         | C2, D1, B2, B3 (column indices) |
| C2   | C1        | B2, B3 (extractPlainName) |
| C3   | —         | —      |
| D1   | —         | B3     |
| B0   | Wave 1    | B1     |
| B1   | A1, B0    | B2     |
| B2   | A1, C1, C2 | B3    |
| B3   | A1, A2, C1, C2, D1 | E1 |
| E1   | B0-B3, A4, A5 | FINAL |
| F1-F4 | E1       | —      |

### Agent Dispatch Summary

- **Wave 1**: **10** — A1→`deep`, A2→`quick`, A3→`quick`, A4→`quick`, A5→`quick`, A6→`unspecified-high`, C1→`deep`, C2→`deep`, C3→`quick`, D1→`deep`
- **Wave 2**: **4** — B0→`quick`, B1→`unspecified-high`, B2→`unspecified-high`, B3→`deep`
- **Wave 3**: **1** — E1→`unspecified-high`
- **FINAL**: **4** — F1→`oracle`, F2→`unspecified-high`, F3→`unspecified-high`, F4→`deep`

---

## TODOs

- [ ] A1. Fix k2_3a Qualification Selection Flow ★ROOT CAUSE

  **What to do**:
  - Rewrite `selectQualificationInFrame()` (transcription.workflow.ts:1859-1908): current searches `name.includes('shikaku')` — never matches. New: find `input[name="searchKbn"]`, set value (1=看護師等, 2=准看護師, 3=理学療法士等), click 検索 button, wait for reload
  - Reorder k2_3a flow (lines 413-420): switchInsuranceType → **selectQualificationRadioAndSearch** → selectServiceCode
  - Remove/refactor selectQualificationCheckbox (lines 1808-1853)
  **Must NOT do**: keep old shikaku logic; skip 検索 click; modify switchInsuranceType; fix resolveKaigo (介護不修正)
  **Agent**: `deep` + `playwright` | Wave 1 | Blocks B1,B2,B3
  **Refs**: transcription.workflow.ts:1859-1908, :1808-1853, :413-420, ham-navigator.ts:419-447 (switchInsuranceType pattern), HAM HTML: `<input name="searchKbn" value="1" checked>`, `<input type="button" value="検索">`
  **QA**: Playwright→navigate k2_3a, select searchKbn=2, verify filtered list shows 准看護師 services. Evidence: .sisyphus/evidence/A1-junkangoshi-filter.png. tsc --noEmit pass.
  **Commit**: `fix(transcription): rewrite k2_3a qualification selection (searchKbn radio → 検索 → filtered results)`

- [ ] A2. Fix record2flag=1 Silent-Fail

  **What to do**: transcription.workflow.ts:1631-1634 — change `return false` to `throw new Error('record2flag=1')` when deletion blocked by 記録書II. `return false` only for "not found".
  **Agent**: `quick` | Wave 1 | Blocks B3
  **Refs**: transcription.workflow.ts:1591-1670
  **QA**: tsc --noEmit pass. Evidence: .sisyphus/evidence/A2-tsc.txt
  **Commit**: groups with A3

- [ ] A3. Fix Retry Duplicate Registration Bug

  **What to do**: Add `hamRegistrationComplete` flag in processRecord(). Set true after act_do (Step 8). In retry: if true, skip to updateTranscriptionStatus() only. Log warning.
  **Agent**: `quick` | Wave 1 | Blocks —
  **Refs**: transcription.workflow.ts:156-173 (withRetry), :~630-640 (updateTranscriptionStatus)
  **QA**: tsc --noEmit pass. Evidence: .sisyphus/evidence/A3-tsc.txt
  **Commit**: `fix(transcription): record2flag throw + retry duplicate guard`

- [ ] A4. Fix Reconciliation 超減算 Filter

  **What to do**: reconciliation.service.ts:~140 — add: `if (e.serviceContent.includes('超減算') || e.serviceContent.includes('月超')) return false;`
  **Agent**: `quick` | Wave 1 | Blocks E1
  **Refs**: reconciliation.service.ts:~140, reconciliation-report-202602-v2.txt:21-41 (15 超減算 records)
  **QA**: Run reconciliation, verify "extra" count drops from 20 to ~5. Evidence: .sisyphus/evidence/A4-filter.txt
  **Commit**: groups with A5

- [ ] A5. Fix Reconciliation SmartHR-Based Detection

  **What to do**: reconciliation.service.ts — replace CSV-based "准" detection with SmartHR qualification lookup. Add `setStaffQualifications(map)`. Update run-reconciliation.ts to fetch SmartHR before reconciliation. Implement 看護師>准看護師 priority rule.
  **Agent**: `quick` | Wave 1 | Blocks E1
  **Refs**: reconciliation.service.ts, run-reconciliation.ts, smarthr.service.ts:getAllCrews/getQualifications
  **QA**: Run reconciliation with SmartHR → verify 冨迫(123)+永松(89)=212 mismatches. Evidence: .sisyphus/evidence/A5-smarthr-recon.txt
  **Commit**: `fix(reconciliation): exclude 超減算 + SmartHR-based qualification detection`

- [ ] A6. Fix Deletion → Month Sheet Sync

  **What to do**: 
  - Add `deleteRowByRecordId(sheetId, tab, recordId)` to spreadsheet.service.ts using `deleteDimension` API (delete bottom-to-top)
  - In deletion.workflow.ts: after `updateDeletionStatus('削除済み')`, call deleteRowByRecordId to remove from month sheet
  - Create `src/scripts/cleanup-deleted-records.ts` for retroactive cleanup (ID121984 etc.)
  **Agent**: `unspecified-high` | Wave 1 | Blocks —
  **Refs**: deletion.workflow.ts:77-113, spreadsheet.service.ts (new method needed)
  **QA**: After cleanup, verify ID121984 no longer in 2026年03月 tab. Evidence: .sisyphus/evidence/A6-cleanup.txt
  **Commit**: `fix(deletion): auto-delete month sheet rows after HAM deletion`

- [ ] C1. Insert 加算対象の理由 Column + Update Indices

  **What to do**:
  - Create `src/scripts/update-sheet-columns.ts`: insert 1 column at index 18 (between R=緊急時事務員チェック and current S=転記フラグ) in ALL month tabs (`\d{4}年\d{2}月`). Set header "加算対象の理由".
  - Update spreadsheet.service.ts: add COL_Z=25, shift COL_S(18)→COL_T(19) through COL_Y(24)→COL_Z(25). Update range A2:Y→A2:Z.
  - Update spreadsheet.types.ts: add `surchargeReason` field, update comments for shifted fields.
  - Update ALL read/write methods: getTranscriptionRecords, updateTranscriptionStatus (S→T), writeDataFetchedAt (V→W), formatTranscriptionColumns (S→T, U→V).
  **Agent**: `deep` | Wave 1 | Blocks C2, D1, B2, B3
  **Refs**: spreadsheet.service.ts:6-11 (constants), :37-78 (getTranscriptionRecords), :80-105 (updateTranscriptionStatus), :107-115 (writeDataFetchedAt), :458-494 (formatTranscriptionColumns), spreadsheet.types.ts:1-54
  **QA**: Run update-sheet-columns.ts → verify headers: R=緊急時事務員チェック, S=加算対象の理由, T=転記フラグ. Read records → verify fields map correctly. tsc --noEmit + vitest run pass. Evidence: .sisyphus/evidence/C1-column-verify.txt
  **Commit**: groups with C2

- [ ] C2. Change E列 to "資格-姓名" Format + extractPlainName()

  **What to do**:
  - Add `extractPlainName()` to `src/core/cjk-normalize.ts`: strip "看護師-"/"准看護師-"/"理学療法士等-" prefix, return plain name. Use explicit list (not generic dash-split).
  - Apply at 4 locations in transcription.workflow.ts:
    1. Line 505 (HAM staff search): `normalizeCjkName(extractPlainName(record.staffName))`
    2. Line 1079 (pre-registration check): `normalizeCjkName(extractPlainName(staffName))`
    3. Line 1162 (I5 staff assignment): `normalizeCjkName(extractPlainName(record.staffName))`
    4. Line 1816 (qualification map lookup): `staffQualifications.get(extractPlainName(record.staffName))`
  - Add writeStaffNameWithQualification method to spreadsheet.service.ts
  - One-time batch update: in update-sheet-columns.ts, update ALL existing E列 to "資格-姓名" using SmartHR data
  **Must NOT do**: generic dash-split (names may contain dashes); overwrite E列 if qualification unknown
  **Agent**: `deep` | Wave 1 (depends C1) | Blocks B2, B3
  **Refs**: cjk-normalize.ts, transcription.workflow.ts:505,1079,1162,1816, spreadsheet.service.ts
  **QA**: Test extractPlainName("看護師-冨迫広美")==="冨迫広美", extractPlainName("冨迫広美")==="冨迫広美". Verify E列 shows "准看護師-冨迫広美" after batch update. tsc --noEmit pass. Evidence: .sisyphus/evidence/C2-extract-test.txt
  **Commit**: `feat(sheets): add 加算対象の理由 column + 資格-姓名 format + remap indices`

- [ ] C3. Add dxgroup@aozora-cg.com to Sheet Protection

  **What to do**: 
  - Add `addProtectionEditor(sheetId, email)` to spreadsheet.service.ts using Google Sheets API updateProtectedRange
  - Create `src/scripts/add-sheet-editor.ts`: find all protected ranges, add dxgroup@aozora-cg.com to editors
  **Must NOT do**: remove existing editors; change protection scope
  **Agent**: `quick` | Wave 1 | Blocks —
  **Refs**: spreadsheet.service.ts (new method), Google Sheets API protectedRanges
  **QA**: Run script, verify via API that dxgroup@aozora-cg.com appears in editors list. Evidence: .sisyphus/evidence/C3-protection.txt
  **Commit**: `feat(sheets): add dxgroup@aozora-cg.com to protection editors`

- [ ] D1. Build Qualification Correction Manifest Generator

  **What to do**:
  - Create `src/services/qualification-correction.service.ts`: parse 8-1 CSV (Shift-JIS), fetch SmartHR qualifications, cross-reference. **看護医療 records only** (filter `サービス種類==='看護医療'`). Check ・准 suffix in サービス内容.
  - **Qualification priority rule**: `const actual = hasKangoshi ? '看護師' : '准看護師'` (看護師 > 准看護師)
  - Generate manifest: `{ patientName, date, startTime, endTime, staffName, currentService, targetQualification }[]`
  - Create `src/scripts/run-qualification-correction.ts`: CLI with `--dry-run`, `--batch-size=50`, `--staff=name`
  - Execute mode: for each record: deleteExistingSchedule → processRecord with correct searchKbn. **50 records/batch + re-login between batches + checkpoint file for resume**
  - Group by patient to minimize HAM navigation
  **Must NOT do**: include 介護/予防 records; use reconciliation-report-v2; hardcode staff list
  **Agent**: `deep` + `playwright` | Wave 1 | Blocks B3
  **Refs**: check-all-staff-qualifications.ts (CSV+SmartHR pattern), transcription.workflow.ts:347-355 (delete+re-register flow), :1591-1670 (deleteExistingSchedule), smarthr.service.ts
  **QA**: dry-run → verify 212 corrections (冨迫123+永松89). Verify 有村愛 NOT listed. tsc --noEmit pass. Evidence: .sisyphus/evidence/D1-dryrun.txt
  **Commit**: `feat(correction): qualification correction manifest generator with SmartHR`

- [ ] B0. Check Sheet Current State

  **What to do**: Read 2026年02月 tab → count records where 転記フラグ(S列) is empty/error/修正あり (pending). Read 削除 tab → count records where M列 is not 削除済み/削除不要 (pending). Report counts.
  **Agent**: `quick` | Wave 2 (first) | Blocks B1
  **Refs**: spreadsheet.service.ts:getTranscriptionRecords, getDeletionRecords. Sheet ID: 12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M
  **QA**: Report output lists exact pending counts. Evidence: .sisyphus/evidence/B0-status.txt

- [ ] B1. Delete 4 Extra HAM Records

  **What to do**: Delete these from HAM:
  1. 窪田正浩 2026/02/06 17:30-17:59 川口千尋 (手動, sheet無)
  2. 窪田正浩 2026/02/08 16:20-16:49 川口千尋 (手動, sheet無)
  3. 生野由美子 2026/02/21 12:00-12:59 (手動, sheet無)
  4. 有田勉 2026/02/08 16:00-16:29 (重複2件中1件削除)
  Use deleteExistingSchedule(). Log all details before deletion.
  **Agent**: `unspecified-high` + `playwright` | Wave 2 | Blocks B2
  **Refs**: transcription.workflow.ts:1591-1670
  **QA**: Navigate to each patient in HAM, verify record deleted. Evidence: .sisyphus/evidence/B1-deletions.txt

- [ ] B2. Register 12 Missing Records in HAM

  **What to do**: Register these 12 records from sheet into HAM via existing transcription workflow:
  1. 窪田正浩 02-01 09:00 荒垣久美子 医療/通常
  2. 西之園喜美子 02-02 12:20 乾真子 介護/リハビリ
  3. 谷本久子 02-02 11:00 永森健大 介護/リハビリ
  4. 横山宜子 02-02 14:20 川原珠萌 介護/リハビリ
  5. 上枝眞由美 02-02 16:00 乾真子 介護/リハビリ
  6. 八汐征男 02-03 10:00 阪本大樹 介護/リハビリ
  7. 鎌田良弘 02-03 12:40 阪本大樹 介護/リハビリ
  8. 小濱泉 02-03 15:00 阪本大樹 介護/リハビリ
  9. 宇都ノブ子 02-04 15:00 大迫晋也 介護/リハビリ
  10. 窪田正浩 02-06 07:30 川口千尋 医療/通常
  11. 藤﨑公強 02-06 11:00 永森健大 介護/リハビリ
  12. 窪田正浩 02-08 06:20 川口千尋 医療/通常
  Pre-step: reset 転記フラグ to '' for any marked 転記済み.
  **Agent**: `unspecified-high` + `playwright` | Wave 2 | Blocks B3
  **Refs**: transcription.workflow.ts:63-75 (run method), spreadsheet.service.ts:updateTranscriptionStatus
  **QA**: After registration, download CSV, verify all 12 present. Evidence: .sisyphus/evidence/B2-missing-registered.txt

- [ ] B3. Execute 212 Qualification Corrections (Dry-run → Batched)

  **What to do**:
  Phase 1: `npx tsx run-qualification-correction.ts --dry-run` → verify 212 entries (冨迫123+永松89)
  Phase 2: Execute in batches of 50: `--batch-size=50 --batch=1` through `--batch=5`
  Each batch: login HAM → process 50 records (delete → re-register with correct searchKbn) → logout → verify batch
  Checkpoint: save progress to `tmp/correction-checkpoint.json` for resume
  **Must NOT do**: process 介護 records; skip dry-run; run all 212 in single session
  **Agent**: `deep` + `playwright` | Wave 2 (last, sequential) | Blocks E1
  **Refs**: run-qualification-correction.ts (created in D1), transcription.workflow.ts (delete+register flow)
  **QA**: After all batches, download fresh CSV → count 冨迫's records with ・准 = 123, 永松's = 89. Evidence: .sisyphus/evidence/B3-correction-complete.txt

- [ ] E1. Download Fresh CSV + Final Reconciliation v3

  **What to do**: Download new 8-1 CSV. Run `npx tsx run-reconciliation.ts --month=202602`. Save report as reconciliation-report-202602-v3.txt. Assert: 資格不一致=0, 転記漏れ=0, Extra≤15(超減算のみ).
  **Agent**: `unspecified-high` | Wave 3
  **Refs**: schedule-csv-downloader.service.ts, reconciliation.service.ts, run-reconciliation.ts
  **QA**: Report shows 0 mismatches, 0 missing. Evidence: .sisyphus/evidence/E1-recon-v3.txt
  **Commit**: `docs(reconciliation): post-correction verification report v3`

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Rejection → fix → re-run.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files exist. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Data Integrity Review** — `unspecified-high`
  Download fresh 8-1 CSV. For 冨迫広美 and 永松アケミ: count records with correct 准看護師 service content (・准). Verify total record count unchanged. Check for duplicates. Verify 12 missing records now present. Verify 4 extra records deleted.
  Output: `Staff [2/2 correct] | Records [N pre = N post] | Duplicates [0] | VERDICT`

- [ ] F3. **Reconciliation QA** — `unspecified-high`
  Run `npx tsx src/scripts/run-reconciliation.ts --month=202602`. Assert: qualification mismatches = 0, missing = 0. Save to `.sisyphus/evidence/final-qa/reconciliation-v3.txt`.
  Output: `Mismatches [0] | Missing [0] | Extra [N ≤ 15超減算] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read spec, read actual diff. Verify nothing beyond spec was built. Check "Must NOT do" compliance. Verify 介護 records were NOT touched.
  Output: `Tasks [N/N compliant] | 介護 [UNTOUCHED] | VERDICT`

---

## Commit Strategy

- **A1**: `fix(transcription): rewrite k2_3a qualification selection flow (searchKbn radio → 検索 → filtered results)`
- **A2+A3**: `fix(transcription): record2flag throw on blocked deletion + retry duplicate guard`
- **A4+A5**: `fix(reconciliation): exclude 超減算 records + SmartHR-based qualification detection`
- **A6**: `fix(deletion): auto-delete month sheet rows after HAM deletion`
- **C1+C2**: `feat(sheets): add 加算対象の理由 column + 資格-姓名 name format + remap column indices`
- **C3**: `feat(sheets): add dxgroup@aozora-cg.com to sheet protection editors`
- **D1**: `feat(correction): add qualification correction manifest generator with SmartHR`
- **B0-B3**: No commit (operational data execution)
- **E1**: `docs(reconciliation): add post-correction verification report v3`

---

## Success Criteria

### Verification Commands
```bash
npx tsc --noEmit                                                # Expected: Zero type errors
npx vitest run                                                  # Expected: All tests pass
npx tsx src/scripts/run-qualification-correction.ts --dry-run   # Expected: 212 corrections listed
npx tsx src/scripts/run-reconciliation.ts --month=202602        # Expected: 資格不一致: 0件, 転記漏れ: 0件
```

### Final Checklist
- [ ] 看護医療 212件の資格修正完了（冨迫123 + 永松89）
- [ ] 12件の漏登録がHAMに登録済み
- [ ] 4件のHAM不要記録が削除済み（窪田×2, 生野×1, 有田勉重複×1）
- [ ] 15件の超減算レコードは未削除（保持）
- [ ] 介護保険レコードは未修正（保持）
- [ ] k2_3a searchKbn資格選択が正常動作
- [ ] 加算対象の理由 column inserted at S(18)
- [ ] E列 displays "資格-姓名" format
- [ ] extractPlainName() applied at 4 locations
- [ ] dxgroup@aozora-cg.com added to sheet protection
- [ ] 削除Sheet連動で月Sheet行自動削除
- [ ] reconciliation 超減算フィルタ動作
- [ ] 資格優先度ルール: 看護師 > 准看護師 実装済み
- [ ] `npx tsc --noEmit` pass
- [ ] `npx vitest run` pass
