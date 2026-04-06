# Codebase Concerns

**Analysis Date:** 2026-04-06

## Critical Risk: Post-Transcription Verification Gap

**The Silent Danger:**
No automated post-registration verification occurs immediately after HAM transcription. The workflow saves data to Sheets (`転記フラグ='転記済み'`) at `src/workflows/transcription/transcription.workflow.ts:1352` BEFORE confirming the data actually persisted in HAM.

**Window of Risk:**
- HAM save button clicked (Step 12, line 1332)
- 3-second sleep only (line 1336)
- Basic error detection checks only for page UI elements (`「エラー」|「配置」|「全1」` matching, lines 1343-1345)
- Sheet immediately marked complete (line 1352) WITHOUT CSV verification
- Actual HAM database persistence unknown until next month's reconciliation audit

**What Can Go Wrong:**

1. **Silent Persistence Failure:** HAM save fails silently (out of memory, timeout, network hiccup) but page shows no visible error. Sheets says "転記済み" but HAM has nothing. Discovered 1-30 days later.

2. **Data Corruption in Transit:** Form submission successful, but HAM database transaction rolled back. Visible buttons present, no error page, yet no actual rows in 8-1 CSV. Detection: manual reconciliation audit only.

3. **Partial Registration:** Some fields saved, others not (e.g., assignId/staffName mismatch). Qualification mismatch undetected until reconciliation. High risk for staff assignment errors.

4. **Duplicate Silent Inserts:** HAM accepts form but creates duplicate entries (no unique constraint check pre-save). Only found when reconciliation detects "extra in HAM" rows.

5. **Race Condition on Staff Assignment:** Field marked disabled when clicked (I5 logic, line 2233), but concurrent staff updates cause: disabled button forcibly enabled → staff assignment succeeds → wrong staff record. Logging exists (line 2247) but no rollback.

**Current Post-Save Validation:**
- `checkForHamError(nav)` (line 756): Detects popup error pages only
- `checkForSyserror(nav)`: Detects server OOM/crash only
- HAM assignId stored (line 1356) but NOT verified against actual HAM content
- No immediate CSV query to confirm row was inserted

**Existing Scripts Prove This Is a Real Problem:**

45+ check/verify/fix scripts exist in `src/scripts/` — evidence of historical issues:

- `find-residuals-v2.ts` — Detects "旧登録残留" (old registrations left behind)
- `verify-duplicate-keys.ts` — Catches duplicate entries post-registration
- `recover-false-deletions.ts` — Recovers records incorrectly marked deleted
- `check-leaked-records.ts` — Finds records transcribed but not in HAM
- `verify-service-content.ts` — Validates service type accuracy
- `check-patient-master.ts` — Manual patient lookup after transcription
- `run-full-reconciliation.ts` — Month-end audit to find ALL mismatches
- `fix-ham-delete-and-retranscribe.ts` — Cleanup script for transcription errors

These scripts exist because post-transcription verification was deferred to manual audits.

---

## Tech Debt

### A. Monolithic Transcription Workflow

**Files:** `src/workflows/transcription/transcription.workflow.ts` (4,000+ lines after offset)

**Issue:** Single workflow handles all transcription modes:
- Basic care registration (14-step flow)
- I5 care+rehab (alternate 20+ step flow)
- Staff qualification resolution
- CJK name normalization and alias resolution
- Dynamic staff registration via SmartHR
- Frame navigation and error recovery

**Impact:**
- Cognitive overload — difficult to trace error paths
- Changes to staff validation affect care registration unexpectedly
- Testing single feature requires mocking entire flow
- 50+ branches and error conditions scattered across 4,000 lines

**Fix approach:** Extract concerns into smaller services:
- `TranscriptionStepOrchestrator` — coordinate steps 1-14
- `I5TranscriptionService` — handle I5-specific logic
- `StaffRegistrationValidator` — pre-check and auto-register staff
- Inject these into main workflow

### B. Unsafe Frame State Assumptions

**Files:** `src/core/ham-navigator.ts`, `src/workflows/transcription/transcription.workflow.ts`

