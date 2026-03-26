# completionStatus フィルタ追加 + RPA全体仕様書作成

## TL;DR

> **Quick Summary**: 転記対象判定に completionStatus フィルタを追加し（"1"と空白を除外）、RPA全体仕様書を新規作成する。
> 
> **Deliverables**:
> - `src/workflows/transcription/transcription.workflow.ts` の `isTranscriptionTarget` に completionStatus チェック追加
> - `src/workflows/transcription/__tests__/transcription-target.test.ts` ユニットテスト（11ケース）
> - `docs/rpa-specification.md` RPA全体仕様書（エラー処理、ページ遷移、処理時間等）
> 
> **Estimated Effort**: Short (2-3 hours)
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 (code change + test) → Done. Task 2 (spec doc) is independent.

---

## Context

### Original Request
会議決定事項に基づき、completionStatus（完了ステータス）が「1」（日々チェック保留）と空白のレコードを転記対象から除外する。「2」「3」「4」のみをカナミック（HAM）への転記対象とする。また、RPA処理のエラー時の挙動やカナミックへのデータ転記のペース（クリック数、ページ遷移、処理時間）を全体仕様書としてまとめる。

### Interview Summary
**Key Discussions**:
- 会議決定: 「1」と空白ステータスは保留として転記から除外し、「2、3、4」をカナミックへの転記対象とする
- 転記RPAが書き込むのは月次sheetのS列（転記フラグ）、U列（エラー詳細）、V列（データ取得日時）のみ
- CorrectionDetectorはデッドコード（importされているが未使用）
- S列の'修正あり'は看護記録転記プロジェクトの責任範囲
- ドロップダウン問題（F列）は本プロジェクトの範囲外

**Research Findings**:
- `completionStatus` は M列（index 12）、SpreadsheetService L60 で既に読み取り済み
- `TranscriptionRecord` 型に `completionStatus: string` が L28-29 で定義済み
- vitest が設定済み（vitest.config.ts: include: `src/**/*.test.ts`）
- 転記ワークフローは14ステップ、27回の sleep() 呼び出し（合計 ~21.5秒/レコード）
- リトライ設定: 転記 maxAttempts=2/baseDelay=3000、デフォルト maxAttempts=3/baseDelay=1000
- ログインフロー: TRITRUS → JOSSO SSO → goCicHam.jsp → HAM（4ステップ）

### Gap Analysis (Self-Reviewed)
**Identified & Resolved**:
- completionStatus の値型は string（数値ではない）→ 文字列比較で正しい
- 空文字チェックは SpreadsheetService が `row[COL_M] || ''` で既にデフォルト化済み
- DeletionWorkflow にも completionStatus があるが、削除の判定ロジックは別条件（`!r.completionStatus.includes('削除済み')`）で影響なし

---

## Work Objectives

### Core Objective
completionStatus による転記対象フィルタリングを追加し、RPA全体の技術仕様書を作成する。

### Concrete Deliverables
1. `transcription.workflow.ts` L146-154 の `isTranscriptionTarget` メソッド修正
2. `__tests__/transcription-target.test.ts` ユニットテスト新規作成
3. `docs/rpa-specification.md` 全体仕様書新規作成

### Definition of Done
- [x] completionStatus が "" のレコードは転記対象外
- [x] completionStatus が "1" のレコードは転記対象外
- [x] completionStatus が "2","3","4" のレコードは（他の条件を満たせば）転記対象
- [x] 全テスト PASS: `npx vitest run src/workflows/transcription/__tests__/transcription-target.test.ts`
- [x] `docs/rpa-specification.md` が存在し、セクション 2-1 ～ 2-10 を含む

### Must Have
- completionStatus チェックは `recordLocked` チェックの直後に配置（早期 return）
- テストは isTranscriptionTarget の全分岐をカバー
- 仕様書は実コードの sleep 値・リトライ設定から正確な数値を記載

