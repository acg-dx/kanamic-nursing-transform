# Phase 1: 突合検証コア - Research

**Researched:** 2026-04-06
**Domain:** CSV download extension + reconciliation check logic (TypeScript/Playwright/Google Sheets)
**Confidence:** HIGH

## Summary

Phase 1 builds the core reconciliation engine by extending two existing services: `ScheduleCsvDownloaderService` (date-range CSV download) and `ReconciliationService` (5 field-level mismatch checks). The codebase already has a fully working reconciliation pipeline -- the existing `reconcile()` method handles existence checks (REC-01/REC-05) and qualification mismatches, but lacks time, service, and staff field-level comparisons. The reference script `run-full-reconciliation.ts` contains proven implementations of all 5 check types as standalone functions, providing a battle-tested blueprint for the service extension.

The CSV downloader currently only supports full-month downloads (day 1 to last day). It needs extension to accept arbitrary startDate/endDate parameters for downloading only the date range covering unverified records. The download mechanism (HAM 8-1 page navigation, `startdateAttr`/`enddateAttr` select values, `submitTargetFormForSlowCSV`) is well-understood and already proven in both the service and the reference script.

**Primary recommendation:** Extend `ReconciliationService.reconcile()` return type with per-record field-level mismatch details (time, service, staff), and extend `ScheduleCsvDownloaderService.downloadScheduleCsv()` to accept startDate/endDate parameters instead of only targetMonth.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** CSV download range determined by unverified records' date range. Extend ScheduleCsvDownloaderService with startDate/endDate parameters (currently month-only).
- **D-02:** CSV always force-redownloaded (no cache). Use force=true always for post-transcription freshness.
- **D-03:** Time matching is exact (start time and end time must match exactly). No tolerance.
- **D-04:** Service content compares both service type (kaigo/iryo) AND service code.
- **D-05:** Staff matching uses CJK-normalized name match + junkanngoshi/kangoshi qualification match.
- **D-06:** Mismatches aggregated per record. One object per record contains all mismatch fields (not type-segregated).
- **D-07:** Extend existing ReconciliationService (not a new service). Reuse parseScheduleCsv(), normalizeCjkName(), mergeRehabSegments().
- **D-08:** Rehab (I5) uses existing mergeRehabSegments() for consolidation before comparison. No segment count check.

### Claude's Discretion
- Error handling implementation (CSV download failure, Sheets read error, etc.)
- Verification result type field names and detailed structure design
- Test patient / monthly surcharge record filtering (follow existing patterns)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CSV-01 | Download 8-1 CSV within same HAM session as transcription | Existing `ScheduleCsvDownloaderService` uses `KanamickAuthService` which manages session; no re-auth needed when called in same session scope |
| CSV-02 | Determine CSV download range based on unverified records' dates | Extend `downloadScheduleCsv()` to accept startDate/endDate; compute min/max visitDate from unverified Sheets records |
| REC-01 | Record existence -- detect Sheets "transcribed" records missing from HAM CSV | Already implemented in `ReconciliationService.reconcile()` as `missingFromHam`; needs inclusion in new enriched result type |
| REC-02 | Time matching -- detect visit date, start time, end time mismatches | Pattern proven in `run-full-reconciliation.ts` line 387-412; must be exact match per D-03 |
| REC-03 | Service content -- detect service type/code mismatches | Pattern proven in `run-full-reconciliation.ts` `checkServiceMismatch()` function; compare serviceType1 + serviceType2 vs HAM serviceName + serviceContent |
| REC-04 | Staff assignment -- detect staff mismatches | Compare CJK-normalized staff names + qualification (jun-kangoshi) between Sheets and HAM |
| REC-05 | Extra in HAM -- detect records in HAM but not in Sheets | Already implemented in `ReconciliationService.reconcile()` as `extraInHam` |
</phase_requirements>

## Standard Stack