**Issue:** Code assumes frame exists after navigation without defensive checks:

```typescript
// Line 1309: Assume k2_2 MainFrame exists
let k2_2MainFrame = nav.getMainFrame('k2_2');

// Line 1343: Assume saveContent reflects HAM state
const saveContent = await nav.getFrameContent('k2_2');
```

Browser can:
- Unload frame without warning (navigate away)
- Destroy execution context during long waits
- Return stale content from navigation race

**Impact:** Occasional `Execution context was destroyed` errors (line 336) cause blanket 3-minute retry loop, but underlying issue is frame assumption, not transient.

**Fix approach:**
- Wrapper method `ensureFrameAlive()` before every frame operation
- Frame identity check (compare `pageId`) before content access
- Timeout on frame operations set to 10s, not infinite waits

### C. Brittle CJK Name Normalization Chain

**Files:** `src/core/cjk-normalize.ts`, `src/workflows/transcription/transcription.workflow.ts:1968`

**Issue:** 5-step name matching with fallbacks creates silent mismatches:

1. Extract plain name (remove qualification prefix: "看護師-田中" → "田中")
2. Resolve alias (old name → new name: "木村" → "高山")
3. Normalize CJK variants (髙 → 高)
4. Remove spaces (full-width and half-width)
5. Query HAM staff list with normalized name

**Problem:** Each step can mask real names:
- Alias map is hardcoded (`STAFF_NAME_ALIASES`, line 26)
- If alias is wrong, staff never matches
- CJK variant map not exhaustive (check `CJK_VARIANT_MAP_SERIALIZABLE` at line 26)
- Space removal logic inconsistent across codebase (some use `/[\s\u3000]/g`, others not)

**Example Risk:**
- Alias: "木村利愛" → "高山利愛" is hardcoded
- If staff changes name to "高山" but ALIAS_MAP still routes "木村", old alias takes precedence
- Result: wrong staff selected, silent failure

**Impact:** Staff assignment errors, patient-staff pairings incorrect, undetectable until reconciliation.

**Fix approach:**
- SmartHR as source of truth for names, not hardcoded aliases
- Pre-transcription sync: fetch current names from SmartHR, build dynamic alias map
- Fallback to alias ONLY if direct match fails
- Audit logs for every name normalization decision

### D. Qualification Detection Fragile to Content Format

**Files:** `src/services/reconciliation.service.ts:16-18`, `src/workflows/transcription/transcription.workflow.ts:1073`

**Issue:** Qualification (看護師 vs 准看護師) detected by:
1. Search for "准" in service content (`serviceContent` col 12)
2. If found, mark staff as "准看護師"
3. If NOT found, assume "看護師"

**Problem:**
- Content format varies: "准看護師訪問看護" vs "訪問看護（准）" vs "准看護"
- Format controlled by HAM system, not our code
- If HAM changes format, detection fails silently
- Staff assigned wrong qualification → submitted as different jobtype (lines 1073-1075)

**Current Validation:** Only pre-save check — if jobtype selection fails, error thrown (line 1073). But if qualification detection was wrong, jobtype IS selected, just for wrong qualification.

**Impact:** Jun-qualified staff submitted as full nurses → HAM accepts but violates billing rules → regulatory/billing risk.

**Fix approach:**
- Qualification from SmartHR, not content inference
- Pre-transcription: validate staff's actual qualifications
- Service content validation separate from qualification resolution
- Reject if qualification cannot be confirmed from master data

### E. Concurrent Transcription Lacks Isolation

**Files:** `src/workflows/transcription/transcription.workflow.ts:94-91` (processLocation loop)

**Issue:** Multiple locations processed sequentially within single browser session, but `hamRegistrationState` (line 50) is shared:

```typescript
// Map: staffName → registered?
private hamRegistrationState = new Map<string, boolean>();

// Set once per location (line 1952)
const hamStaffNames = await this.fetchHamStaffNames(nav);

// Used for ALL records in location
```

**Problem:**
- Staff added to HAM during location 1 → cache says "registered"
- Location 2 uses same browser → cache still thinks staff is registered
- If concurrent external staff sync happens, cache stale
- Second location tries to register same staff → silent skip or duplicate

