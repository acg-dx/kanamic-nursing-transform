# Codebase Structure

**Analysis Date:** 2026-04-06

## Directory Layout

```
転記RPA/
├── src/                               # TypeScript source (compiled to dist/)
│   ├── index.ts                       # Main entry point: cron + CLI orchestration
│   ├── config/                        # Configuration management
│   │   ├── app.config.ts              # Location definitions, env var loading
│   │   └── selectors/                 # (Reserved for future selector configs)
│   ├── core/                          # Browser automation & infrastructure
│   │   ├── browser-manager.ts         # Playwright lifecycle, OOM detection
│   │   ├── ham-navigator.ts           # HAM form navigation (k1_1 → k2_3b chains)
│   │   ├── premises-navigator.ts      # TRITRUS 同一建物管理 navigation
│   │   ├── selector-engine.ts         # Static selector engine + fallback
│   │   ├── ai-healing-service.ts      # Claude API for dynamic selector finding
│   │   ├── cjk-normalize.ts           # Japanese character normalization
│   │   ├── ham-error-keywords.ts      # Page crash detection patterns
│   │   ├── retry-manager.ts           # Exponential backoff strategy
│   │   ├── logger.ts                  # Winston logger configuration
│   │   └── __tests__/                 # Core layer unit tests
│   ├── services/                      # Business logic & external integration
│   │   ├── spreadsheet.service.ts     # Google Sheets abstraction (1000+ lines)
│   │   ├── kanamick-auth.service.ts   # HAM/TRITRUS auth + session
│   │   ├── reconciliation.service.ts  # 8-1 CSV ↔ Sheets comparison
│   │   ├── building-data-extraction.service.ts  # Kintone + GH → building mgmt
│   │   ├── service-code-resolver.ts   # Service type → HAM code mapping
│   │   ├── patient-csv-downloader.service.ts    # HAM patient master download
│   │   ├── patient-master.service.ts  # CSV patient master parsing
│   │   ├── smarthr.service.ts         # SmartHR API staff lookup
│   │   ├── time-utils.ts              # HAM date/time conversions
│   │   ├── qualification-correction.service.ts  # Staff qualification matching
│   │   ├── notification.service.ts    # Email/webhook dispatch
│   │   ├── kintone.service.ts         # Kintone App 197 API
│   │   ├── gh-spreadsheet.service.ts  # GH facility data extraction
│   │   ├── schedule-csv-downloader.service.ts   # HAM 8-1 CSV download
│   │   └── __tests__/                 # Service layer unit tests
│   ├── workflows/                     # Domain-specific processing workflows
│   │   ├── base-workflow.ts           # Abstract base (timing infrastructure)
│   │   ├── transcription/
│   │   │   ├── transcription.workflow.ts  # HAM 実績転記 (14-step form sequence)
│   │   │   └── __tests__/
│   │   ├── deletion/
│   │   │   ├── deletion.workflow.ts    # HAM 実績削除
│   │   │   └── __tests__/
│   │   ├── building-management/
│   │   │   ├── building.workflow.ts    # TRITRUS 同一建物管理登録
│   │   │   └── __tests__/
│   │   ├── correction/
│   │   │   └── correction-sheet-sync.ts  # 修正管理 ↔ 月次シート同期
│   │   └── staff-sync/
│   │       └── staff-sync.workflow.ts    # SmartHR → HAM auto-register
│   ├── scripts/                       # One-off utilities & debugging
│   │   ├── run-building.ts            # Manual building mgmt data extraction
│   │   ├── run-staff-sync.ts          # Manual staff sync
│   │   ├── run-full-reconciliation.ts # Post-transcription reconciliation
│   │   ├── run-march-audit.ts         # Monthly audit report generation
│   │   └── [40+ debug/analysis scripts]  # Troubleshooting utilities
│   ├── types/                         # TypeScript interface definitions
│   │   ├── workflow.types.ts          # WorkflowContext, WorkflowResult
│   │   ├── spreadsheet.types.ts       # Record interfaces (Transcription, Deletion, Building)
│   │   ├── config.types.ts            # Configuration interfaces
│   │   ├── notification.types.ts      # Email/webhook payload structures
│   │   ├── smarthr.types.ts           # SmartHR API responses
│   │   └── [other domain types]
│   └── utils/                         # Shared utility modules
│       └── staff-csv-parser.ts        # Staff CSV parsing (SmartHR export)
├── dist/                              # Compiled JavaScript (gitignored, built by tsc)
├── downloads/                         # CSV downloads & audit reports
├── logs/                              # Application logs (daily rotation)
├── screenshots/                       # Test failure screenshots
├── docs/                              # Documentation & analysis
│   └── superpowers/                   # Architecture planning docs
├── package.json                       # Dependencies: playwright, node-cron, etc.
├── tsconfig.json                      # TypeScript compiler config
├── .env                               # (gitignored) Environment variables
├── .gitignore                         # Excludes node_modules, dist, .env, etc.
├── deploy.sh                          # Cloud Run deployment script
└── README.md                          # Project overview
```

