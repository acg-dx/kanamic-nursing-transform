# Coding Conventions

**Analysis Date:** 2026-04-06

## Naming Patterns

**Files:**
- Workflow files: kebab-case with `.workflow.ts` suffix (`transcription.workflow.ts`, `deletion.workflow.ts`)
- Service files: kebab-case with `.service.ts` suffix (`spreadsheet.service.ts`, `reconciliation.service.ts`)
- Type/interface files: kebab-case with `.types.ts` suffix (`spreadsheet.types.ts`, `config.types.ts`)
- Test files: match source file name with `.test.ts` suffix (`retry-manager.test.ts`, `cjk-normalize.test.ts`)
- Script files: kebab-case with `.ts` suffix in `src/scripts/` directory

**Functions:**
- camelCase for all functions and methods
- Private methods prefixed with underscore: `_processLocation()`
- Async functions: no special prefix, just async keyword: `async downloadCsv()`
- Helper utilities at module level: simple names like `normDate()`, `normTime()`, `norm()`

**Variables:**
- camelCase for local and module-level variables
- UPPER_SNAKE_CASE for constants: `const DOWNLOAD_DIR = ...`, `const TEST_PATIENTS = [...]`
- Temporary short-lived vars in scripts use compact names: `k`, `e`, `r` for keys/entries/records
- Map/Set variables clearly indicate data structure: `hamMap`, `sheetsMap`, `matchedHamKeys`

**Types and Interfaces:**
- PascalCase for all interfaces and types: `ScheduleEntry`, `TranscriptionRecord`, `AuditIssue`
- Suffix naming for discriminated types: `MismatchDetail`, `ReconciliationResult`, `QualificationMismatch`
- Use full English names in public APIs; Japanese comments explain domain concepts

## Code Style

**Formatting:**
- No explicit formatter configured (no .prettierrc)
- Indentation: 2 spaces (inferred from code)
- Line length: no hard limit enforced
- Semicolons: consistently used at end of statements
- Trailing commas: used in multiline arrays/objects

**Linting:**
- TypeScript strict mode enabled: `"strict": true` in tsconfig.json
- ESLint configuration not detected in repo root
- Comments with `/* eslint-disable @typescript-eslint/no-explicit-any */` used for intentional type coercion (e.g., browser window globals)

## Import Organization

**Order:**
1. External dependencies (dotenv, path, fs)
2. Internal core modules (logger, config, browser-manager)
3. Services (spreadsheet.service, kanamick-auth.service)
4. Utilities (normalization helpers, time utils)
5. Type imports: `import type { ... }`
6. Vitest imports in tests: `import { describe, it, expect, vi, beforeEach } from 'vitest'`

**Path Aliases:**
- No path aliases configured in tsconfig
- Relative imports throughout: `../core/logger`, `../../services/reconciliation.service`
- Imports from root: `src/config/app.config`, `src/types/spreadsheet.types`

**Type Imports:**
- Always use `import type` for TypeScript-only imports: `import type { ScheduleEntry } from '../services/reconciliation.service'`
- Keeps module size smaller and indicates types vs. values clearly

## Error Handling

**Patterns:**
- Explicit try-catch blocks at boundaries: service methods, async workflows
- Error objects cast to `Error` type: `(error as Error).message`
- Logger used for all error reporting: `logger.error('...')`
- Workflow errors collected in array and accumulated: `const errors: WorkflowError[] = []`

**Non-retryable vs. Retryable:**
- `withRetry()` helper in `src/core/retry-manager.ts` handles retry logic
- Accepts `isNonRetryable?: (error: Error) => boolean` callback
- Data validation errors are non-retryable; network errors are retryable
- Example from retry-manager: data issues skip retry and throw immediately

**Error Messages:**
- Include context: `[${label}] error message` or `[${officeName}] description`
- Machine-readable error categories in audit scripts: severity levels ('ERROR', 'WARN', 'INFO')
- Detailed error objects with multiple fields for investigation: `{ category, severity, office, patientName, visitDate, ... }`

## Logging

**Framework:** `src/core/logger.ts` - simple wrapper with four levels

**Methods:**
- `logger.info()` - general progress messages
- `logger.warn()` - retries, non-critical issues
- `logger.debug()` - detailed diagnostic info
- `logger.error()` - exceptions and failures