**Impact:** Duplicate staff registrations possible if two workflows run in parallel.

**Fix approach:**
- Make `hamRegistrationState` session-scoped, not workflow-scoped
- Clear cache between location transitions
- Query HAM for staff presence EVERY time, not cached
- Use transaction semantics if possible

---

## Known Bugs & Issues

### Bug 1: I5 Disabled Button Force-Enable

**Symptom:** Staff assignment succeeds with "forcedDisabled: true" log (line 2247)

**Files:** `src/workflows/transcription/transcription.workflow.ts:2229-2241`

**Trigger:** I5 flow encounters disabled "選択" button for target staff

**What Happens:**
1. Staff search finds match but button is disabled
2. Code DISABLES the disabled button (line 2233): `disabledBtn.disabled = false`
3. Then calls `choice()` function (line 2236)
4. Button becomes enabled in-memory but HAM form state may be inconsistent

**Risk:**
- HAM server state ≠ client state → subsequent validations fail
- Button disabled for reason (e.g., duplicate entry detection) — removing it bypasses that check
- I5 concurrent slot assignment succeeds but violates HAM business logic

**Observation:** Forced disable is logged but not prevented. This is a workaround, not a fix.

**Fix approach:** Don't force-enable disabled buttons. Instead:
- Check WHY button is disabled (inspect disabled attribute trigger in HAM form)
- If duplicate slot, find different time slot
- If qualification mismatch, fail with clear error
- Never bypass disabled state

### Bug 2: Mutation of missingStaff Array During Iteration

**File:** `src/workflows/transcription/transcription.workflow.ts:1989-2001`

**Code:**
```typescript
const empCodeOverrides = new Map<number, { staffName: string; staffNumber: string }>();
for (let i = 0; i < missingStaff.length; i++) {
  const staff = missingStaff[i];
  // ...
}
for (const [i, replacement] of empCodeOverrides) {
  missingStaff[i] = replacement; // Mutating array during use
}
```

**Issue:**
- `missingStaff` array is built, then elements mutated
- Later code uses array (e.g., line 2004: `missingStaff.map()`)
- If iteration happens during mutation, skips elements

**Impact:** Staff with emp_code overrides may be skipped from SmartHR query.

**Fix approach:** Immutable pattern — create new array instead of mutating in-place.

### Bug 3: Inconsistent Error Classification

**File:** `src/workflows/transcription/transcription.workflow.ts:396`

**Issue:**
```typescript
const { status, category, detail } = TranscriptionWorkflow.classifyError(err);
```

Method exists but classification logic not visible in provided lines. If classification is loose:
- "ページが見つかりません" mapped to same category as "メモリ不足"
- Retry logic (line 419) applies equally to recoverable vs permanent errors
- Resource exhaustion spins in retry loop instead of failing fast

**Impact:** Cascading failures consume browser resources, delay overall process.

**Fix approach:** Separate error categories: transient (retry), permanent (skip), critical (stop).

---

## Performance Bottlenecks

### Bottleneck 1: 3-Second Sleep After Every Save

**Files:** `src/workflows/transcription/transcription.workflow.ts:1336, 1407, etc`

**Pattern:**
```typescript
await saveBtnK2_2.click();
await this.sleep(3000); // Hard-coded wait
```

Appears 50+ times. Each transcription record incurs 3s+ wait.

**Impact:**
- 1000 records × 3s = 50+ minutes of pure waiting
- No adaptive timing based on actual DOM readiness
- Server might process save in 500ms, we still wait 3s

**Better approach:**
- `waitForNavigation()` with timeout
- DOM marker approach (already used at line 1396)
- Event-driven: wait for next enabled button, not clock

### Bottleneck 2: Frame Content Retrieved as Full String

**File:** `src/core/ham-navigator.ts` (implied by `getFrameContent()`)

**Issue:**
```typescript
const saveContent = await nav.getFrameContent('k2_2');
if (saveContent.includes('エラー') && ...) {
```

Pulls entire frame HTML, then string searches. If frame is 1MB, pulls all 1MB.

