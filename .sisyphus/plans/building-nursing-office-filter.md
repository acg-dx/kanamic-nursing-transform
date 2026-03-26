# 同一建物管理: 追加 --nursing-office= 事業所名フィルタ

## TL;DR

> **Quick Summary**: 给 `run-building.ts` 脚本添加 `--nursing-office=` CLI 参数，使用户可以按訪問看護事業所名过滤登录数据。镜像现有 `--facility=` 过滤模式。
> 
> **Deliverables**:
> - `run-building.ts` 支持 `--nursing-office=` 参数
> - `BuildingWorkflowConfig` 新增 `nursingOffice` 字段
> - `building.workflow.ts` 按 `nursingOfficeName` 过滤记录
> 
> **Estimated Effort**: Quick（~12 行代码，2 个文件）
> **Parallel Execution**: NO — 单任务
> **Critical Path**: Task 1（唯一任务）

---

## Context

### Original Request
用户希望本次同一建物登录只处理 `利用訪問看護事業所名 = 訪問看護ステーションあおぞら姶良` 的数据。当前 `--facility=` 仅按入居施設名过滤，缺少按事業所名过滤的功能。

### Interview Summary
**Key Discussions**:
- 谷歌表格中已有数据（Step 1 数据提取已完成），仅需 Step 2 登录
- 用户本次只想登录姶良事業所的数据

**Research Findings**:
- `nursingOfficeName` 字段可能是逗号分隔的多值（如 `"あおぞら姶良, あおぞらB"`）
- `includes()` 部分匹配天然兼容逗号分隔值，与 `--facility=` 一致

### Metis Review
**Identified Gaps** (addressed):
- 文件路径必须使用完整路径（`src/workflows/building-management/building.workflow.ts`）
- 过滤器顺序重要：`nursingOffice` 过滤必须在 `facility` 之后、`limit` 之前
- 改动点是 4 个而非 2 个（接口、过滤逻辑、参数解析、启动日志+配置传递）
- 需更新文件顶部的 JSDoc 使用示例

---

## Work Objectives

### Core Objective
添加 `--nursing-office=` CLI 过滤参数，使同一建物管理登录可按訪問看護事業所名过滤。

### Concrete Deliverables
- `src/scripts/run-building.ts` 支持 `--nursing-office=XXX` 命令行参数
- `src/workflows/building-management/building.workflow.ts` 按 `nursingOfficeName` 过滤记录

### Definition of Done
- [ ] `npx tsc --noEmit` 编译通过
- [ ] `npx tsx src/scripts/run-building.ts --tab=2026/02 --dry-run --nursing-office=姶良` 输出包含 `事業所フィルタ`

### Must Have
- `--nursing-office=` 参数使用 `includes()` 部分匹配（与 `--facility=` 一致）
- 不传参时行为完全不变

### Must NOT Have (Guardrails)
- 不修改 `spreadsheet.types.ts`、`premises-navigator.ts`、`building-data-extraction.service.ts`
- 不重构现有代码
- 不添加超出 `--facility=` 已有的校验或错误处理
- 不添加新测试文件（本次为极简改动）
- 不重命名现有 `facility` 参数

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: YES (vitest)
- **Automated tests**: None（极简改动，镜像现有模式）
- **Framework**: vitest（但本任务不新增测试）

### QA Policy
每个任务包含 agent-executed QA scenarios。
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **CLI**: Use Bash — run command, validate stdout output

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — single task):
└── Task 1: Add --nursing-office= filter [quick]

Wave FINAL (After Task 1):
└── (No separate verification needed — QA built into Task 1)

Critical Path: Task 1
Max Concurrent: 1
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1    | None      | None   |

### Agent Dispatch Summary

- **Wave 1**: **1 task** — T1 → `quick`

---

## TODOs

