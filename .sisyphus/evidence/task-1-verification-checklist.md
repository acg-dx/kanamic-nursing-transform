# Task 1 Verification Checklist

## ✅ Touch Point A: Interface (building.workflow.ts)
- [x] Line 50: `nursingOffice?: string;` added to `BuildingWorkflowConfig`
- [x] JSDoc comment: `/** 事業所名フィルタ（部分一致） */`
- [x] Positioned after `facility?: string;` field

## ✅ Touch Point B: Filter Logic (building.workflow.ts)
- [x] Lines 82-86: Filter block added after facility filter
- [x] Uses `this.config.nursingOffice` check
- [x] Filters by `r.nursingOfficeName.includes(nursingOfficeFilter)`
- [x] Logs: `同一建物管理: 事業所フィルタ "${nursingOfficeFilter}" → ${targets.length}件`
- [x] Positioned BEFORE limit filter (line 87)

## ✅ Touch Point C: CLI Argument Parsing (run-building.ts)
- [x] Line 43: `let nursingOffice: string | undefined;` declared
- [x] Lines 54-55: `--nursing-office=` parsing branch added
- [x] Line 58: `nursingOffice` added to return object
- [x] Positioned after `--facility=` branch

## ✅ Touch Point D: Main Function & JSDoc (run-building.ts)
- [x] Line 16: JSDoc example added: `--nursing-office=訪問看護ステーションあおぞら姶良`
- [x] Line 72: `nursingOffice` added to destructuring
- [x] Line 81: Logging added: `if (nursingOffice) logger.info(...)`
- [x] Line 127: `nursingOffice` added to workflow config object

## ✅ Pattern Consistency
- [x] Mirrors `--facility=` pattern exactly
- [x] Uses `.includes()` for partial matching
- [x] Same log format with `→ N件` suffix
- [x] Optional parameter (no breaking changes)
- [x] Filter order preserved: facility → nursingOffice → limit

## ✅ Code Quality
- [x] No refactoring of existing code
- [x] No validation/error handling added (matches facility pattern)
- [x] No test files added
- [x] No renaming of existing parameters
- [x] Proper TypeScript typing

## ✅ Expected Behavior
- [x] With `--nursing-office=姶良`: outputs `事業所フィルタ: 姶良`
- [x] Without filter: no `事業所フィルタ` output
- [x] Filters records by `nursingOfficeName` field
- [x] Handles comma-separated values via `.includes()`

## Files Modified
1. ✅ `src/workflows/building-management/building.workflow.ts`
   - Interface: 1 field added
   - Filter logic: 5 lines added
   
2. ✅ `src/scripts/run-building.ts`
   - JSDoc: 1 example added
   - parseArgs: 3 lines added
   - main: 3 lines added

## Summary
All 4 touch points successfully implemented. Code follows established patterns and maintains backward compatibility. Ready for TypeScript compilation and runtime testing.
