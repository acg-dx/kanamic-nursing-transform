---
phase: 01-reconciliation-core
verified: 2026-04-06T13:52:00Z
status: passed
score: 7/7 must-haves verified
re_verification: false
gaps: []
---

# Phase 1: 突合検証コア Verification Report

**Phase Goal:** 8-1 CSVダウンロード機能と5つの突合検証チェックが、既存ワークフローとは独立して動作する
**Verified:** 2026-04-06T13:52:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (from ROADMAP.md Success Criteria)

| #  | Truth                                                                                                                     | Status     | Evidence                                                                                      |
|----|---------------------------------------------------------------------------------------------------------------------------|------------|-----------------------------------------------------------------------------------------------|
| 1  | 転記と同一HAMセッション内で8-1 CSVをダウンロードでき、再認証は発生しない                                                  | ✓ VERIFIED | `downloadScheduleCsv()` reuses `this.auth` (KanamickAuthService); no new login call           |
| 2  | 未検証レコードの日付範囲を計算し、その範囲のCSVのみ取得する                                                               | ✓ VERIFIED | `computeVerificationDateRange()` exported; `startDay`/`endDay` wired to `startdateAttr2`/`enddateAttr2` selects |
| 3  | Sheets「転記済み」レコードのうちCSVに存在しないものを検出できる（REC-01）                                                 | ✓ VERIFIED | `verify()` sets `missingFromHam: true` for unmatched Sheets records                           |
| 4  | 訪問日・開始時刻・終了時刻の不一致、サービス種類・コードの不一致、スタッフ配置の不一致をそれぞれ個別に検出できる（REC-02, REC-03, REC-04） | ✓ VERIFIED | `checkTimeMismatch`, `checkServiceMismatch`, `checkStaffMismatch` all exported and called within `verify()` |
| 5  | HAMに存在するがSheetsにないレコード（extraInHam）を検出・一覧できる（REC-05）                                             | ✓ VERIFIED | `verify()` populates `extraInHam: ExtraInHamRecord[]` for unmatched HAM keys                  |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact                                                    | Expected                                    | Status     | Details                                                                      |
|-------------------------------------------------------------|---------------------------------------------|------------|------------------------------------------------------------------------------|
| `src/services/schedule-csv-downloader.service.ts`           | Extended CSV downloader with date range support | ✓ VERIFIED | Contains `VerificationDateRange`, `computeVerificationDateRange`, `startDay?`, `endDay?` |
| `src/services/schedule-csv-downloader.service.test.ts`      | Unit tests for date range computation       | ✓ VERIFIED | 6 `it()` blocks, all 6 tests pass                                            |
| `src/services/reconciliation.service.ts`                    | Extended reconciliation with `verify()` and `VerificationMismatch` | ✓ VERIFIED | Contains all 3 exported types + 3 helper functions + `async verify(` method  |
| `src/services/reconciliation.service.test.ts`               | Unit tests for field-level verification logic | ✓ VERIFIED | 19 `it()` blocks, all 19 tests pass                                           |

---

### Key Link Verification

| From                                                  | To                             | Via                                      | Status     | Details                                                                     |
|-------------------------------------------------------|--------------------------------|------------------------------------------|------------|-----------------------------------------------------------------------------|
| `schedule-csv-downloader.service.ts`                  | HAM 8-1 page date selects      | `startdateAttr2` / `enddateAttr2` params | ✓ WIRED    | Lines 199, 204: `nav.setSelectValue('startdateAttr2', actualStartDay, ...)` |
| `reconciliation.service.ts verify()`                  | `parseScheduleCsv()`           | internal method call                     | ✓ WIRED    | Lines 317, 473: `this.parseScheduleCsv(csvPath)`                            |
| `reconciliation.service.ts verify()`                  | `mergeRehabSegments()`         | internal method call (D-08)              | ✓ WIRED    | Lines 334, 482: `this.mergeRehabSegments(filteredEntries)`                  |
| `reconciliation.service.ts verify()`                  | `normalizeCjkName()`           | staff name comparison (D-05)             | ✓ WIRED    | Imported line 27; used in `checkStaffMismatch()` lines 255–256              |

---

### Data-Flow Trace (Level 4)

These are pure service functions without UI rendering; data flows through typed function return values rather than state variables. Not applicable as a component/rendering trace — logic verified via test outputs.

