# Architecture

**Analysis Date:** 2026-04-06

## Pattern Overview

**Overall:** Multi-stage RPA pipeline with separable workflow stages, using a hub-and-spoke pattern centered on Google Sheets as the source of truth and coordination layer.

**Key Characteristics:**
- Three parallel, independent workflows (Transcription → Deletion → Building Management)
- Workflow orchestration via cron + manual triggers
- Service-oriented data access (SpreadsheetService abstracts all sheet operations)
- Browser automation via Playwright with session persistence and error recovery
- Two distinct authentication domains: HAM (Kanamick)/TRITRUS (shared JOSSO)
- CSV import → validation → registration → verification → reporting pipeline

## Layers

**Presentation/Orchestration Layer:**
- Purpose: Workflow scheduling, entry points, user-facing execution
- Location: `src/index.ts`, `src/scripts/run-*.ts`
- Contains: Main cron scheduler, manual workflow runners, notification dispatch
- Depends on: All other layers
- Used by: CLI, Cloud Run jobs

**Workflow Layer:**
- Purpose: Domain-specific processing logic (transcription, deletion, building management)
- Location: `src/workflows/`
  - `transcription/transcription.workflow.ts` - HAM 実績転記（14-step form sequence)
  - `deletion/deletion.workflow.ts` - HAM 実績削除
  - `building-management/building.workflow.ts` - TRITRUS 同一建物管理登録
  - `base-workflow.ts` - Abstract base with timing infrastructure
  - `correction/correction-detection.ts` - Correction sync with monitoring sheet
  - `staff-sync/staff-sync.workflow.ts` - SmartHR → HAM staff auto-registration
- Contains: Multi-step HAM/TRITRUS navigation, record processing logic, error classification
- Depends on: Services, Core, Types
- Used by: Orchestration layer

**Service Layer:**
- Purpose: Cross-cutting concerns and external system integration
- Location: `src/services/`
- Key services:
  - `spreadsheet.service.ts` - Google Sheets abstraction (read/write all sheet data)
  - `kanamick-auth.service.ts` - HAM/TRITRUS login, session management, navigation to key pages
  - `reconciliation.service.ts` - 8-1 CSV ↔ Sheets comparison, mismatch detection, qual validation
  - `building-data-extraction.service.ts` - Kintone + GH sheet → building mgmt sheet ETL
  - `patient-csv-downloader.service.ts` - HAM 利用者マスタ CSV automated download
  - `smarthr.service.ts` - SmartHR API (staff lookup)
  - `service-code-resolver.ts` - Service code mapping (service type 1/2 → HAM codes)
  - `time-utils.ts` - HAM date/time conversions and calculations
  - `qualification-correction.service.ts` - Staff qualification matching
  - `patient-master.service.ts` - CSV patient master parsing
  - `notification.service.ts` - Email/webhook reporting
  - `kintone.service.ts` - Kintone API for facility data
  - `gh-spreadsheet.service.ts` - GH facility data extraction
  - `schedule-csv-downloader.service.ts` - HAM 8-1 CSV download
- Contains: API calls, data parsing, validation, transformation
- Depends on: Core, Types, Config
- Used by: Workflows

**Core Layer:**
- Purpose: Browser automation, error handling, selector resilience
- Location: `src/core/`
- Key components:
  - `browser-manager.ts` - Playwright browser lifecycle, memory management, crash detection
  - `ham-navigator.ts` - HAM form navigation (k1_1 → k2_3 chains, button clicks)
  - `premises-navigator.ts` - TRITRUS 同一建物管理 form navigation
  - `selector-engine.ts` - AI-powered selector resolution (fallback when static selectors fail)
  - `ai-healing-service.ts` - Claude API integration for dynamic element finding
  - `cjk-normalize.ts` - Japanese character normalization (異体字, CJK variants)
  - `ham-error-keywords.ts` - Page crash detection, dead page patterns
  - `retry-manager.ts` - Exponential backoff with jitter, non-retryable error classification
  - `logger.ts` - Structured logging
- Contains: Browser automation, error detection, recovery orchestration
- Depends on: Types, Playwright, external APIs
- Used by: Workflows, Services

**Data Access Layer:**
- Purpose: Spreadsheet operations abstraction
- Location: `src/services/spreadsheet.service.ts` (centralized)
- Contains: Row/column reading, writing, locking, status updates, record filtering
- Depends on: Google Sheets API
- Used by: All workflows and services

**Configuration Layer:**
- Purpose: Environment-based setup, location mapping
- Location: `src/config/app.config.ts`, `src/config/selectors/`
- Contains: Location definitions (4 nursing offices), credentials loading, selector definitions
- Depends on: Environment variables
- Used by: Orchestration layer