### Core (already in project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.7.0 | Type safety for mismatch result types | Project standard |
| Playwright | 1.50.0 | HAM browser automation for CSV download | Project standard |
| googleapis | 144.0.0 | Google Sheets API for reading transcription records | Project standard |
| Vitest | 4.0.18 | Unit testing for reconciliation logic | Project standard |

### Supporting (already in project)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| iconv-lite / TextDecoder('shift-jis') | built-in | CSV encoding | Parsing 8-1 CSV |
| Winston | 3.17.0 | Structured logging | All operations |
| tsx | 4.19.0 | Direct TS execution for scripts | Dev/testing |

**No new dependencies required.** This phase exclusively extends existing code.

## Architecture Patterns

### Files to Modify
```
src/
  services/
    schedule-csv-downloader.service.ts   # Extend: add startDate/endDate params
    reconciliation.service.ts            # Extend: add field-level mismatch checks, new result type
  types/
    spreadsheet.types.ts                 # (no changes needed -- TranscriptionRecord has all fields)
```

### Pattern 1: Date-Range CSV Download Extension
**What:** Extend `ScheduleCsvDownloaderService.downloadScheduleCsv()` to accept `startDate` and `endDate` (DD format) in addition to existing `targetMonth` (YYYYMM).
**When to use:** When downloading CSV for a specific date range within a month.

Current interface:
```typescript
interface ScheduleCsvDownloadOptions {
  targetMonth: string;  // YYYYMM
  downloadDir?: string;
  timeout?: number;
  force?: boolean;
}
```

Extended interface:
```typescript
interface ScheduleCsvDownloadOptions {
  targetMonth: string;  // YYYYMM
  startDay?: string;    // DD (default: '01')
  endDay?: string;      // DD (default: last day of month)
  downloadDir?: string;
  timeout?: number;
  force?: boolean;      // D-02: always true for verification
}
```

The HAM 8-1 page uses 3 select elements per date: `startdateAttr0` (year), `startdateAttr1` (month), `startdateAttr2` (day). The existing code already sets these -- the extension only needs to use `startDay`/`endDay` instead of hardcoded '01'/lastDay.

### Pattern 2: Enriched Reconciliation Result (Per-Record Mismatch Aggregation)
**What:** Extend `ReconciliationResult` with field-level mismatch details aggregated per record (D-06).
**When to use:** When the reconciliation engine returns results.

New type (to add alongside existing types in reconciliation.service.ts):
```typescript
/** Per-record verification result with field-level mismatch details */
interface VerificationMismatch {
  /** Sheets record for reference */
  recordId: string;
  patientName: string;
  visitDate: string;
  startTime: string;
  endTime: string;
  staffName: string;
  sheetsServiceType: string;  // serviceType1/serviceType2

  /** Field-level mismatches (D-06: all in one object) */
  missingFromHam: boolean;          // REC-01
  timeMismatch?: {                  // REC-02
    sheetsEndTime: string;
    hamEndTime: string;
  };
  serviceMismatch?: {               // REC-03
    sheetsServiceType1: string;
    sheetsServiceType2: string;
    hamServiceName: string;
    hamServiceContent: string;
    description: string;
  };
  staffMismatch?: {                 // REC-04
    sheetsStaffName: string;
    hamStaffName: string;
    qualificationIssue?: string;
  };
}
```

### Pattern 3: Match Key Construction
**What:** Reuse existing match key pattern: `normalizedPatientName|normalizedDate|normalizedStartTime`
**Source:** `ReconciliationService.makeMatchKey()` (line 581-585)

This is the canonical key used throughout the codebase for record matching. Do not change it.

### Pattern 4: Unverified Record Date Range Calculation
**What:** New helper to compute startDate/endDate from unverified Sheets records.
**When to use:** Before CSV download to determine the minimum download range.