| Artifact                              | Data Variable      | Source                         | Produces Real Data | Status      |
|---------------------------------------|--------------------|--------------------------------|--------------------|-------------|
| `computeVerificationDateRange()`      | `ranges[]`         | Filters `TranscriptionRecord[]` | Yes (6 tests cover real computation) | ✓ FLOWING |
| `verify()` in ReconciliationService   | `mismatches`, `extraInHam` | `parseScheduleCsv()` → `hamMap` | Yes (real CSV parse + Map lookup) | ✓ FLOWING |

---

### Behavioral Spot-Checks

| Behavior                                         | Command                                                                                     | Result                          | Status  |
|--------------------------------------------------|---------------------------------------------------------------------------------------------|---------------------------------|---------|
| computeVerificationDateRange 6 tests pass        | `npx vitest run src/services/schedule-csv-downloader.service.test.ts`                       | 6/6 passed in 3ms               | ✓ PASS  |
| checkTimeMismatch/checkServiceMismatch/checkStaffMismatch 19 tests pass | `npx vitest run src/services/reconciliation.service.test.ts`              | 19/19 passed in 6ms             | ✓ PASS  |
| No TS errors in phase 1 files                    | `npx tsc --noEmit 2>&1 \| grep "reconciliation.service\|schedule-csv-downloader"` | No output (zero errors)         | ✓ PASS  |
| Existing `reconcile()` method preserved          | grep `async reconcile(` in reconciliation.service.ts                                        | Found at line 311 unchanged     | ✓ PASS  |

---

### Requirements Coverage

| Requirement | Source Plan  | Description                                                      | Status      | Evidence                                                                              |
|-------------|--------------|------------------------------------------------------------------|-------------|--------------------------------------------------------------------------------------|
| CSV-01      | 01-01-PLAN.md | 転記と同一HAMセッション内で8-1 CSVをダウンロードする              | ✓ SATISFIED | `downloadScheduleCsv()` uses `this.auth` (KanamickAuthService) — no new auth call    |
| CSV-02      | 01-01-PLAN.md | 未検証レコードの日付範囲に基づいてCSVダウンロード範囲を決定する   | ✓ SATISFIED | `computeVerificationDateRange()` + `startDay`/`endDay` in `ScheduleCsvDownloadOptions` |
| REC-01      | 01-02-PLAN.md | レコード存在性 — Sheets「転記済み」がHAM CSVに存在するか確認      | ✓ SATISFIED | `verify()` → `missingFromHam: true` for unmatched keys                               |
| REC-02      | 01-02-PLAN.md | 時間一致性 — 訪問日・開始時刻・終了時刻の一致を確認               | ✓ SATISFIED | `checkTimeMismatch()` with exact match (no tolerance), called in `verify()`          |
| REC-03      | 01-02-PLAN.md | サービス内容 — サービス種類・コードの一致を確認                    | ✓ SATISFIED | `checkServiceMismatch()` with kaigo/iryo classification, called in `verify()`        |
| REC-04      | 01-02-PLAN.md | スタッフ配置 — 配置スタッフの一致を確認                            | ✓ SATISFIED | `checkStaffMismatch()` with CJK normalization + qualification check, called in `verify()` |
| REC-05      | 01-02-PLAN.md | extraInHam検出 — HAMに存在するがSheetsにないレコードを検出         | ✓ SATISFIED | `verify()` → `extraInHam: ExtraInHamRecord[]` populated from unmatched `hamMap` keys |

All 7 phase 1 requirements are satisfied. No orphaned requirements found — REQUIREMENTS.md traceability table confirms CSV-01, CSV-02, REC-01 through REC-05 all mapped to Phase 1.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| None | — | — | — | — |

No TODO, FIXME, placeholder, empty returns, or stub indicators found in either modified file. Pre-existing TypeScript errors (in `premises-navigator.ts`, `delete-one.ts`, and several debug scripts) are unrelated to phase 1 and were present before this phase began — confirmed by SUMMARY noting "Pre-existing tsc errors from openai package".

---

### Human Verification Required

None. All phase 1 deliverables are pure service functions and unit-tested logic. No UI rendering, no external service integration requiring live credentials, and no real-time behavior to verify manually.

---

### Gaps Summary

No gaps. All 5 observable truths are verified, all 4 required artifacts exist and are substantive, all 4 key links are wired, all 7 requirement IDs are satisfied, and both test suites pass cleanly (6 + 19 = 25 total tests).

The phase goal is fully achieved: the 8-1 CSV download function and 5 reconciliation checks operate independently of the existing workflow, with no modifications to `reconcile()`, no changes to auth flow, and full backward compatibility on existing callers.

---

_Verified: 2026-04-06T13:52:00Z_
_Verifier: Claude (gsd-verifier)_
