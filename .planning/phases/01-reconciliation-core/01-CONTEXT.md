# Phase 1: 突合検証コア - Context

**Gathered:** 2026-04-06
**Status:** Ready for planning

<domain>
## Phase Boundary

8-1 CSVダウンロード機能を拡張し、5つの突合検証チェック（存在性・時間・サービス・スタッフ・extraInHam）を実行する検証ロジックを、既存ReconciliationServiceの拡張として構築する。ワークフロー統合（Phase 2）やステータス管理（Phase 2）、自動修正（Phase 3）はこのフェーズのスコープ外。

</domain>

<decisions>
## Implementation Decisions

### CSV下載策略
- **D-01:** CSV下載範囲は未検証レコードの日付範囲で決定する。ScheduleCsvDownloaderServiceを拡張し、開始日・終了日をパラメータで指定可能にする（現在は整月のみ対応）。
- **D-02:** CSVは毎回強制再ダウンロードする（キャッシュ不使用）。転記直後の最新データを取得するため、force=trueを常用する。

### 突合比較の深さ
- **D-03:** 時間一致性は完全一致（開始時刻・終了時刻とも完全マッチ）。誤差許容なし。
- **D-04:** サービス内容はサービス種類（介護/医療）とサービスコードの両方を比較する。
- **D-05:** スタッフ配置はCJK正規化後の姓名一致 + 准看護師/看護師資質の一致を検証する。

### 検証結果データ構造
- **D-06:** 不一致はレコード単位で集約する。1レコードに複数種類の不一致がある場合、1つのオブジェクトに全mismatchフィールドを含める（タイプ別分類ではなくレコード聚合方式）。
- **D-07:** 既存ReconciliationServiceを拡張して検証ロジックを追加する（新サービス作成ではない）。parseScheduleCsv()、normalizeCjkName()、mergeRehabSegments()などの既存ユーティリティを再利用する。

### リハビリ統合処理
- **D-08:** リハビリ（I5訪看Ⅰ５）は既存のmergeRehabSegments()で統合後にSheetsと比較する。段数チェックは行わない。

### Claude's Discretion
- エラーハンドリング（CSV下載失敗、Sheets読取エラー等）の具体的な実装方式
- 検証結果型のフィールド名・構造の詳細設計
- テスト患者・月次加算レコードのフィルタリング（既存パターンに準拠）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 既存突合ロジック
- `src/services/reconciliation.service.ts` — 現在のCSV↔Sheets突合エンジン。parseScheduleCsv(), reconcile(), mergeRehabSegments(), normalizeCjkName()が主要メソッド
- `src/services/schedule-csv-downloader.service.ts` — 8-1 CSVダウンロードサービス。ensureScheduleCsv(), downloadScheduleCsv()が拡張対象

### データ型定義
- `src/types/workflow.types.ts` — WorkflowResult, TranscriptionStatusなどの既存型定義

### Google Sheetsインターフェース
- `src/services/spreadsheet.service.ts` — Sheets読み書き抽象。getLocationRows(), updateTranscriptionStatus()等

### 認証・ナビゲーション
- `src/services/kanamick-auth.service.ts` — HAMセッション管理。CSV下載は同一セッション内で実行

### 既存突合スクリプト（参考パターン）
- `src/scripts/run-full-reconciliation.ts` — 日付範囲分割ダウンロード + 突合の実装パターン
- `src/scripts/run-march-audit.ts` — 8カテゴリ監査の包括的パターン

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ReconciliationService.parseScheduleCsv()` — Shift-JIS CSV解析、自動カラム検出
- `ReconciliationService.reconcile()` — 存在性チェック + 准看護師資格チェックの基盤
- `ReconciliationService.mergeRehabSegments()` — I5リハビリ20分セグメント統合
- `normalizeCjkName()` — CJK異体字正規化（髙→高等）
- `ScheduleCsvDownloaderService` — HAM 8-1 CSV自動ダウンロード（日付範囲拡張必要）
- `SpreadsheetService.getLocationRows()` — 事業所別データ取得

### Established Patterns
- ReconciliationService: matchキー = `patientName|visitDate|startTime`
- CSV解析: TextDecoder('shift-jis') + 正規表現ベースヘッダー検出
- フィルタリング: テスト患者（青空/練習/テスト）・月次加算（12:00-12:00）・超減算を除外

### Integration Points
- `ScheduleCsvDownloaderService.downloadScheduleCsv()` — startDate/endDateパラメータ拡張
- `ReconciliationService.reconcile()` — 戻り値型にフィールド別mismatch情報を追加
- 検証結果型は Phase 2 のステータス管理・Phase 3 の自動修正が消費する

</code_context>

<specifics>
## Specific Ideas

- 未検証レコードの定義: Sheetsのステータスが「転記済み」かつ検証タイムスタンプが空のレコード
- CSV下載の日付範囲: 未検証レコードの最小visitDate〜最大visitDateを計算して使用
- 検証結果はPhase 2でコンソール出力、Phase 3で自動修正に使用されるため、actionableなインターフェースが必要

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-reconciliation-core*
*Context gathered: 2026-04-06*
