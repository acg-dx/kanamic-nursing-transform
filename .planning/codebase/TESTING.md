# Testing Patterns

**Analysis Date:** 2026-04-06

## Test Framework

**Runner:**
- Vitest 4.0.18
- Config: `vitest.config.ts`

**Assertion Library:**
- Vitest built-in `expect()` from vitest package

**Run Commands:**
```bash
npm test              # Run all tests once (vitest run)
npm run test:watch   # Watch mode (vitest)
```

Coverage reporting not configured; no coverage threshold enforced.

## Test File Organization

**Location:** Co-located with source
- Tests placed in `src/*/__tests__/` subdirectories
- Pattern: `<module>.test.ts` in `__tests__` folder

**Naming:**
- Source: `src/core/cjk-normalize.ts` → Test: `src/core/__tests__/cjk-normalize.test.ts`
- Source: `src/core/retry-manager.ts` → Test: `src/core/__tests__/retry-manager.test.ts`
- Source: `src/services/notification.service.ts` → Test: `src/services/__tests__/notification.service.test.ts`

**File Count:** 6 test files found
- `src/core/__tests__/cjk-normalize.test.ts`
- `src/core/__tests__/retry-manager.test.ts`
- `src/services/__tests__/notification.service.test.ts`
- `src/services/__tests__/smarthr.service.test.ts`
- `src/workflows/transcription/__tests__/transcription-target.test.ts`
- `src/workflows/correction/__tests__/correction-detection.test.ts`

## Test Structure

**Suite Organization:**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('moduleName', () => {
  let service: ServiceType;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ServiceType(mockConfig);
  });

  it('should do something when condition', () => {
    expect(service.method()).toBe(expectedValue);
  });

  it('should throw when bad input', async () => {
    await expect(service.asyncMethod()).rejects.toThrow();
  });
});
```

**Patterns:**
- Top-level `describe()` block per major feature/class
- Nested `describe()` blocks for grouping related tests: `describe('normalizeCjkName', () => { ... })`
- `beforeEach()` for setup (clearing mocks, creating fresh instances)
- Each `it()` tests one behavior with descriptive title in Japanese and English
- No global setup files; mocking configured locally per test file

## Mocking

**Framework:** Vitest's `vi` module

**Patterns:**
```typescript
// Global stub
vi.stubGlobal('fetch', mockFetch);