**Impact:**
- Network overhead for large pages
- String search is O(n) on page size
- Better to use DOM query: `document.querySelector('[class*=error]')` returns boolean

**Fix approach:**
- Replace `getFrameContent()` with targeted `evaluateInFrame()`
- Example: `frame.evaluate(() => document.body.classList.contains('error'))`

---

## Fragile Areas

### Area 1: Staff Synchronization Between SmartHR and HAM

**Files:**
- `src/workflows/transcription/transcription.workflow.ts:1947-2047`
- `src/workflows/staff-sync/staff-sync.workflow.ts` (not fully examined)

**Why Fragile:**

1. **Timing:** Staff added via SmartHR sync (StaffSyncWorkflow) but transcription workflow expects immediate visibility in HAM. If sync is async, race condition (line 1982-1985).

2. **Name Normalization:** Staff added to HAM with name "高山利愛" but Sheet has alias "木村利愛". Search in HAM via alias, not found. Fallback emp_code lookup works, but adds latency.

3. **Qualification Inconsistency:** SmartHR says "准看護師" but when submitted to HAM, jobtype selection might map to different value. SmartHR qualification ≠ HAM jobtype directly.

**Safe Modification:**
- Always sync staff BEFORE checking if registered
- Use emp_code as primary key, not name
- Validate SmartHR record fully before attempting HAM registration
- Test with known duplicate names in SmartHR data

**Test Coverage Gaps:**
- No test for race condition: staff added to SmartHR, transcription starts before sync completes
- No test for name variant: staff has multiple aliases in SmartHR
- No test for qualification mismatch: SmartHR says one thing, HAM expects another

### Area 2: HAM Page State Recovery After Errors

**Files:** `src/core/ham-navigator.ts`, `src/workflows/transcription/transcription.workflow.ts:307-373`

**Why Fragile:**

1. **Assumption:** If page crashes/OOM, 3-minute wait + retry will recover HAM state.

2. **Reality:** HAM form state may be corrupted. Navigation buttons work, but form values are stale or cleared:
   - Patient ID set but not persisted
   - Service code dropdown has wrong default
   - Staff list is from previous patient