```typescript
/** Calculate date range from unverified records */
function computeVerificationDateRange(
  records: TranscriptionRecord[]
): { startDay: string; endDay: string; targetMonth: string } | null {
  const unverified = records.filter(r =>
    r.transcriptionFlag === '転記済み'
    // Phase 2 will add: && !r.verificationTimestamp
  );
  if (unverified.length === 0) return null;

  // Find min/max visitDate
  const dates = unverified.map(r => r.visitDate).filter(Boolean).sort();
  // Extract day parts, expand to cover range
  // ...
}
```

### Anti-Patterns to Avoid
- **Creating a new VerificationService class:** D-07 explicitly requires extending ReconciliationService, not creating a new service.
- **Time tolerance in matching:** D-03 requires exact match. The reference script uses 1-minute tolerance (line 394) but the decision overrides this -- do NOT implement tolerance.
- **Type-segregated mismatch lists:** D-06 requires per-record aggregation. Do not create separate arrays for time mismatches, service mismatches, etc.
- **Caching CSV downloads:** D-02 requires force=true always. Do not add cache logic for verification downloads.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CSV parsing (Shift-JIS) | Custom parser | `ReconciliationService.parseScheduleCsv()` | Handles encoding, header detection, column mapping |
| CJK name normalization | Custom normalize | `normalizeCjkName()` from `cjk-normalize.ts` | Covers 80+ variant chars, NFKC, variation selectors |
| Rehab segment merging | Custom merge logic | `ReconciliationService.mergeRehabSegments()` | Proven logic for I5 20-min segments |
| HAM page navigation | Custom Playwright script | `ScheduleCsvDownloaderService` + `KanamickAuthService` | Session management, frame handling, form submission |
| Test patient filtering | Custom filter | Existing `TEST_PATIENT_PATTERNS` constant | Already defined and used consistently |
| Service type classification | Custom classification | Reference `checkServiceMismatch()` from run-full-reconciliation.ts | Proven classification of kaigo vs iryo service types |
| Staff name alias resolution | Custom lookup | `resolveStaffAlias()` + `STAFF_NAME_ALIASES` from cjk-normalize.ts | Handles known maiden-name changes |

**Key insight:** The entire reconciliation comparison logic exists in `run-full-reconciliation.ts` as proven standalone functions. The task is to migrate these patterns into the service class, not to invent new logic.

## Common Pitfalls

### Pitfall 1: End Time Off-By-One
**What goes wrong:** HAM records end time as "last minute" (e.g., 8:19) while Sheets records "end time" (e.g., 8:20), creating 1-minute discrepancies.
**Why it happens:** HAM's internal time representation differs from Sheets' human-entered times.
**How to avoid:** D-03 locks exact match. This means legitimate 1-minute differences will be flagged as mismatches. This is intentional per user decision -- do not add tolerance.
**Warning signs:** High false-positive rate in time mismatches during testing.

### Pitfall 2: Service Type Classification Complexity
**What goes wrong:** Service content in HAM uses Japanese text like "訪看Ⅰ１" (kaigo nursing) vs "訪問看護基本療養費" (medical therapy). Misclassifying kaigo vs iryo causes false mismatches.
**Why it happens:** HAM's service naming conventions are domain-specific and non-obvious.
**How to avoid:** Use the proven classification logic from `checkServiceMismatch()` in run-full-reconciliation.ts. Key rules:
- `訪看Ⅰ[１-５]` or `予訪看` = kaigo insurance
- `療養費` or `精神科` = medical insurance
- I5 rehab services should be skipped for service comparison (ambiguous insurance type)
**Warning signs:** Many service mismatches flagged for rehab or cross-insurance records.

### Pitfall 3: Multi-Staff Same-Key Records
**What goes wrong:** When multiple staff visit the same patient at the same time (legitimate multi-staff visit), the match key `patient|date|startTime` maps to multiple records on both sides.
**Why it happens:** Match key does not include staffName (by design, since staff names may differ between systems).
**How to avoid:** When multiple records share a key, match by additional fields (endTime, service type) to find the best pairing. The existing code uses `hamMap.get(key)` returning arrays for this reason.
**Warning signs:** Incorrect staff mismatch reports for multi-staff visits.