**Types Layer:**
- Purpose: Shared TypeScript interfaces
- Location: `src/types/`
  - `workflow.types.ts` - WorkflowContext, WorkflowResult, error types
  - `spreadsheet.types.ts` - Record interfaces (Transcription, Deletion, Building, Correction)
  - `config.types.ts` - Configuration interfaces
  - Other domain types (SmartHR, Notification, etc.)
- Contains: Interface definitions only
- Used by: All layers

## Data Flow

### HAM Registration → CSV → Reconciliation → Reporting (Main Pipeline)

**1. Pre-flight: Staff Registration & Validation**
- SmartHR service pulls current staff + qualifications
- StaffSyncService auto-registers missing staff in HAM
- TranscriptionWorkflow loads patient CSV (8-1 form download from HAM)
- Records marked as "未転記" are queued for processing

**2. Transcription Phase: Record Upload**
- For each queued record:
  - Workflow navigates: k1_1 (業務ガイド) → k2_1 (利用者検索)
  - Sets year/month, searches for patient
  - Navigates to k2_2 (月間スケジュール)
  - Adds schedule entry: k2_3 (時間設定) → k2_3a (保険種別) → k2_3b (決定)
  - Places staff: k2_2f (スタッフ配置)
  - Saves with emergency surcharge check if needed
  - Google Sheets status updated: "転記済み" + HAM assignId stored
- Data flow: Sheets (source) → Browser (HAM input) → HAM (registration) → Sheets (status update)

**3. Post-Transcription: Correction Detection**
- CorrectionSheetSync checks 修正管理 sheet for pending corrections
- For corrections marked "上書きOK":
  - Forces record flag to "修正あり" (override auto-unlock logic)
  - Record re-queued next run
  - After successful re-transcription, marks correction row "処理済み"

**4. Reconciliation Phase: 8-1 CSV Verification**
- Post-transcription, ReconciliationService compares:
  - Sheets "転記済み" records ↔ HAM 8-1 CSV export
  - Filters: test patients, monthly surcharges, merged rehab segments
  - Detects:
    - Sheets-only (never uploaded or deleted)
    - HAM-only (manual adds, duplicates)
    - Qualification mismatches (准看護師 vs 看護師)
  - Generates report with mismatch details
- Data flow: HAM (8-1 CSV) + Sheets (registered records) → Reconciliation analysis → Report

**5. Deletion Phase: Record Removal (Parallel to Transcription)**
- DeletionWorkflow processes "削除待ち" records from deletion sheet
- Similar 14-step navigation as transcription but calls delete button
- Updates status to "削除済み", stores result
- Deletes must match by patient+date+time+startTime

**6. Building Management Phase: Facility Registration (Monthly, Day 3)**
- BuildingDataExtractionService pulls:
  - Kintone App 197 (facility residents)
  - GH sheets (group home residents)
  - Facility definitions mapping (source name → Kanamick name)
- Filters: Only residents with nursing visits in transcription sheet
- Writes to building mgmt sheet with "新規" flag based on previous month comparison
- BuildingManagementWorkflow then registers these in TRITRUS premises screen
- Updates status "登録済み" when complete

**7. Reporting & Notification**
- NotificationService sends daily report via webhook
- Includes: Total processed, errors by category, duration, workflow status
- SmartHR staff sync results included if enabled

### State Management (Google Sheets as Coordinator)

**Monthly Sheet (e.g., "2026年02月"):**
- Source of truth for transcription state
- Columns: A-G patient data, H-R service details, S-Z processing metadata
  - S: 加算対象の理由 (surcharge reason)
  - T: 転記フラグ (transcription status)
  - U: マスタ修正フラグ (correction flag)
  - V: エラー詳細 (error details)
  - W: データ取得日時 (CSV fetch timestamp)
  - Z: 実績ロック (prevents re-processing)
  - AA: hamAssignId (HAM reference)
- Row locking prevents concurrent edits
- Cross-month navigation: Current month + "前月" check for pending unregistered

**Deletion Sheet:**
- Separate input sheet with similar structure (A-M columns)
- N column: Completion status (削除済み, 削除不要, or blank)
- Independent processing, no month navigation

**Building Mgmt Sheet:**
- Separate "連携シート" with monthly tabs (2026/02 format)
- Columns: Facility, Aozora ID, Name, Nursing Office, Move-in/out dates, Status, Notes
- Facility Definitions tab (施設定義): Source name → Kanamick mapping
- Status lifecycle: blank → 登録済み or エラー

**Correction Management Sheet (修正管理):**
- Driven by operators, parallel to monthly sheet
- Columns: Correction ID, Record ID, Patient, Date, Change detail, Status, Error log, Processed flag
- Ensures transient bugs get re-processed without manual re-entry

## Key Abstractions

**WorkflowResult:**
- Purpose: Standardized output for all three workflows
- Examples: `src/types/workflow.types.ts`
- Pattern: Success flag, record counts (total, processed, error), error array, duration
- Used by: Orchestration to aggregate reports, notifications