## Directory Purposes

**src/ :**
- Purpose: TypeScript source code, compiled to dist/ and deployed
- Contains: Application logic organized by layer (core, services, workflows)
- Key files: `src/index.ts` (entry point), configuration, type definitions

**src/core/ :**
- Purpose: Browser automation infrastructure and error recovery
- Contains: Playwright wrapper, selector resolution, session management
- Key files:
  - `browser-manager.ts` (1000+ lines): Playwright lifecycle, memory monitoring
  - `ham-navigator.ts` (800+ lines): Multi-step form navigation chains
  - `premises-navigator.ts` (800+ lines): TRITRUS premises screen navigation

**src/services/ :**
- Purpose: Business logic, external API integration, data transformation
- Contains: Google Sheets abstraction, HAM/TRITRUS auth, CSV parsing, reconciliation
- Key files:
  - `spreadsheet.service.ts` (1000+ lines): Sheet I/O, row locking, column formatting
  - `kanamick-auth.service.ts` (600+ lines): Login, session persistence, page navigation
  - `reconciliation.service.ts` (600+ lines): 8-1 CSV parsing + Sheets comparison

**src/workflows/ :**
- Purpose: Domain-specific workflow execution
- Contains: Transcription, deletion, building management, staff sync, correction handling
- Key files:
  - `transcription/transcription.workflow.ts` (1000+ lines): Main record processing
  - `deletion/deletion.workflow.ts` (500+ lines): Record removal
  - `building-management/building.workflow.ts` (500+ lines): TRITRUS registration

**src/scripts/ :**
- Purpose: Development utilities, manual execution, post-processing
- Contains: Standalone scripts (no workflow wrappers)
- Execution: `npm run ts-node src/scripts/[name].ts`
- Examples:
  - `run-building.ts` - Extract building mgmt data only
  - `run-full-reconciliation.ts` - Post-transcription verification
  - `debug-*.ts` - Interactive debugging (login, selector testing)

**src/types/ :**
- Purpose: Shared TypeScript interfaces only
- Contains: No implementation, interface definitions only
- Pattern: One interface per concern (Workflow, Spreadsheet, Config, etc.)

**src/utils/ :**
- Purpose: Reusable utility modules
- Contains: CSV parsing, string normalization (shared across services)
- Example: `staff-csv-parser.ts` (SmartHR CSV → staff objects)

**dist/ :**
- Purpose: Compiled JavaScript (excluded from git)
- Generated by: `npm run build` (tsc)
- Deployed to: Cloud Run container

**downloads/ :**
- Purpose: Runtime CSV downloads and audit outputs
- Contains: 8-1 CSVs, patient master CSVs, reconciliation reports
- Cleanup: Manual (not automated yet)

**logs/ :**
- Purpose: Structured application logs
- Contains: Daily rolling logs with timestamp, level, context
- Output path: `./logs/` (configurable via LOG_DIR env var)

## Key File Locations

**Entry Points:**
- `src/index.ts` - Main cron + CLI orchestration (328 lines)
- `src/scripts/run-building.ts` - Manual building data extraction
- `src/scripts/run-staff-sync.ts` - Manual staff sync

**Configuration:**
- `src/config/app.config.ts` - Location definitions, env var loading
- `tsconfig.json` - TypeScript compilation settings
- `package.json` - Dependencies (playwright, node-cron, google-auth-library, etc.)

**Core Logic:**
- `src/workflows/transcription/transcription.workflow.ts` - Main transcription (1000+ lines)
- `src/services/spreadsheet.service.ts` - Sheets API abstraction (1000+ lines)
- `src/core/ham-navigator.ts` - HAM form navigation (800+ lines)

**Testing:**
- `src/core/__tests__/` - Core layer unit tests
- `src/services/__tests__/` - Service layer unit tests
- `src/workflows/transcription/__tests__/` - Workflow tests

## Naming Conventions

**Files:**
- Workflow files: `{domain}.workflow.ts` (e.g., `transcription.workflow.ts`)
- Service files: `{resource}.service.ts` (e.g., `spreadsheet.service.ts`)
- Utility files: `{function}.ts` (e.g., `time-utils.ts`)
- Navigator files: `{domain}-navigator.ts` (e.g., `ham-navigator.ts`)
- Type files: `{domain}.types.ts` (e.g., `workflow.types.ts`)
- Test files: `*.spec.ts` or `*.test.ts` (colocated with source)

**Directories:**
- Feature-based: `{domain}/` (transcription, deletion, building-management)
- Layer-based: `{layer}/` (core, services, workflows)
- Config-based: `{config}/selectors/` (future selector storage)

**TypeScript Classes & Exports:**
- Workflow classes: `{Domain}Workflow` (e.g., `TranscriptionWorkflow`)
- Service classes: `{Resource}Service` (e.g., `SpreadsheetService`)
- Navigator classes: `{Domain}Navigator` (e.g., `HamNavigator`)
- Interfaces: PascalCase (e.g., `WorkflowResult`, `TranscriptionRecord`)
- Types: Enum-like (e.g., `TranscriptionStatus = ''|'転記済み'|...`)

