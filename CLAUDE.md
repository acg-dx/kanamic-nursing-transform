<!-- GSD:project-start source:PROJECT.md -->
## Project

**転記後自動検証システム (Post-Transcription Verification)**

HAM転記RPA（実績登録自動化システム）に転記後の自動検証ステップを追加する。転記完了後、8-1 CSVデータをダウンロードし、Google Sheetsの「転記済み」レコードと突合して、登録データの正確性を自動確認する。不一致があれば自動で削除・再転記を行う。

**Core Value:** 転記済みと記録されたすべてのレコードが、HAM上でも正確に登録されていることを保証する。

### Constraints

- **Architecture**: 既存のワークフロー・サービス層のパターンに準拠すること
- **HAM Session**: 転記と同一セッション内で8-1 CSVダウンロードを行う（再認証不要）
- **Performance**: 各事業所の検証は追加5-10分以内に完了すること
- **Safety**: 自動削除+再転記は、明確な不一致が確認された場合のみ実行
- **CSV Download**: HAM 8-1画面から当日日期範囲のCSVをダウンロード
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- TypeScript 5.7.0 - Core application logic, workflows, services, type safety
- JavaScript - Build output (CommonJS compiled from TypeScript)
- Shift-JIS Text Processing - CSV file parsing for HAM exports (patient master, schedule data 8-1)
## Runtime
- Node.js (target: ES2022, CommonJS module output)
- npm (package-lock.json present)
## Frameworks
- TypeScript 5.7.0 - Static type checking and transpilation to ES2022
- Vitest 4.0.18 - Test runner for unit and integration tests
- Playwright 1.50.0 - RPA automation for HAM (Kanamick) and TRITRUS portal navigation
- node-cron 3.0.3 - Scheduled daily transcription and monthly building management workflows
- Winston 3.17.0 - Structured logging and log file management
## Key Dependencies
- `googleapis` 144.0.0 - Google Sheets API v4 client for reading/writing transcription records
- `openai` 6.25.0 - OpenAI API client for AI-powered CSS selector repair
- `@anthropic-ai/sdk` 0.39.0 - Anthropic Claude API (optional/future expansion capability)
- `mysql2` 3.20.0 - MySQL client library for data queries
- `nodemailer` 6.9.16 - SMTP email client for notifications
- `iconv-lite` 0.7.2 - Character encoding converter (dev dependency)
- `tsx` 4.19.0 - TypeScript executor for running `.ts` scripts directly (dev dependency)
## Configuration
- `KANAMICK_URL` - TRITRUS portal base URL (required)
- `KANAMICK_USERNAME` - Portal login username (required)
- `KANAMICK_PASSWORD` - Portal login password (required)
- `KANAMICK_HAM_OFFICE_KEY` - HAM office selector key (optional, default: '6')
- `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` - Path to Google service account JSON (default: `./kangotenki.json`)
- `OPENAI_API_KEY` - OpenAI API key for AI healing (optional if not using AI-powered selector repair)
- `AI_HEALING_MODEL` - Model name for selector repair (default: `gpt-4o`)
- `AI_HEALING_MAX_ATTEMPTS` - Retry attempts for AI healing (default: `3`)
- `SMARTHR_ACCESS_TOKEN` - SmartHR API bearer token for staff qualifications (optional)
- `SMARTHR_BASE_URL` - SmartHR API base URL (default: `https://acg.smarthr.jp/api/v1`)
- `KINTONE_BASE_URL` - Kintone API base URL for resident data (optional)
- `KINTONE_APP_197_TOKEN` - API token for Kintone App 197 (居室利用変更履歴)
- `GH_SHEET_ID_KAGOSHIMA` - Google Sheets ID for shared living facilities (鹿児島) (optional)
- `GH_SHEET_ID_FUKUOKA` - Google Sheets ID for shared living facilities (福岡) (optional)
- `BUILDING_MGMT_SHEET_ID` - Google Sheets ID for building management (default: hardcoded ID)
- `RUN_LOCATIONS` - Comma-separated office names to run (optional, default: all 4 offices)
- `NOTIFICATION_WEBHOOK_URL` - Webhook URL for email notifications (optional)
- `NOTIFICATION_TO` - Comma-separated email addresses for daily reports (optional)
- `DRY_RUN` - Set to 'true' for dry-run mode (default: false)
- `LOG_LEVEL` - Logging level (default: `info`)
- `LOG_DIR` - Log file directory (default: `./logs`)
- `SCREENSHOT_DIR` - Screenshot storage for AI healing (default: `./screenshots`)
- Entry point: `src/config/app.config.ts`
- Loads via `dotenv` from `.env` file
- Multi-location support: 4 nursing stations with separate Google Sheets IDs
## Platform Requirements
- Node.js 18+ (for ES2022 features)
- TypeScript 5.7.0
- .env file with required credentials
- Google service account JSON key file
- Playwright system dependencies (browser binaries installed on first run)
- Node.js 18+
- Headless browser environment (Playwright with chromium)
- Network access to:
- Disk space for: CSV downloads (`./downloads`), logs (`./logs`), screenshots (`./screenshots`)
## Build & Execution
- `src/index.ts` - Main orchestrator for daily jobs and workflow selection
- `src/scripts/` - Standalone utility and debugging scripts (70+ helper scripts)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Naming Patterns
- Workflow files: kebab-case with `.workflow.ts` suffix (`transcription.workflow.ts`, `deletion.workflow.ts`)
- Service files: kebab-case with `.service.ts` suffix (`spreadsheet.service.ts`, `reconciliation.service.ts`)
- Type/interface files: kebab-case with `.types.ts` suffix (`spreadsheet.types.ts`, `config.types.ts`)
- Test files: match source file name with `.test.ts` suffix (`retry-manager.test.ts`, `cjk-normalize.test.ts`)
- Script files: kebab-case with `.ts` suffix in `src/scripts/` directory
- camelCase for all functions and methods
- Private methods prefixed with underscore: `_processLocation()`
- Async functions: no special prefix, just async keyword: `async downloadCsv()`
- Helper utilities at module level: simple names like `normDate()`, `normTime()`, `norm()`
- camelCase for local and module-level variables
- UPPER_SNAKE_CASE for constants: `const DOWNLOAD_DIR = ...`, `const TEST_PATIENTS = [...]`
- Temporary short-lived vars in scripts use compact names: `k`, `e`, `r` for keys/entries/records
- Map/Set variables clearly indicate data structure: `hamMap`, `sheetsMap`, `matchedHamKeys`
- PascalCase for all interfaces and types: `ScheduleEntry`, `TranscriptionRecord`, `AuditIssue`
- Suffix naming for discriminated types: `MismatchDetail`, `ReconciliationResult`, `QualificationMismatch`
- Use full English names in public APIs; Japanese comments explain domain concepts
## Code Style
- No explicit formatter configured (no .prettierrc)
- Indentation: 2 spaces (inferred from code)
- Line length: no hard limit enforced
- Semicolons: consistently used at end of statements
- Trailing commas: used in multiline arrays/objects
- TypeScript strict mode enabled: `"strict": true` in tsconfig.json
- ESLint configuration not detected in repo root
- Comments with `/* eslint-disable @typescript-eslint/no-explicit-any */` used for intentional type coercion (e.g., browser window globals)
## Import Organization
- No path aliases configured in tsconfig
- Relative imports throughout: `../core/logger`, `../../services/reconciliation.service`
- Imports from root: `src/config/app.config`, `src/types/spreadsheet.types`
- Always use `import type` for TypeScript-only imports: `import type { ScheduleEntry } from '../services/reconciliation.service'`
- Keeps module size smaller and indicates types vs. values clearly
## Error Handling
- Explicit try-catch blocks at boundaries: service methods, async workflows
- Error objects cast to `Error` type: `(error as Error).message`
- Logger used for all error reporting: `logger.error('...')`
- Workflow errors collected in array and accumulated: `const errors: WorkflowError[] = []`
- `withRetry()` helper in `src/core/retry-manager.ts` handles retry logic
- Accepts `isNonRetryable?: (error: Error) => boolean` callback
- Data validation errors are non-retryable; network errors are retryable
- Example from retry-manager: data issues skip retry and throw immediately
- Include context: `[${label}] error message` or `[${officeName}] description`
- Machine-readable error categories in audit scripts: severity levels ('ERROR', 'WARN', 'INFO')
- Detailed error objects with multiple fields for investigation: `{ category, severity, office, patientName, visitDate, ... }`
## Logging
- `logger.info()` - general progress messages
- `logger.warn()` - retries, non-critical issues
- `logger.debug()` - detailed diagnostic info
- `logger.error()` - exceptions and failures
- Log before and after major operations: "CSV DL: ..." then "CSV saved: ..."
- Include numeric counts: `logger.info(`[${officeName}] HAM: ${ham.length} (フィルタ後)`)`
- Log section breaks in reports: `logger.info('=' .repeat(70))`
- Error messages include context labels: `[${label}] attempt 1 failed`
## Comments
- Algorithm explanation for non-obvious logic (time diff calculation, rehab merging)
- Domain-specific concepts in Japanese: 介護 (care), 医療 (medical), 訪看 (visiting nurse)
- Block comments for major sections: `// ─── Types ───`, `// ─── Merge Rehab ───`
- JSDoc on public functions with parameters and return types
- Used on service class methods and exported functions
- Format: `/** Description */` single line, or multiline with `@param` and `@returns`
- Example from `spreadsheet.service.ts`: "実績ロック（Z列）を解除する（FALSE にクリア）"
- Using ASCII lines: `// ─── Helpers ───`, `// ─── Main Audit ───`, `// ─── Report ───`
- Helps organize large script files into logical chunks
- No formal grouping tool; convention-based only
## Function Design
- Most functions 20-50 lines
- Larger scripts decompose into 5-10 function chunks for readability
- Very long functions (100+ lines) exist but are organized with clear sections
- Explicit parameter lists, no object params for simple functions
- Configuration objects used for complex options: `RetryOptions` interface
- Spread operator not heavily used; explicit params preferred
- Single return type per function (no overloading)
- Use interfaces for complex returns: `AuditIssue[]`, `ReconciliationResult`
- Void for side-effect operations: `updateTranscriptionStatus()`
- Async functions wrap returns in `Promise<T>`
## Module Design
- Named exports preferred: `export interface ScheduleEntry { ... }`
- Single class export per service file: `export class SpreadsheetService { ... }`
- Barrel files exist (implied by imports from `src/types/`) but not explicitly defined
- Const helpers exported at module level: `export function normalizeCjkName() { ... }`
- None explicitly created; imports are direct from source files
- Types grouped in `src/types/` directory but no index.ts barrel files found
## Immutability Patterns
- Maps used to accumulate data: `new Map<string, ScheduleEntry[]>()`
- Objects spread with rest operator for updates: `{ ...sorted[0], endTime: sorted[sorted.length - 1].endTime }`
- Array concatenation with spread: `[...nonR, ...merged]`
- Filter operations create new arrays: `entries.filter(e => !isTest(e.patientName))`
- Function results always return new collections
- Example: `mergeRehab()` returns new array, doesn't mutate input
- Maps rebuilt fresh for each audit run, not reused
## Validation
- CSV file size validation: `if (size < 100) throw new Error(...)`
- Null/undefined checks on data: `if (!hamRecs || hamRecs.length === 0)`
- Boolean parsing: `parseBoolean(val)` handles multiple formats ('TRUE', '1', 'はい')
- Service content classification: `isKaigoService()`, `isIryoService()` guard conditions
- CJK name normalization for matching: `normalizeCjkName(name)` converts variants, old characters, whitespace
- Date format normalization: `normDate()` handles YYYYMMDD and YYYY-MM-DD formats
- Time format normalization: `normTime()` standardizes to HH:MM format
## Key Architectural Patterns
- Services handle data access and transformation
- Workflows handle orchestration and state management
- Cross-cutting concerns (logging, retry) in core modules
- Strict mode enabled throughout
- Explicit type annotations on function params and returns
- Interface-based contracts between modules
- Type imports for non-runtime references
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## Pattern Overview
- Three parallel, independent workflows (Transcription → Deletion → Building Management)
- Workflow orchestration via cron + manual triggers
- Service-oriented data access (SpreadsheetService abstracts all sheet operations)
- Browser automation via Playwright with session persistence and error recovery
- Two distinct authentication domains: HAM (Kanamick)/TRITRUS (shared JOSSO)
- CSV import → validation → registration → verification → reporting pipeline
## Layers
- Purpose: Workflow scheduling, entry points, user-facing execution
- Location: `src/index.ts`, `src/scripts/run-*.ts`
- Contains: Main cron scheduler, manual workflow runners, notification dispatch
- Depends on: All other layers
- Used by: CLI, Cloud Run jobs
- Purpose: Domain-specific processing logic (transcription, deletion, building management)
- Location: `src/workflows/`
- Contains: Multi-step HAM/TRITRUS navigation, record processing logic, error classification
- Depends on: Services, Core, Types
- Used by: Orchestration layer
- Purpose: Cross-cutting concerns and external system integration
- Location: `src/services/`
- Key services:
- Contains: API calls, data parsing, validation, transformation
- Depends on: Core, Types, Config
- Used by: Workflows
- Purpose: Browser automation, error handling, selector resilience
- Location: `src/core/`
- Key components:
- Contains: Browser automation, error detection, recovery orchestration
- Depends on: Types, Playwright, external APIs
- Used by: Workflows, Services
- Purpose: Spreadsheet operations abstraction
- Location: `src/services/spreadsheet.service.ts` (centralized)
- Contains: Row/column reading, writing, locking, status updates, record filtering
- Depends on: Google Sheets API
- Used by: All workflows and services
- Purpose: Environment-based setup, location mapping
- Location: `src/config/app.config.ts`, `src/config/selectors/`
- Contains: Location definitions (4 nursing offices), credentials loading, selector definitions
- Depends on: Environment variables
- Used by: Orchestration layer
- Purpose: Shared TypeScript interfaces
- Location: `src/types/`
- Contains: Interface definitions only
- Used by: All layers
## Data Flow
### HAM Registration → CSV → Reconciliation → Reporting (Main Pipeline)
- SmartHR service pulls current staff + qualifications
- StaffSyncService auto-registers missing staff in HAM
- TranscriptionWorkflow loads patient CSV (8-1 form download from HAM)
- Records marked as "未転記" are queued for processing
- For each queued record:
- Data flow: Sheets (source) → Browser (HAM input) → HAM (registration) → Sheets (status update)
- CorrectionSheetSync checks 修正管理 sheet for pending corrections
- For corrections marked "上書きOK":
- Post-transcription, ReconciliationService compares:
- Data flow: HAM (8-1 CSV) + Sheets (registered records) → Reconciliation analysis → Report
- DeletionWorkflow processes "削除待ち" records from deletion sheet
- Similar 14-step navigation as transcription but calls delete button
- Updates status to "削除済み", stores result
- Deletes must match by patient+date+time+startTime
- BuildingDataExtractionService pulls:
- Filters: Only residents with nursing visits in transcription sheet
- Writes to building mgmt sheet with "新規" flag based on previous month comparison
- BuildingManagementWorkflow then registers these in TRITRUS premises screen
- Updates status "登録済み" when complete
- NotificationService sends daily report via webhook
- Includes: Total processed, errors by category, duration, workflow status
- SmartHR staff sync results included if enabled
### State Management (Google Sheets as Coordinator)
- Source of truth for transcription state
- Columns: A-G patient data, H-R service details, S-Z processing metadata
- Row locking prevents concurrent edits
- Cross-month navigation: Current month + "前月" check for pending unregistered
- Separate input sheet with similar structure (A-M columns)
- N column: Completion status (削除済み, 削除不要, or blank)
- Independent processing, no month navigation
- Separate "連携シート" with monthly tabs (2026/02 format)
- Columns: Facility, Aozora ID, Name, Nursing Office, Move-in/out dates, Status, Notes
- Facility Definitions tab (施設定義): Source name → Kanamick mapping
- Status lifecycle: blank → 登録済み or エラー
- Driven by operators, parallel to monthly sheet
- Columns: Correction ID, Record ID, Patient, Date, Change detail, Status, Error log, Processed flag
- Ensures transient bugs get re-processed without manual re-entry
## Key Abstractions
- Purpose: Standardized output for all three workflows
- Examples: `src/types/workflow.types.ts`
- Pattern: Success flag, record counts (total, processed, error), error array, duration
- Used by: Orchestration to aggregate reports, notifications
- Purpose: Strongly-typed view of sheet rows
- Examples: `src/types/spreadsheet.types.ts`
- Pattern: Row index + 25+ named fields (A-Z columns)
- Used by: Workflows to avoid magic column indexing
- Purpose: Parsed 8-1 CSV row for reconciliation
- Examples: `src/services/reconciliation.service.ts`
- Pattern: Patient name, visit date, start/end time, staff, service content
- Used by: Reconciliation comparison logic
- Purpose: Domain-specific navigation chains (state machine-like)
- Examples: `src/core/ham-navigator.ts`, `src/core/premises-navigator.ts`
- Pattern: Entry point method returns Frame/Page, chains via selectors
- Used by: Workflows for multi-step form traversal
- Purpose: Service type 1+2 combination → HAM service code mapping
- Examples: `src/services/service-code-resolver.ts`
- Pattern: Lookup table with error categorization
- Used by: TranscriptionWorkflow for k2_3a insurance/service selection
## Entry Points
- Location: `src/index.ts`
- Triggers:
- Responsibilities:
- Location: `src/scripts/run-building.ts`
- Triggers: Manual script execution
- Responsibilities: Building mgmt data extraction only (not registration)
- Location: `src/scripts/run-staff-sync.ts`
- Triggers: Manual staff sync
- Responsibilities: SmartHR → HAM staff auto-register
## Error Handling
- Static selector fails → AIHealingService attempts dynamic find via Claude
- Fallback chain: defined selector → AI find → CJK variant search
- Max 3 consecutive failures trigger circuit break
- Staff not in HAM → Pre-flight check, mark record error immediately
- Unknown service code → Mark "エラー：マスタ不備", skip retries
- Patient not found → Skip (likely deleted from HAM)
- Qualification mismatch → Log warning, allow transcription but flag in reconciliation
- Page crash / 500 error → ensureLoggedIn() re-launches browser if needed
- Network timeout → Exponential backoff (3s base, 15s max, 2x multiplier)
- OOM → Sleep 10s + retry, if 3 consecutive OOM then circuit break
- Server busy → 10s * attempt wait before retry
- Correction sheet marked "上書きOK" but HAM doesn't match → Log detail, don't mark "処理済み"
- Forces re-check next cycle
## Cross-Cutting Concerns
- Infrastructure: Winston (configured in `src/core/logger.ts`)
- Pattern: JSON structured logs with timestamp, level, message, context
- Triggers: Workflow phase start/end, error classification, reconciliation details
- Output: stdout + `./logs/` directory
- Input: TranscriptionRecord columns validated on sheet read (spreadsheet.service.ts)
- Transformation: Time parsing with toHamDate/toHamMonthStart (time-utils.ts)
- Master data: Patient CSV loaded into PatientMasterService before transcription
- Output: Reconciliation compares Sheets ↔ HAM 8-1 CSV row-by-row
- Infrastructure: KanamickAuthService (session persistence across requests)
- Pattern: Login once → reuse session → navigateToMainMenu/BusinessGuide chains
- Re-auth: ensureLoggedIn() detects dead sessions, re-authenticates transparently
- Two domains: JOSSO (shared for HAM + TRITRUS)
- Browser: BrowserManager tracks tab lifecycle, detects OOM via error keywords
- Cleanup: Explicit browser.close() in finally blocks
- Monitoring: Memory dump logged every 20 records (logMemoryUsage)
- Graceful timeout: 85M ms (~23.6h) per workflow run to prevent Cloud Run task-timeout
- Infrastructure: cjk-normalize.ts with variant map (異体字)
- Pattern: Staff name matching includes space removal + variant normalization
- Examples: "髙山 利愛" → "高山利愛" (髙→高)
- Used by: Staff lookup, reconciliation mismatch detection
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