### Pitfall 4: CSV Date Range Spanning Multiple Months
**What goes wrong:** Unverified records may span month boundaries (e.g., records from both March 28 and April 2).
**Why it happens:** Verification may not run daily, accumulating cross-month records.
**How to avoid:** Group unverified records by YYYYMM and download separate CSVs per month. Each month requires its own HAM 8-1 download.
**Warning signs:** Records from different months mixed in a single CSV comparison.

### Pitfall 5: Staff Qualification Check Requires SmartHR Map
**What goes wrong:** Staff qualification comparison (jun-kangoshi vs kangoshi) fails silently when SmartHR qualification map is empty.
**Why it happens:** `setStaffQualifications()` may not be called before reconciliation in the standalone Phase 1 context.
**How to avoid:** When staffQualifications map is empty, fall back to CSV-based detection (check if serviceContent contains "准"). Log a warning when map is unavailable.
**Warning signs:** Zero qualification mismatches in results when SmartHR map not set.

### Pitfall 6: HAM Session Sharing
**What goes wrong:** CSV download fails because HAM session expired between transcription and verification.
**Why it happens:** Long transcription runs may exceed session timeout.
**How to avoid:** `KanamickAuthService.ensureLoggedIn()` auto-detects dead sessions and re-authenticates. The existing `navigateToMainMenu()` call in `downloadScheduleCsv()` triggers this check. No special handling needed.
**Warning signs:** Navigation errors or login page redirects during CSV download.

## Code Examples

### Example 1: Existing Service Mismatch Check (from run-full-reconciliation.ts)
```typescript
// Source: src/scripts/run-full-reconciliation.ts lines 521-549
function checkServiceMismatch(
  sheetsRecord: TranscriptionRecord,
  hamEntry: ScheduleEntry,
): string | null {
  const st1 = sheetsRecord.serviceType1;  // 医療, 介護, 精神医療
  const hamService = hamEntry.serviceContent;
  const hamType = hamEntry.serviceName;

  const sheetsIsMedical = st1 === '医療' || st1 === '精神医療';
  const sheetsIsKaigo = st1 === '介護';
  const hamIsKaigoHoukanService = /訪看Ⅰ[１-５]|予訪看/.test(hamService);
  const hamIsMedicalTherapy = hamService.includes('療養費') || hamService.includes('精神科');

  // I5 rehab -- ambiguous, skip
  if (hamService.includes('Ⅰ５') || hamService.includes('I5')) return null;
  // kaigo + kaigo-houkan = match
  if (sheetsIsKaigo && hamIsKaigoHoukanService) return null;
  // medical + medical-therapy = match
  if (sheetsIsMedical && hamIsMedicalTherapy) return null;
  // Cross-type mismatch
  if (sheetsIsMedical && hamIsKaigoHoukanService) {
    return `保険種類不一致: Sheets=${st1} だが HAM は介護保険サービス (${hamService})`;
  }
  // ... additional checks
}
```

### Example 2: HAM 8-1 Date Range Setting (from schedule-csv-downloader.service.ts)
```typescript
// Source: src/services/schedule-csv-downloader.service.ts lines 121-128
// These selects control the date range -- extension only needs to parameterize the day values
await nav.setSelectValue('startdateAttr0', year, mainFrame);   // Year
await nav.setSelectValue('startdateAttr1', month, mainFrame);  // Month
await nav.setSelectValue('startdateAttr2', '01', mainFrame);   // Day -- replace with startDay param
await nav.setSelectValue('enddateAttr0', year, mainFrame);
await nav.setSelectValue('enddateAttr1', month, mainFrame);
await nav.setSelectValue('enddateAttr2', String(lastDay), mainFrame);  // replace with endDay param
```