### Must NOT Have (Guardrails)
- 他のプロジェクト（看護記録転記）のファイルを変更しないこと
- CorrectionDetector の修正・削除は行わない（スコープ外）
- isTranscriptionTarget 以外の転記ロジック変更は行わない
- 仕様書に推測値を書かない（全てコードから抽出した実値のみ）
- completionStatus の値を数値変換しない（文字列比較のまま）

---

## Verification Strategy (MANDATORY)

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> ALL tasks in this plan MUST be verifiable WITHOUT any human action.

### Test Decision
- **Infrastructure exists**: YES (vitest.config.ts, src/**/*.test.ts)
- **Automated tests**: YES (TDD for Task 1)
- **Framework**: vitest

### Agent-Executed QA Scenarios (MANDATORY — ALL tasks)

Every task includes agent-executed verification via Bash commands. No human action required.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — Parallel):
├── Task 1: completionStatus フィルタ追加 + テスト (code change)
└── Task 2: RPA全体仕様書作成 (documentation)

Wave 2: なし（2タスクとも独立）
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | None | 2 |
| 2 | None | None | 1 |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1, 2 | Task 1: category="quick", Task 2: category="writing" |

---

## TODOs

- [x] 1. completionStatus フィルタ追加 + ユニットテスト

  **What to do**:

  **Step 1 (RED)**: テストファイル作成
  - `src/workflows/transcription/__tests__/transcription-target.test.ts` を新規作成
  - TranscriptionWorkflow クラスの `isTranscriptionTarget` メソッドをテスト
  - 以下の11テストケースを作成:

  ```
  describe('isTranscriptionTarget', () => {
    // completionStatus テスト（新規追加分）
    1. completionStatus が '' (空白) → false
    2. completionStatus が '1' (日々チェック保留) → false
    3. completionStatus が '2' (日々チェック完了) → true（transcriptionFlag='' の場合）
    4. completionStatus が '3' → true
    5. completionStatus が '4' → true

    // 既存ロジックテスト（回帰テスト）
    6. recordLocked が true → false（completionStatus='2' でも）
    7. transcriptionFlag が '転記済み' → false
    8. transcriptionFlag が '' (空白) → true（completionStatus='2' の場合）
    9. transcriptionFlag が 'エラー：システム' → true
    10. transcriptionFlag が 'エラー：マスタ不備' + masterCorrectionFlag=true → true
    11. transcriptionFlag が '修正あり' → true
  })
  ```

  - テストではインスタンスを直接作成する。コンストラクタ引数はモック:
    ```typescript
    import { TranscriptionWorkflow } from '../transcription.workflow';

    // TranscriptionWorkflow extends BaseWorkflow(browser, selectorEngine, sheets, auth)
    // isTranscriptionTarget は public メソッドなのでモック不要で直接テスト可能
    // ただしコンストラクタ引数が必要なので null as any で簡易モック
    const workflow = new TranscriptionWorkflow(
      null as any, null as any, null as any, null as any
    );
    ```

  - テスト用レコードファクトリ関数を作成:
    ```typescript
    function makeRecord(overrides: Partial<TranscriptionRecord> = {}): TranscriptionRecord {
      return {
        rowIndex: 2,
        recordId: 'test-001',
        timestamp: '',
        updatedAt: '',
        staffNumber: '001',
        staffName: 'テスト太郎',
        aozoraId: 'AZ001',
        patientName: 'テスト患者',
        visitDate: '2026-02-27',
        startTime: '09:00',
        endTime: '10:00',
        serviceType1: '医療',
        serviceType2: '通常',
        completionStatus: '2',    // デフォルト: 転記対象
        accompanyCheck: '',
        emergencyFlag: '',
        accompanyClerkCheck: '',
        multipleVisit: '',
        emergencyClerkCheck: '',
        transcriptionFlag: '',    // デフォルト: 未転記
        masterCorrectionFlag: false,
        errorDetail: '',
        dataFetchedAt: '',
        serviceTicketCheck: false,
        notes: '',
        recordLocked: false,
        ...overrides,
      };
    }
    ```

  - テスト実行: `npx vitest run src/workflows/transcription/__tests__/transcription-target.test.ts`
  - Expected: FAIL（completionStatus フィルタ未実装のため、テスト 1, 2 が失敗）

  **Step 2 (GREEN)**: コード修正
  - `src/workflows/transcription/transcription.workflow.ts` の `isTranscriptionTarget` メソッド（L146-154）を修正
  - `recordLocked` チェックの直後（L147の後）に以下を追加:
    ```typescript
    // 完了ステータスフィルタ: "1"(日々チェック保留) と ""(空白) は転記対象外
    // 会議決定: "2","3","4" のみ転記対象
    const cs = record.completionStatus;
    if (cs === '' || cs === '1') return false;
    ```
  - 修正後の `isTranscriptionTarget` 全体:
    ```typescript
    isTranscriptionTarget(record: TranscriptionRecord): boolean {
      if (record.recordLocked) return false;
      // 完了ステータスフィルタ: "1"(日々チェック保留) と ""(空白) は転記対象外
      const cs = record.completionStatus;
      if (cs === '' || cs === '1') return false;
      if (record.transcriptionFlag === '転記済み') return false;
      if (record.transcriptionFlag === '') return true;
      if (record.transcriptionFlag === 'エラー：システム') return true;
      if (record.transcriptionFlag === 'エラー：マスタ不備' && record.masterCorrectionFlag) return true;
      if (record.transcriptionFlag === '修正あり') return true;
      return false;
    }
    ```
  - テスト実行: `npx vitest run src/workflows/transcription/__tests__/transcription-target.test.ts`
  - Expected: PASS（全11テスト合格）

  **Step 3 (REFACTOR)**: 不要 — コード変更が最小限のため

  **Must NOT do**:
  - isTranscriptionTarget 以外のメソッドを変更しない
  - completionStatus を数値に変換しない
  - DeletionWorkflow の判定ロジックを変更しない

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 2行のコード追加 + テストファイル1つ。単純なTDD作業。
  - **Skills**: []
    - Reason: ブラウザ操作やGit操作は不要。純粋なコード編集とテスト実行のみ。

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: None
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):

  **Pattern References**:
  - `src/workflows/transcription/transcription.workflow.ts:146-154` — 修正対象の `isTranscriptionTarget` メソッド。L147 (`if (record.recordLocked) return false;`) の直後に completionStatus チェックを挿入する。
  - `src/workflows/transcription/transcription.workflow.ts:72` — `records.filter(r => this.isTranscriptionTarget(r))` で使用されている。フィルタの呼び出し元。
  - `vitest.config.ts:1-9` — テスト設定。include パターン `src/**/*.test.ts` を確認。

  **API/Type References**:
  - `src/types/spreadsheet.types.ts:28-29` — `completionStatus: string` の型定義。M列に対応。
  - `src/types/spreadsheet.types.ts:1-54` — `TranscriptionRecord` 全フィールド。テストのレコードファクトリ関数で全フィールドをカバーする必要がある。

  **Test References**:
  - `vitest.config.ts` — vitest 設定。`npx vitest run` でテスト実行可能。

  **Acceptance Criteria**:

  **TDD (tests):**
  - [x] テストファイル作成: `src/workflows/transcription/__tests__/transcription-target.test.ts`
  - [x] 11テストケースが全て定義されている
  - [x] `npx vitest run src/workflows/transcription/__tests__/transcription-target.test.ts` → PASS (11 tests, 0 failures)

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: completionStatus フィルタが正しく動作するかテスト実行で検証
    Tool: Bash (npx vitest)
    Preconditions: vitest がインストール済み、テストファイルが作成済み
    Steps:
      1. npx vitest run src/workflows/transcription/__tests__/transcription-target.test.ts
      2. Assert: exit code 0
      3. Assert: stdout contains "11 passed"
      4. Assert: stdout does NOT contain "failed"
    Expected Result: 全11テストが PASS
    Evidence: Terminal output captured

  Scenario: TypeScript コンパイルエラーがないことを確認
    Tool: Bash (npx tsc)
    Preconditions: tsconfig.json が存在
    Steps:
      1. npx tsc --noEmit
      2. Assert: exit code 0 OR no errors related to transcription.workflow.ts
    Expected Result: コンパイルエラーなし
    Evidence: Terminal output captured
  ```

  **Commit**: YES
  - Message: `fix(transcription): completionStatus "1"/空白 を転記対象から除外`
  - Files: `src/workflows/transcription/transcription.workflow.ts`, `src/workflows/transcription/__tests__/transcription-target.test.ts`
  - Pre-commit: `npx vitest run src/workflows/transcription/__tests__/transcription-target.test.ts`

---

- [x] 2. RPA全体仕様書作成

  **What to do**:
  - `docs/rpa-specification.md` を新規作成
  - 以下のセクション構成で、全てコードから抽出した実値に基づいて記述する

  **仕様書構成**:

  ```
  # 転記RPA 全体仕様書

  ## 1. システム概要
  - 目的: Google Sheets の看護記録データをカナミック HAM に自動転記する
  - 実行環境: Node.js + Playwright + Google Sheets API
  - スケジューリング: node-cron による日次実行
  - 対象事業所: 荒田、博多(福岡)、姶良、谷山（4拠点）

  ## 2-1. ログインフロー
  - TRITRUS ポータル → JOSSO SSO → goCicHam.jsp → HAM
  - kanamick-auth.service.ts の login() メソッドの4ステップ詳細
  - リトライ: maxAttempts=2, baseDelay=3000
  - セッション切れ検出と再ログイン（ensureLoggedIn）
  - ダイアログ自動承認（dialog.accept()）
  - venobox ポップアップの自動クローズ

  ## 2-2. HAMフレーム構造
  - Tab 0: TRITRUS portal
  - Tab 1: HAM (www2.kanamic.net)
  - kanamicmain → topFrame + mainFrame (nested framesets)
  - フォーム送信パターン: submited=0 → doAction → lockCheck → commontarget → submit
  - submitTargetFormEx vs submitForm の違い

  ## 2-3. 転記ワークフロー（通常フロー・14ステップ）
  - Step 1-14 の各ステップ詳細
  - 各ステップの sleep 値とページ遷移先
  - Step 4.5: 修正レコードの既存スケジュール削除
  - k2_1 → k2_2 → k2_3 → k2_3a → k2_3b → k2_2 → k2_2f → k2_2 のページ遷移図

  ## 2-4. 転記ワークフロー（I5フロー）
  - 介護+リハビリ → k2_7_1 ページ使用
  - 通常フローとの分岐点（codeResult.useI5Page）
  - k2_7_1 での時間設定とサービス検索
  - 予防/介護の切替判定（PatientMasterService.determineCareType）

  ## 2-5. サービスコード決定ロジック
  - ServiceCodeResolver の全分岐表
  - 医療: showflag=3, servicetype=93, serviceitem=1001
  - 精神医療: showflag=3, servicetype=93, serviceitem=1225
  - 介護: showflag=1, servicetype=13, serviceitem=1111/1121/1114
  - 介護リハビリ: I5ページ使用（コード不要）
  - フラグ組み合わせ表（同行、複数名、緊急、同行事務員）

  ## 2-6. 転記対象判定ロジック
  - isTranscriptionTarget の全条件分岐
  - completionStatus フィルタ: ""と"1"は除外、"2","3","4"が対象
  - transcriptionFlag の各値と判定結果
  - recordLocked の優先判定

  ## 2-7. エラー分類と処理
  - classifyError の全分岐
  - マスタ不備（患者未登録、スタッフ未登録、資格制限）
  - システムエラー（syserror、フレームタイムアウト）
  - ネットワークエラー（タイムアウト、セッション切れ）
  - S列ステータスとU列エラー詳細の書き込み内容
  - エラー後のメインメニュー復帰ロジック（tryRecoverToMainMenu）

  ## 2-8. リトライ戦略
  - withRetry のバックオフ計算式: min(baseDelay * 2^(attempt-1), maxDelay)
  - 転記: maxAttempts=2, baseDelay=3000, maxDelay=15000, backoff=2
  - ログイン: maxAttempts=2, baseDelay=3000
  - 削除: maxAttempts=3, baseDelay=2000, maxDelay=10000, backoff=2
  - デフォルト: maxAttempts=3, baseDelay=1000, maxDelay=30000, backoff=2

  ## 2-9. 処理ペース・負荷情報
  - 1レコードあたりの処理時間推定（sleep合計 + ネットワーク待機）
  - 通常フロー: ~21.5秒（sleep のみ）+ ネットワーク/DOM待機 → 推定30-45秒/レコード
  - I5フロー: より短い（sleep 合計少ない）
  - ページ遷移回数: 通常フロー 8回以上
  - フォーム送信回数: 通常フロー 10回以上
  - 各 sleep() の場所と値の一覧表

  ## 2-10. Google Sheets 操作
  - 読み取り: A2:Y 範囲（月次シート）、A2:M（削除シート）
  - 書き込み: S列（転記フラグ）、U列（エラー詳細）、V列（データ取得日時）
  - 折返表示設定: formatTranscriptionColumns（S列・U列）
  - 月次シートタブ名生成: YYYY年MM月
  - 削除シート: 削除Sheet タブ
  - 修正管理シート: 看護記録修正管理 タブ（CorrectionDetector はデッドコード）

  ## 2-11. 日次ジョブフロー
  - index.ts の runDailyJob の実行順序
  - Step 1: SmartHR スタッフ同期（失敗しても続行）
  - Step 2: 転記ワークフロー
  - Step 3: 削除ワークフロー
  - Step 4: メール通知
  - 防重入ロック（isRunning フラグ）
  - cron スケジュール設定
  - CLI手動実行モード（--workflow=transcription/deletion/building）

  ## 2-12. timetype 計算ルール
  - calcDurationMinutes: 開始-終了の分数計算（日跨ぎ対応）
  - calcTimetype: 20分以下→'20', 30分以下→'30', 60分以下→'60', 90分以下→'90', 91分以上→'91'
  - getTimePeriod: 日中(6-18)→'1', 夜間(18-22)→'2', 深夜(22-6)→'3'
  - 終了時間は HAM 自動値のまま（手動修正しない）
  ```

  **Must NOT do**:
  - 推測値を書かない — 全てコードの実値を参照
  - コードを変更しない — ドキュメント作成のみ
  - 日本語以外で書かない — 全て日本語で記述

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: 純粋なドキュメント作成タスク。ソースコードを読み取り、仕様書に整理する作業。
  - **Skills**: []
    - Reason: ブラウザ操作やGit操作は不要。ファイル読み取りとMarkdown記述のみ。

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: None
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):

  **Pattern References** (仕様書記述のソース):
  - `src/workflows/transcription/transcription.workflow.ts:1-1139` — 転記ワークフロー全体。14ステップの詳細、sleep値、エラー分類、I5フロー。仕様書セクション 2-3, 2-4, 2-6, 2-7 の主要ソース。
  - `src/services/kanamick-auth.service.ts:1-294` — ログインフロー。TRITRUS→JOSSO→HAM の4ステップ。仕様書セクション 2-1 のソース。
  - `src/core/ham-navigator.ts:1-488` — HAMフレーム構造とフォーム送信パターン。仕様書セクション 2-2 のソース。
  - `src/core/retry-manager.ts:1-50` — リトライロジック。バックオフ計算式。仕様書セクション 2-8 のソース。
  - `src/services/time-utils.ts:1-116` — timetype計算、時間帯区分。仕様書セクション 2-12 のソース。
  - `src/services/service-code-resolver.ts:1-228` — サービスコード決定全分岐。仕様書セクション 2-5 のソース。
  - `src/services/spreadsheet.service.ts:1-313` — Google Sheets 操作。読み取り範囲、書き込み列。仕様書セクション 2-10 のソース。
  - `src/index.ts:1-229` — 日次ジョブフロー、cron設定、CLI引数。仕様書セクション 2-11 のソース。
  - `src/workflows/deletion/deletion.workflow.ts:1-109` — 削除ワークフロー。リトライ設定。仕様書セクション 2-8 のソース。
  - `src/types/spreadsheet.types.ts:1-111` — 全レコード型定義。各列の意味。仕様書全体で参照。

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: 仕様書ファイルが存在し、全セクションを含む
    Tool: Bash (file check + grep)
    Preconditions: None
    Steps:
      1. test -f docs/rpa-specification.md
      2. Assert: exit code 0 (ファイルが存在)
      3. grep -c "## 2-1" docs/rpa-specification.md → 1以上
      4. grep -c "## 2-2" docs/rpa-specification.md → 1以上
      5. grep -c "## 2-3" docs/rpa-specification.md → 1以上
      6. grep -c "## 2-4" docs/rpa-specification.md → 1以上
      7. grep -c "## 2-5" docs/rpa-specification.md → 1以上
      8. grep -c "## 2-6" docs/rpa-specification.md → 1以上
      9. grep -c "## 2-7" docs/rpa-specification.md → 1以上
      10. grep -c "## 2-8" docs/rpa-specification.md → 1以上
      11. grep -c "## 2-9" docs/rpa-specification.md → 1以上
      12. grep -c "## 2-10" docs/rpa-specification.md → 1以上
      13. grep -c "## 2-11" docs/rpa-specification.md → 1以上
      14. grep -c "## 2-12" docs/rpa-specification.md → 1以上
    Expected Result: ファイル存在、全12セクションあり
    Evidence: Terminal output captured

  Scenario: 仕様書にコードから抽出した実値が含まれる
    Tool: Bash (grep)
    Preconditions: docs/rpa-specification.md が存在
    Steps:
      1. grep "maxAttempts" docs/rpa-specification.md → 含まれる
      2. grep "baseDelay" docs/rpa-specification.md → 含まれる
      3. grep "syserror" docs/rpa-specification.md → 含まれる
      4. grep "k2_3a" docs/rpa-specification.md → 含まれる
      5. grep "timetype" docs/rpa-specification.md → 含まれる
      6. grep "completionStatus" docs/rpa-specification.md → 含まれる
    Expected Result: 全キーワードが仕様書に含まれる
    Evidence: Terminal output captured
  ```

  **Commit**: YES
  - Message: `docs: RPA全体仕様書を作成（エラー処理、ページ遷移、処理時間等）`
  - Files: `docs/rpa-specification.md`
  - Pre-commit: なし（ドキュメントのみ）

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `fix(transcription): completionStatus "1"/空白 を転記対象から除外` | transcription.workflow.ts, transcription-target.test.ts | npx vitest run |
| 2 | `docs: RPA全体仕様書を作成（エラー処理、ページ遷移、処理時間等）` | docs/rpa-specification.md | grep section headers |

---

## Success Criteria

### Verification Commands
```bash
# Task 1: テスト実行
npx vitest run src/workflows/transcription/__tests__/transcription-target.test.ts
# Expected: 11 passed, 0 failed

# Task 1: 型チェック
npx tsc --noEmit
# Expected: no errors

# Task 2: 仕様書セクション確認
grep -c "## 2-" docs/rpa-specification.md
# Expected: 12
```

### Final Checklist
- [x] completionStatus '' と '1' が転記対象外になっている
- [x] completionStatus '2','3','4' が転記対象のまま
- [x] 全11テストが PASS
- [x] docs/rpa-specification.md が全12セクションを含む
- [x] 仕様書の全数値がコードから抽出した実値
- [x] 他プロジェクトのファイルを変更していない
- [x] CorrectionDetector に触れていない