## Where to Add New Code

**New Feature (e.g., post-transcription verification):**
- Primary code: `src/workflows/verification/verification.workflow.ts`
- Tests: `src/workflows/verification/__tests__/verification.workflow.spec.ts`
- Service layer (if needed): `src/services/verification.service.ts`
- Entry point hook: Add to `src/index.ts` runDailyJob() or new cron schedule

**New Service Integration (e.g., new API):**
- Implementation: `src/services/{resource}.service.ts`
- Type definitions: Add interfaces to `src/types/{resource}.types.ts`
- Tests: `src/services/__tests__/{resource}.service.spec.ts`
- Usage: Import in workflow or another service

**New Navigation Chain (e.g., new HAM form):**
- Implementation: Add method to `src/core/ham-navigator.ts`
- Return type: `Promise<Frame>` for multi-step chains
- Pattern: Use existing `navigateTo*` methods as templates
- Error handling: Classify errors with HamNavigator.classifyError()

**Shared Utility (e.g., new normalization):**
- Implementation: `src/utils/{function}.ts`
- Export: Named export (not default)
- Tests: Colocated unit tests
- Usage: Import from anywhere

**Debugging Script (one-off troubleshooting):**
- Location: `src/scripts/{issue-name}.ts`
- Pattern: Standalone (no workflow wrapper)
- Execution: `npm run ts-node src/scripts/{issue-name}.ts [--args]`
- No git cleanup needed (scripts dir is active development)

## Special Directories

**src/__tests__/ (across layers) :**
- Purpose: Colocated unit tests
- Generated: No (hand-written)
- Committed: Yes
- Pattern: Vitest/Jest test suites for isolated functionality

**downloads/ :**
- Purpose: Runtime CSV/report artifacts
- Generated: Yes (by reconciliation, audit scripts)
- Committed: Partially (some tracked CSVs for reference, logs excluded)

**logs/ :**
- Purpose: Application runtime logs
- Generated: Yes (by Winston logger)
- Committed: No (.gitignore)
- Rotation: Daily rolling (configurable)

**.omc/ and .sisyphus/ :**
- Purpose: Internal Claude IDE state (analysis context, planning sessions)
- Generated: Yes (by IDE)
- Committed: No (.gitignore)

**dist/ :**
- Purpose: Compiled JavaScript output
- Generated: Yes (by TypeScript compiler)
- Committed: No (.gitignore)
- Built: `npm run build` (tsc)

## File Size Guidelines

**Target sizes:**
- `*workflow.ts`: 1000-1200 lines (TranscriptionWorkflow allowed due to 14-step complexity)
- `*service.ts`: 600-800 lines typical (SpreadsheetService allowed at 1000+ due to sheet abstraction)
- `*.ts` utilities: 200-400 lines
- `*navigator.ts`: 800-1000 lines (complex form state machines)

**Mitigation for large files:**
- Complex workflows: Extract error classification, record validation to services
- Services: Split by concern (e.g., separate `kintone.service.ts` and `gh-spreadsheet.service.ts`)
- Navigators: Extract state validators to separate functions

## Import Path Aliases

**Current setup:** None defined in tsconfig.json

**Future recommendation:** Add path aliases for cleaner imports
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@core/*": ["src/core/*"],
      "@services/*": ["src/services/*"],
      "@workflows/*": ["src/workflows/*"],
      "@types/*": ["src/types/*"]
    }
  }
}
```

Usage would become: `import { SpreadsheetService } from '@services/spreadsheet.service'`

## Integration Points for Post-Registration Verification

**Architectural fit:**
- New workflow module: `src/workflows/verification/verification.workflow.ts`
- Triggered: After each transcription (step 5 in transcription.workflow.ts processRecord)
- Or: Separate daily job (new cron entry in src/index.ts)

**Data dependencies:**
- Requires: hamAssignId from Sheets (stored in AA column after transcription)
- Queries: HAM k2_2 (月間スケジュール) for specific assignId
- Validates: Saved record matches submitted data (time, staff, service code)
- Reports: Pass/fail per record, aggregate counts

**Sheet integration:**
- New column: AB (Verification Status: blank | 検証完了 | 検証エラー)
- Stores: Verification timestamp, detail errors if any
- Locking: Records locked during verification (similar to transcription)

**Error classification:**
- Selector errors (retriable) → Use HamNavigator pattern
- Record mismatch (non-retryable) → Log detail, mark as verification failed
- Session errors (retriable) → auth.ensureLoggedIn()

**Fit within layers:**
- Core: Extend HamNavigator with `navigateToAssignIdVerification(assignId)` method
- Service: New VerificationService for rule validation (time match, staff match, code match)
- Workflow: New VerificationWorkflow orchestrating the verification loop

---

*Structure analysis: 2026-04-06*