// Module mock
vi.mock('../logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

// Function mock
const fn = vi.fn().mockResolvedValueOnce('success');
const fn = vi.fn().mockRejectedValueOnce(new Error('failed'));

// Assertion
expect(fn).toHaveBeenCalledTimes(1);
expect(fn).toHaveBeenCalledWith(expectedArg);
```

**What to Mock:**
- External APIs (fetch, Google Sheets API)
- Logger module (to avoid console spam in tests)
- Services with external dependencies
- Browser/DOM APIs when necessary

**What NOT to Mock:**
- Pure utility functions: `normalizeCjkName()` tested directly
- Business logic with clear behavior: string transformation, data normalization
- Internal orchestration: actual workflow logic tested with mocked dependencies

**Example from `notification.service.test.ts`:**
```typescript
const mockFetch = vi.fn().mockResolvedValue({
  json: () => Promise.resolve({ success: true }),
});
vi.stubGlobal('fetch', mockFetch);
```

## Fixtures and Test Data

**Test Data Creation:**
```typescript
const mockConfig: NotificationConfig = {
  webhookUrl: 'https://script.google.com/macros/s/test/exec',
  to: ['admin@example.com'],
};

const mockSuccessReport: DailyReport = {
  date: '2026-02-25',
  reports: [ ... ],
  overallSuccess: true,
  totalProcessed: 10,
  totalErrors: 0,
};
```

**Location:** Defined directly in test files, no separate factory files

**Scope:** Module-level constants created before test suites run

**Pattern from `cjk-normalize.test.ts`:**
```typescript
const problemNames = [
  '持留宏昭','榊\u{E0100}陽子','嶺山吉弘', ...
];

it.each(problemNames)('"%s" は正規化後に不可見文字を含まない', (name) => {
  const normalized = normalizeCjkName(name);
  expect(normalized).not.toMatch(/[\uFE00-\uFE0F]/);
});
```

Parameterized tests used for comprehensive CJK normalization coverage across 161 real names from production.

## Coverage

**Requirements:** None enforced

**Current Status:** No coverage configuration in vitest.config.ts

**View Coverage:** Not available via npm script

## Test Types

**Unit Tests:**
- Scope: Individual functions and utilities
- Approach: Direct function calls with specific inputs
- Example: `normalizeCjkName('髙橋ゆきこ')` → `'高橋ユキコ'`
- Mocks: Only external dependencies (logger, browser APIs)

**Integration Tests:**
- Scope: Service methods with mocked external APIs
- Approach: Instantiate service, call method, verify HTTP calls/results
- Example: `NotificationService.sendDailyReport()` verifies fetch call
- Mocks: Network calls, Google Sheets API, but services composed normally

**E2E Tests:**
- Status: Not found in repository
- Browser-based workflows (transcription, deletion) tested manually or via script execution
- Justification: E2E requires real HAM system access; not suitable for automated test suite

## Common Patterns

**Async Testing:**
```typescript
it('should succeed on first attempt', async () => {
  const fn = vi.fn().mockResolvedValueOnce('success');
  const result = await withRetry(fn, 'test-label');
  expect(result).toBe('success');
});

it('should throw after maxAttempts exhausted', async () => {
  const fn = vi.fn().mockRejectedValue(new Error('persistent failure'));
  await expect(
    withRetry(fn, 'test-label', { maxAttempts: 2, baseDelay: 10 })
  ).rejects.toThrow('persistent failure');
});
```

**Error Testing:**
```typescript
it('should throw when bad input', async () => {
  await expect(
    withRetry(fn, 'test-label', { maxAttempts: 2, baseDelay: 10 })
  ).rejects.toThrow('persistent failure');

  expect(fn).toHaveBeenCalledTimes(2);
});

it('sendDailyReport does not throw when webhook fails', async () => {
  mockFetch.mockRejectedValueOnce(new Error('Network error'));
  await expect(service.sendDailyReport(mockSuccessReport)).resolves.not.toThrow();
});
```

**Parameterized Testing:**
```typescript
it.each(testCases)('test case: %s', (input, expected) => {
  expect(normalize(input)).toBe(expected);
});

// With array of test data objects
it.each([
  { input: '水口とも子', expected: '水口トモ子' },
  { input: '髙橋ゆきこ', expected: '高橋ユキコ' },
])('normalize $input → $expected', ({ input, expected }) => {
  expect(normalizeCjkName(input)).toBe(expected);
});
```

## Test Organization Strategy

**By Domain:**
- CJK name normalization tests: 165+ test cases verifying character transformations
- Retry logic tests: success on first/nth attempt, max attempts exhaustion
- Service notification tests: success/failure reporting, disabled service behavior

**Depth:**
- Utility layer: Comprehensive (100+ test cases for normalization)
- Service layer: Moderate (basic success/failure paths)
- Workflow layer: Minimal (no unit tests; manual/script testing)

**Coverage Gaps:**
- No tests for CSV parsing logic (reconciliation service)
- No tests for spreadsheet update operations
- No tests for workflow orchestration
- No tests for audit report generation
- Reconciliation and verification scripts tested manually via `run-full-reconciliation.ts`, `run-march-audit.ts`

## Vitest Configuration

**File:** `vitest.config.ts`

```typescript
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

**Key Settings:**
- `environment: 'node'` - No DOM/browser environment
- `include` pattern: `src/**/*.test.ts` matches all test files in subdirectories
- No coverage threshold
- No global setup/teardown
- No custom reporters

---

*Testing analysis: 2026-04-06*