- [x] 1. Add `--nursing-office=` CLI filter to building registration

  **What to do**:

  修改 2 个文件，共 4 个触点：

  **触点 A — `BuildingWorkflowConfig` 接口** (`src/workflows/building-management/building.workflow.ts` line 48):
  在 `facility?: string;` 之后添加:
  ```typescript
  /** 事業所名フィルタ（部分一致） */
  nursingOffice?: string;
  ```

  **触点 B — 过滤逻辑** (`src/workflows/building-management/building.workflow.ts` line 79 之后、line 80 `limit` 之前):
  镜像 lines 75-79 的 `facility` 过滤模式，添加:
  ```typescript
  if (this.config.nursingOffice) {
    const nursingOfficeFilter = this.config.nursingOffice;
    targets = targets.filter(r => r.nursingOfficeName.includes(nursingOfficeFilter));
    logger.info(`同一建物管理: 事業所フィルタ "${nursingOfficeFilter}" → ${targets.length}件`);
  }
  ```

  **触点 C — CLI 参数解析** (`src/scripts/run-building.ts` `parseArgs()` 函数):
  - 在 `let facility: string | undefined;` 之后添加 `let nursingOffice: string | undefined;`
  - 在 for 循环中添加 `else if (arg.startsWith('--nursing-office='))` 分支
  - 在 return 对象中添加 `nursingOffice`

  **触点 D — 启动日志 + 配置传递 + JSDoc** (`src/scripts/run-building.ts`):
  - 更新文件顶部的使用示例注释，添加 `--nursing-office=` 示例
  - 在 `main()` 的 destructure 中添加 `nursingOffice`
  - 在 line 76 之后添加: `if (nursingOffice) logger.info(\`  事業所フィルタ: ${nursingOffice}\`);`
  - 在 workflow config 对象 (lines 116-122) 中添加 `nursingOffice`

  **Must NOT do**:
  - 不修改除上述 2 个文件以外的任何文件
  - 不重构现有代码
  - 不添加 `--facility=` 没有的校验逻辑

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 极简改动，2 个文件共 ~12 行，纯 TypeScript 编辑
  - **Skills**: `[]`
    - 无需 browser/git/UI 技能
  - **Skills Evaluated but Omitted**:
    - `playwright`: 无浏览器交互
    - `git-master`: 不涉及 git 操作

  **Parallelization**:
  - **Can Run In Parallel**: N/A（唯一任务）
  - **Parallel Group**: Wave 1
  - **Blocks**: None
  - **Blocked By**: None

  **References**:

  **Pattern References** (existing code to follow):
  - `src/workflows/building-management/building.workflow.ts:75-79` — `facility` 过滤模式，**完全镜像此模式**
  - `src/scripts/run-building.ts:50-51` — `--facility=` CLI 参数解析模式

  **API/Type References**:
  - `src/workflows/building-management/building.workflow.ts:38-49` — `BuildingWorkflowConfig` 接口定义
  - `src/types/spreadsheet.types.ts` — `BuildingManagementRecord.nursingOfficeName` 字段（string 类型）

  **Context References**:
  - `src/scripts/run-building.ts:11-15` — JSDoc 使用示例（需更新）
  - `src/scripts/run-building.ts:67-77` — `main()` 启动日志区域
  - `src/scripts/run-building.ts:116-122` — workflow config 对象

  **WHY Each Reference Matters**:
  - `building.workflow.ts:75-79`: 这是你要**一字不差地镜像**的模式，只是字段名和日志文本不同
  - `run-building.ts:50-51`: 这是 CLI 参数解析的模式，你的新 `--nursing-office=` 解析要紧跟其后
  - `BuildingWorkflowConfig`: 你要在这个接口加新字段
  - `run-building.ts:116-122`: 你要把新参数传给 workflow

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY):**

  ```
  Scenario: Happy path — --nursing-office= filter works in dry-run
    Tool: Bash
    Preconditions: .env configured, spreadsheet has data for tab 2026/02
    Steps:
      1. Run: npx tsc --noEmit
      2. Assert: exit code 0 (compilation passes)
      3. Run: npx tsx src/scripts/run-building.ts --tab=2026/02 --dry-run --nursing-office=姶良
      4. Assert: stdout contains "事業所フィルタ: 姶良"
      5. Assert: stdout contains "事業所フィルタ" followed by "→" and a number + "件"
    Expected Result: Compilation passes AND dry-run output shows the nursing office filter was applied
    Failure Indicators: tsc errors, or "事業所フィルタ" not in output, or crash
    Evidence: .sisyphus/evidence/task-1-nursing-office-filter-dryrun.txt

  Scenario: No filter — default behavior unchanged
    Tool: Bash
    Preconditions: Same as above
    Steps:
      1. Run: npx tsx src/scripts/run-building.ts --tab=2026/02 --dry-run
      2. Assert: stdout does NOT contain "事業所フィルタ"
      3. Assert: script completes successfully (exit code 0)
    Expected Result: Without --nursing-office= flag, behavior is identical to before
    Failure Indicators: "事業所フィルタ" appears in output, or crash
    Evidence: .sisyphus/evidence/task-1-no-filter-default.txt
  ```

  **Evidence to Capture:**
  - [ ] task-1-nursing-office-filter-dryrun.txt — dry-run with filter output
  - [ ] task-1-no-filter-default.txt — dry-run without filter output

  **Commit**: YES
  - Message: `feat(building): add --nursing-office= filter for nursing office name`
  - Files: `src/workflows/building-management/building.workflow.ts`, `src/scripts/run-building.ts`
  - Pre-commit: `npx tsc --noEmit`

---

## Final Verification Wave

> 本任务极简（~12 行改动），QA 已内置于 Task 1。无需独立验证波。
> 如 Task 1 的 QA scenarios 全部通过，即可视为完成。

---

## Commit Strategy

| # | Message | Files | Pre-commit |
|---|---------|-------|------------|
| 1 | `feat(building): add --nursing-office= filter for nursing office name` | `building.workflow.ts`, `run-building.ts` | `npx tsc --noEmit` |

---

## Success Criteria

### Verification Commands
```bash
npx tsc --noEmit                          # Expected: no errors
npx tsx src/scripts/run-building.ts --tab=2026/02 --dry-run --nursing-office=姶良   # Expected: output contains "事業所フィルタ: 姶良"
npx tsx src/scripts/run-building.ts --tab=2026/02 --dry-run                         # Expected: no "事業所フィルタ" in output
```

### Final Checklist
- [ ] `--nursing-office=` 参数被解析并传递
- [ ] 过滤器使用 `includes()` 部分匹配
- [ ] 不传参时行为不变
- [ ] TypeScript 编译通过
- [ ] JSDoc 使用示例已更新
