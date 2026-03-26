# Fix: 看護記録修正管理 F列下拉框消失

## TL;DR

> **Quick Summary**: `appendCorrectionRecord` 使用 `INSERT_ROWS` 导致新插入的行没有 F 列的数据验证（下拉框），改为 `OVERWRITE` 即可保留预设的下拉框。
> 
> **Deliverables**: 修改一行代码
> **Estimated Effort**: Quick (1分钟)
> **Parallel Execution**: NO - single change

---

## Context

### Problem
看護記録修正管理シートの F 列に手動で設定したプルダウン（未確認 / 上書きOK / 看護記録修正済）が、
RPA がデータを追加するたびに消失する。

### Root Cause
`spreadsheet.service.ts` の `appendCorrectionRecord` で `insertDataOption: 'INSERT_ROWS'` を使用しているため、
**新しい空白行が挿入される**。この新行には既存行のデータ入力規則（プルダウン）が引き継がれない。

### Solution
`INSERT_ROWS` → `OVERWRITE` に変更する。
`OVERWRITE` は既存の行に書き込むため、事前に設定された F 列のプルダウンが保持される。

---

## TODOs

- [x] 1. Change INSERT_ROWS to OVERWRITE

  **What to do**:
  - Open `src/services/spreadsheet.service.ts`
  - In the `appendCorrectionRecord` method (around line 218)
  - Change: `insertDataOption: 'INSERT_ROWS',`
  - To: `insertDataOption: 'OVERWRITE',`

  **Must NOT do**:
  - Do NOT change anything else in this file
  - Do NOT modify `updateCorrectionStatus` method
  - Do NOT touch any other methods or files

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [] (no special skills needed)

  **References**:
  - `src/services/spreadsheet.service.ts:207-229` - `appendCorrectionRecord` method, line 218 is the exact target

  **Acceptance Criteria**:
  - [ ] Line 218 reads `insertDataOption: 'OVERWRITE',`
  - [ ] No other changes in the file
  - [ ] `npx tsc --noEmit` passes (TypeScript compilation check)

  **Commit**: YES
  - Message: `fix(spreadsheet): use OVERWRITE instead of INSERT_ROWS to preserve F column dropdowns`
  - Files: `src/services/spreadsheet.service.ts`

---

## Success Criteria

### Final Checklist
- [x] `insertDataOption` is `'OVERWRITE'` in `appendCorrectionRecord`
- [x] TypeScript compiles without errors (existing errors in test scripts are pre-existing, unrelated to this change)