### Example 3: Existing Match Key Pattern
```typescript
// Source: src/services/reconciliation.service.ts lines 581-585
private makeMatchKey(patientName: string, visitDate: string, startTime: string): string {
  const normName = this.normalizeNameForKey(patientName);
  const normDate = this.normalizeDate(visitDate);
  const normTime = this.normalizeTime(startTime);
  return `${normName}|${normDate}|${normTime}`;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Monthly full-CSV reconciliation (script) | Date-range targeted verification (service) | Phase 1 | Faster verification, less data to download |
| Existence-only check in service | Field-level mismatch detection in service | Phase 1 | Catches time/service/staff errors |
| Separate mismatch type arrays | Per-record aggregated mismatches | Phase 1 (D-06) | Phase 3 auto-correction can act on single record |
| 1-minute time tolerance (script) | Exact time match (D-03) | Phase 1 | More strict, may increase flagged records |

## Open Questions

1. **Cross-month unverified records**
   - What we know: Records are stored per-month in Sheets (tab = "2026年03月"). Unverified records could span months.
   - What's unclear: Should we download CSVs for multiple months if unverified records span a month boundary?
   - Recommendation: Group by YYYYMM and download per month. Phase 2's workflow integration will handle the iteration.

2. **Staff matching granularity**
   - What we know: D-05 says "CJK-normalized name match + qualification match". The existing code compares staff via SmartHR map.
   - What's unclear: Should staff name comparison happen at the match-key level (which currently excludes staffName) or as a field-level check after matching by patient+date+startTime?
   - Recommendation: Staff is a field-level check (REC-04), not part of the match key. Match by patient+date+startTime first, then compare staff assignments between matched records.

3. **Verification timestamp column**
   - What we know: The CONTEXT.md mentions "verification timestamp is empty" as the unverified filter. The Sheets schema does not currently have a verification timestamp column.
   - What's unclear: Whether Phase 1 should add this column or leave it for Phase 2 (STS-01).
   - Recommendation: Phase 1 does NOT write to Sheets (status management is Phase 2). For Phase 1, "unverified" means `transcriptionFlag === '転記済み'` -- all transcribed records are verification targets. Phase 2 will add the timestamp column.

## Project Constraints (from CLAUDE.md)

- **Architecture**: Follow existing workflow/service layer patterns
- **HAM Session**: CSV download within same transcription session (no re-auth)
- **Performance**: Verification per office completes within 5-10 minutes additional time
- **Safety**: Auto-delete+re-transcribe only on confirmed mismatch (Phase 3, not Phase 1)
- **CSV Download**: HAM 8-1 screen, date-range CSV
- **Immutability**: Create new objects, never mutate existing ones
- **File size**: 200-400 lines typical, 800 max
- **Error handling**: Explicit try-catch at boundaries, use logger
- **Import style**: Use `import type` for TypeScript-only imports

## Sources

### Primary (HIGH confidence)
- `src/services/reconciliation.service.ts` -- existing reconcile() method, parseScheduleCsv(), mergeRehabSegments(), match key pattern
- `src/services/schedule-csv-downloader.service.ts` -- existing CSV download flow, HAM page navigation, date select handling
- `src/scripts/run-full-reconciliation.ts` -- proven field-level comparison logic (time, service, staff), MismatchDetail type, checkServiceMismatch()
- `src/types/spreadsheet.types.ts` -- TranscriptionRecord field definitions (all required fields present)
- `src/core/cjk-normalize.ts` -- normalizeCjkName(), resolveStaffAlias(), extractPlainName()

### Secondary (HIGH confidence)
- `src/services/spreadsheet.service.ts` -- getTranscriptionRecords() method, column layout documentation
- `.planning/phases/01-reconciliation-core/01-CONTEXT.md` -- locked decisions D-01 through D-08

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all existing libraries
- Architecture: HIGH -- extending existing services with proven patterns from reference script
- Pitfalls: HIGH -- identified from actual codebase patterns and domain knowledge in comments

**Research date:** 2026-04-06
**Valid until:** 2026-05-06 (stable -- internal project, no external dependency changes)