**TranscriptionRecord / DeletionRecord:**
- Purpose: Strongly-typed view of sheet rows
- Examples: `src/types/spreadsheet.types.ts`
- Pattern: Row index + 25+ named fields (A-Z columns)
- Used by: Workflows to avoid magic column indexing

**ScheduleEntry:**
- Purpose: Parsed 8-1 CSV row for reconciliation
- Examples: `src/services/reconciliation.service.ts`
- Pattern: Patient name, visit date, start/end time, staff, service content
- Used by: Reconciliation comparison logic

**HamNavigator & PremisesNavigator:**
- Purpose: Domain-specific navigation chains (state machine-like)
- Examples: `src/core/ham-navigator.ts`, `src/core/premises-navigator.ts`
- Pattern: Entry point method returns Frame/Page, chains via selectors
- Used by: Workflows for multi-step form traversal

**ServiceCodeResolver:**
- Purpose: Service type 1+2 combination → HAM service code mapping
- Examples: `src/services/service-code-resolver.ts`
- Pattern: Lookup table with error categorization
- Used by: TranscriptionWorkflow for k2_3a insurance/service selection

## Entry Points

**src/index.ts (main):**
- Location: `src/index.ts`
- Triggers:
  - Cron: `--workflow=transcription` (daily at 13:00)
  - Cron: `--workflow=building` (monthly day 3 at 06:00)
  - Manual: `npm start -- --workflow=transcription|deletion|building [--tab=YYYY年MM月]`
- Responsibilities:
  - Service initialization (browser, sheets, auth)
  - Workflow instantiation
  - Pre-flight checks (previous month unregistered)
  - Notification dispatch

**src/scripts/run-building.ts:**
- Location: `src/scripts/run-building.ts`
- Triggers: Manual script execution
- Responsibilities: Building mgmt data extraction only (not registration)

**src/scripts/run-staff-sync.ts:**
- Location: `src/scripts/run-staff-sync.ts`
- Triggers: Manual staff sync
- Responsibilities: SmartHR → HAM staff auto-register

## Error Handling

**Strategy:** Layered with non-retryable classification and circuit breaker pattern

**Patterns:**

**Selector Errors (retriable):**
- Static selector fails → AIHealingService attempts dynamic find via Claude
- Fallback chain: defined selector → AI find → CJK variant search
- Max 3 consecutive failures trigger circuit break

**Master Data Errors (non-retryable):**
- Staff not in HAM → Pre-flight check, mark record error immediately
- Unknown service code → Mark "エラー：マスタ不備", skip retries
- Patient not found → Skip (likely deleted from HAM)
- Qualification mismatch → Log warning, allow transcription but flag in reconciliation

**System Errors (retriable with backoff):**
- Page crash / 500 error → ensureLoggedIn() re-launches browser if needed
- Network timeout → Exponential backoff (3s base, 15s max, 2x multiplier)
- OOM → Sleep 10s + retry, if 3 consecutive OOM then circuit break
- Server busy → 10s * attempt wait before retry

**Correction Errors (partial):**
- Correction sheet marked "上書きOK" but HAM doesn't match → Log detail, don't mark "処理済み"
- Forces re-check next cycle

## Cross-Cutting Concerns

**Logging:**
- Infrastructure: Winston (configured in `src/core/logger.ts`)
- Pattern: JSON structured logs with timestamp, level, message, context
- Triggers: Workflow phase start/end, error classification, reconciliation details
- Output: stdout + `./logs/` directory

**Validation:**
- Input: TranscriptionRecord columns validated on sheet read (spreadsheet.service.ts)
- Transformation: Time parsing with toHamDate/toHamMonthStart (time-utils.ts)
- Master data: Patient CSV loaded into PatientMasterService before transcription
- Output: Reconciliation compares Sheets ↔ HAM 8-1 CSV row-by-row

**Authentication:**
- Infrastructure: KanamickAuthService (session persistence across requests)
- Pattern: Login once → reuse session → navigateToMainMenu/BusinessGuide chains
- Re-auth: ensureLoggedIn() detects dead sessions, re-authenticates transparently
- Two domains: JOSSO (shared for HAM + TRITRUS)

**Memory Management:**
- Browser: BrowserManager tracks tab lifecycle, detects OOM via error keywords
- Cleanup: Explicit browser.close() in finally blocks
- Monitoring: Memory dump logged every 20 records (logMemoryUsage)
- Graceful timeout: 85M ms (~23.6h) per workflow run to prevent Cloud Run task-timeout

**CJK Character Normalization:**
- Infrastructure: cjk-normalize.ts with variant map (異体字)
- Pattern: Staff name matching includes space removal + variant normalization
- Examples: "髙山 利愛" → "高山利愛" (髙→高)
- Used by: Staff lookup, reconciliation mismatch detection

---

*Architecture analysis: 2026-04-06*
