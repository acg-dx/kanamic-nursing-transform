# Task 1: Add --nursing-office= CLI Parameter

## Summary
Successfully added `--nursing-office=` CLI parameter to the 同一建物管理 (building management) registration script, mirroring the existing `--facility=` filter pattern exactly.

## Changes Made

### 1. Touch Point A: Interface (building.workflow.ts, lines 49-50)
Added new field to `BuildingWorkflowConfig` interface:
```typescript
/** 事業所名フィルタ（部分一致） */
nursingOffice?: string;
```

### 2. Touch Point B: Filter Logic (building.workflow.ts, lines 82-86)
Added nursing office filter block after facility filter:
```typescript
if (this.config.nursingOffice) {
  const nursingOfficeFilter = this.config.nursingOffice;
  targets = targets.filter(r => r.nursingOfficeName.includes(nursingOfficeFilter));
  logger.info(`同一建物管理: 事業所フィルタ "${nursingOfficeFilter}" → ${targets.length}件`);
}
```

### 3. Touch Point C: CLI Argument Parsing (run-building.ts, lines 43, 54-55, 58)
- Added `let nursingOffice: string | undefined;` declaration (line 43)
- Added parsing branch for `--nursing-office=` argument (lines 54-55)
- Added `nursingOffice` to return object (line 58)

### 4. Touch Point D: Main Function & JSDoc (run-building.ts)
- Updated JSDoc with usage example (line 16):
  ```
  npx tsx src/scripts/run-building.ts --nursing-office=訪問看護ステーションあおぞら姶良  # 事業所フィルタ
  ```
- Updated destructuring in main() to include `nursingOffice` (line 72)
- Added logging for nursing office filter (line 81):
  ```typescript
  if (nursingOffice) logger.info(`  事業所フィルタ: ${nursingOffice}`);
  ```
- Added `nursingOffice` to workflow config object (line 127)

## Files Modified
1. `src/workflows/building-management/building.workflow.ts` (2 touch points)
2. `src/scripts/run-building.ts` (2 touch points)

## Pattern Consistency
All changes follow the existing `--facility=` filter pattern exactly:
- Optional parameter with `?` in interface
- Partial string matching using `.includes()`
- Same log format with `→ N件` suffix
- Filter order: facility → nursingOffice → limit

## Verification Status
✅ All 4 touch points applied correctly
✅ Code structure matches existing patterns
✅ No refactoring or unrelated changes
✅ Optional parameter (no breaking changes)
✅ Filter order preserved (facility → nursingOffice → limit)

## Expected Behavior
- `npx tsx src/scripts/run-building.ts --tab=2026/02 --dry-run --nursing-office=姶良`
  → Outputs: `事業所フィルタ: 姶良` in logs
  
- `npx tsx src/scripts/run-building.ts --tab=2026/02 --dry-run`
  → No `事業所フィルタ` output (filter not applied)

## Notes
- Node.js environment not available in current session for runtime testing
- TypeScript compilation verification deferred to deployment environment
- All changes are syntactically correct and follow established patterns