3. **No Validation:** After recovery, assumes form is valid without re-checking prerequisites (line 335-373 is retry loop, but doesn't verify form state).

**Safe Modification:**
- After OOM recovery, re-verify prerequisites: patient ID present, correct form shown
- Use DOM signatures to validate state: `document.querySelector('input[name="careuserid"]').value` must match expected patient
- If state invalid, clear form and restart from k2_1

**Test Coverage Gap:**
- No test for simulated OOM during staff assignment → recovery → form state corruption

### Area 3: CSV-to-Sheets Reconciliation as Fallback Verification

**Files:** `src/services/reconciliation.service.ts`, `src/scripts/run-full-reconciliation.ts`

**Why Fragile:**

CSV download is manual (can fail, be partial), and reconciliation runs AFTER transcription:
- Monthly delay to discovery
- Tens/hundreds of residuals pile up
- Fix scripts are band-aids (`recover-false-deletions.ts`, `fix-ham-delete-and-retranscribe.ts`)

**Impact:**
- Late discovery costs (wrong data in production 30 days)
- Accumulated residuals hard to triage
- No real-time verification

**Better Approach:** Immediate post-transcription check (not this session, but next day):
- Query HAM 8-1 CSV for yesterday's date range
- Match against Sheets records marked "転記済み" yesterday
- Alert if mismatch found within 24 hours

---

## Security Considerations

### Risk 1: Hardcoded Staff Name Aliases

**Files:** `src/core/cjk-normalize.ts` (STAFF_NAME_ALIASES constant)

**Issue:**
- Staff name changes, old alias kept in code
- Anyone with code access can see historical staff names
- No audit log for alias changes

**Recommendation:**
- Load aliases from Google Sheets admin tab (not code)
- Version control: capture old aliases but mark deprecated
- Audit log: which code query used which alias

### Risk 2: HAM assignId Storage in Sheets

**Files:** `src/workflows/transcription/transcription.workflow.ts:1356` (writeHamAssignId)

**Issue:**
- assignId stored in column AA (not encrypted, plain text)
- Visible to anyone with Sheet read access
- assignId might be sensitive if it's internal HAM ID

**Recommendation:**
- Evaluate: is assignId sensitive? If yes, encrypt before storage or use separate secured table
- Access control: restrict AA column to API account only

### Risk 3: No Rate Limiting on Staff Registration

**Files:** `src/workflows/staff-sync/staff-sync.workflow.ts` (implied)

**Issue:**
- Staff auto-registration can loop indefinitely if missingStaff is large
- No throttle on SmartHR queries
- No throttle on TRITRUS/HAM form submissions

**Recommendation:**
- Implement backoff: if >N staff to register, split into batches
- Rate limit: max 10 staff registrations per minute
- Circuit breaker: if 5 consecutive registrations fail, stop and alert

---

## Missing Critical Features

### Feature 1: Real-Time Post-Registration Audit

**Problem:** No immediate verification that transcription actually persisted.

**Blocks:**
- Confidence in transcription completion
- Early error detection (currently 1-30 days delayed)
- Automated data quality gates

**What's Needed:**
```
After Step 13 (保存結果検証), before Step 14 (Sheet update):
  1. Query HAM 8-1 CSV for [patientName, visitDate, startTime, staffName]
  2. Match against record being transcribed
  3. If no match in CSV, throw error (don't mark complete)
  4. If match but fields differ (qualif, service, staff), alert and log discrepancy
```

**Effort:** Medium — CSV query logic exists in `ReconciliationService.parseScheduleCsv()`, just needs to be called post-save instead of post-month.

### Feature 2: Automatic Staff Name Alias Sync from SmartHR

**Problem:** Hardcoded aliases (`STAFF_NAME_ALIASES`) go stale when staff changes names.

**Blocks:**
- Self-service staff updates (HR can't add aliases without code change)
- Correct staff selection if name changed

**What's Needed:**
```
At workflow start:
  1. Query SmartHR for all employees
  2. For each employee, fetch historical names (if API provides)
  3. Build dynamic alias map: [oldName] → [currentName]
  4. Override hardcoded aliases with SmartHR data
  5. Log discrepancies (hardcoded alias differs from SmartHR truth)
```

**Effort:** Medium — SmartHR service exists, needs historical name query.

### Feature 3: Qualification Validation Before Transcription

**Problem:** Qualification (看護師 vs 准看護師) detected from service content, not master data.

**Blocks:**
- Prevents wrong jobtype submission
- Ensures billing compliance

**What's Needed:**
```
In ensureStaffRegistered() or new validateStaffQualifications():
  1. For each staff in transcription targets:
     - Query SmartHR for actual qualifications
     - Query Sheet service type
     - Check: is staff's actual qualification ≥ service requirement?
     - If not, BLOCK transcription with clear error
  2. Build staffQualifications map (already exists) from SmartHR, not hardcoded
```

**Effort:** Low — SmartHR qualifications service already in use, just needs earlier invocation.

---

## Test Coverage Gaps

### Gap 1: No E2E Test for Full Transcription + Verification

**What's Not Tested:**
- Happy path: record transcribed → verified in CSV within 1 hour
- Unhappy path: save fails silently → Sheets still marked complete → reconciliation catches it
- Mixed path: partial persistence (some fields saved, others not)

**Why It Matters:**
Post-transcription verification is the entire gap. Without E2E test, this gap won't be closed.

**Test Location:** `src/services/__tests__/` or new `src/workflows/__tests__/`

**Test Scenario:**
```typescript
it('transcription + immediate CSV audit should detect if HAM save failed silently', async () => {
  // 1. Simulate save succeeds (no JS error)
  // 2. But CSV query shows no new row
  // 3. Verify error thrown, not marked complete
});
```

**Effort:** High — requires test HAM environment or mock, but critical.

### Gap 2: No Test for Staff Name Normalization Edge Cases

**Untested Cases:**
- Staff with full-width spaces vs half-width: "田中　太郎" vs "田中 太郎"
- Staff with variant kanji: "髙山" (variant) vs "高山" (standard)
- Staff with qualification prefix removed inconsistently: "看護師-高山" in one field, "高山" in other

**Why It Matters:** Silent staff mismatch is common in this codebase (45 check scripts exist for this reason).

**Test Location:** `src/core/__tests__/cjk-normalize.test.ts`

**Effort:** Low — add 20-30 test cases to existing suite.

### Gap 3: No Test for Concurrent Transcription Race Conditions

**Untested Cases:**
- Location A transcription happening while StaffSync registers new staff
- Location B starting before Location A completes
- Sheet update race: two locations trying to update same staff row

**Why It Matters:** Multi-location workflows run sequentially now, but shared `hamRegistrationState` implies future concurrency is intended.

**Test Location:** `src/workflows/__tests__/transcription.concurrent.test.ts`

**Effort:** Medium — requires test concurrency setup.

---

## Scaling Limits

### Limit 1: Transcription Throughput (Records/Hour)

**Current:** ~10 records/hour (3s sleep × 14 steps + frame waits)

**Limit:** At 50 locations × 50 records/month = 2500 records, takes 250 hours (10+ days).

**Constraint:** HAM form navigation is inherently serial (single browser tab). No parallelization possible within system architecture.

**Scaling Path:**
- Increase browser concurrency: 1 browser → 5 browsers (5 concurrent tabs)
- Expected throughput: 50 records/hour
- Risk: Session state sharing, frame context confusion
- Mitigation: Separate browser instances per location, not tabs

### Limit 2: SmartHR API Rate Limiting

**Current:** Unknown, not documented

**Risk:** If staff auto-registration hits rate limit, workflow blocks.

**Scaling Path:**
- Implement backoff: exponential retry with jitter
- Batch API calls: fetch multiple employees at once
- Cache: store SmartHR data locally daily, use cache during transcription

### Limit 3: Google Sheets API Rate Limiting

**Current:** ~100 updates per minute allowed by Google

**Risk:** Multi-location transcription hits limit when updating Sheets status simultaneously.

**Scaling Path:**
- Batch Sheet updates: buffer 10-20 status updates, send once per minute
- Use Sheet API batch operations (batchUpdate instead of individual updates)

---

## Dependencies at Risk

### Risk 1: Playwright Version Compatibility

**File:** `package.json` — `"playwright": "^1.50.0"`

**Risk:**
- Each Playwright version changes API subtly (frame handling, selector engines, timeout behavior)
- HAM page selectors fragile → depend on exact Playwright version for DOM consistency

**Migration Plan:**
- Lock Playwright to exact version (1.50.0, not ^1.50.0)
- Maintain HAM selector library separately (e.g., `src/selectors/ham-selectors.ts`)
- When upgrading Playwright, re-test all selectors against actual HAM pages

### Risk 2: Gmail/Google Workspace API Dependency

**Risk:**
- Authentication key (`kangotenki.json`) is single point of failure
- If key revoked or rotated, entire system stops
- No fallback to alternate auth method

**Mitigation:**
- Maintain backup service account key
- Monitor key age (log warning at 90 days)
- Implement key rotation playbook (documented, tested annually)

---

## Summary Table

| Category | Issue | Severity | Fix Effort | Priority |
|----------|-------|----------|-----------|----------|
| Post-Registration Verification | No immediate audit after save | CRITICAL | Medium | 1 |
| Name Normalization | Hardcoded aliases go stale | HIGH | Medium | 2 |
| Qualification Handling | Inferred from content, not master | HIGH | Low | 3 |
| Monolithic Workflow | 4000+ line transcription.workflow.ts | MEDIUM | High | 4 |
| Frame State Assumptions | Unsafe navigation, race conditions | MEDIUM | Medium | 5 |
| I5 Disabled Button Workaround | Force-enable disabled buttons | MEDIUM | Low | 6 |
| Performance Sleeps | 3-second hard-coded waits | MEDIUM | Medium | 7 |
| Test Coverage | No E2E verification tests | HIGH | High | 8 |

---

*Concerns audit: 2026-04-06*