**Patterns:**
- Log before and after major operations: "CSV DL: ..." then "CSV saved: ..."
- Include numeric counts: `logger.info(`[${officeName}] HAM: ${ham.length} (フィルタ後)`)`
- Log section breaks in reports: `logger.info('=' .repeat(70))`
- Error messages include context labels: `[${label}] attempt 1 failed`

## Comments

**When to Comment:**
- Algorithm explanation for non-obvious logic (time diff calculation, rehab merging)
- Domain-specific concepts in Japanese: 介護 (care), 医療 (medical), 訪看 (visiting nurse)
- Block comments for major sections: `// ─── Types ───`, `// ─── Merge Rehab ───`
- JSDoc on public functions with parameters and return types

**JSDoc/TSDoc:**
- Used on service class methods and exported functions
- Format: `/** Description */` single line, or multiline with `@param` and `@returns`
- Example from `spreadsheet.service.ts`: "実績ロック（Z列）を解除する（FALSE にクリア）"

**Section Markers:**
- Using ASCII lines: `// ─── Helpers ───`, `// ─── Main Audit ───`, `// ─── Report ───`
- Helps organize large script files into logical chunks
- No formal grouping tool; convention-based only

## Function Design

**Size:**
- Most functions 20-50 lines
- Larger scripts decompose into 5-10 function chunks for readability
- Very long functions (100+ lines) exist but are organized with clear sections

**Parameters:**
- Explicit parameter lists, no object params for simple functions
- Configuration objects used for complex options: `RetryOptions` interface
- Spread operator not heavily used; explicit params preferred

**Return Values:**
- Single return type per function (no overloading)
- Use interfaces for complex returns: `AuditIssue[]`, `ReconciliationResult`
- Void for side-effect operations: `updateTranscriptionStatus()`
- Async functions wrap returns in `Promise<T>`

## Module Design

**Exports:**
- Named exports preferred: `export interface ScheduleEntry { ... }`
- Single class export per service file: `export class SpreadsheetService { ... }`
- Barrel files exist (implied by imports from `src/types/`) but not explicitly defined
- Const helpers exported at module level: `export function normalizeCjkName() { ... }`

**Barrel Files:**
- None explicitly created; imports are direct from source files
- Types grouped in `src/types/` directory but no index.ts barrel files found

## Immutability Patterns

**Data Handling:**
- Maps used to accumulate data: `new Map<string, ScheduleEntry[]>()`
- Objects spread with rest operator for updates: `{ ...sorted[0], endTime: sorted[sorted.length - 1].endTime }`
- Array concatenation with spread: `[...nonR, ...merged]`
- Filter operations create new arrays: `entries.filter(e => !isTest(e.patientName))`

**No In-Place Mutations:**
- Function results always return new collections
- Example: `mergeRehab()` returns new array, doesn't mutate input
- Maps rebuilt fresh for each audit run, not reused

## Validation

**At System Boundaries:**
- CSV file size validation: `if (size < 100) throw new Error(...)`
- Null/undefined checks on data: `if (!hamRecs || hamRecs.length === 0)`
- Boolean parsing: `parseBoolean(val)` handles multiple formats ('TRUE', '1', 'はい')
- Service content classification: `isKaigoService()`, `isIryoService()` guard conditions

**Data Normalization:**
- CJK name normalization for matching: `normalizeCjkName(name)` converts variants, old characters, whitespace
- Date format normalization: `normDate()` handles YYYYMMDD and YYYY-MM-DD formats
- Time format normalization: `normTime()` standardizes to HH:MM format

## Key Architectural Patterns

**CSV Comparison Pattern (Reconciliation Scripts):**
1. Parse CSV into typed objects (`ScheduleEntry[]`)
2. Fetch Sheets data into typed objects (`TranscriptionRecord[]`)
3. Build Maps with normalized keys (patient name | date | start time)
4. Compare maps bidirectionally (Sheets→HAM, HAM→Sheets)
5. Collect mismatches in typed result array (`AuditIssue[]`)
6. Format and report results

**Service/Workflow Separation:**
- Services handle data access and transformation
- Workflows handle orchestration and state management
- Cross-cutting concerns (logging, retry) in core modules

**TypeScript Usage:**
- Strict mode enabled throughout
- Explicit type annotations on function params and returns
- Interface-based contracts between modules
- Type imports for non-runtime references

---

*Convention analysis: 2026-04-06*
