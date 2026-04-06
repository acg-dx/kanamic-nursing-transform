# Phase 2: ワークフロー統合 - Context

**Gathered:** 2026-04-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 で構築した検証コア（verify() メソッド + computeVerificationDateRange()）を既存の TranscriptionWorkflow に接続し、各事業所の転記完了直後に自動検証を実行する。検証結果を Google Sheets に記録し、コンソールに構造化ログとして出力する。自動修正（Phase 3）はスコープ外。

</domain>

<decisions>
## Implementation Decisions

### 検証トリガー位置
- **D-01:** 各事業所の processLocation() 完了直後に、その事業所の検証を即時実行する（全事業所一括ではない）。HAMセッションが生きている間にCSVを取得するため、転記直後が最適。
- **D-02:** 検証対象は当月タブの未検証レコードのみ（前月以前は対象外）。シンプルさを優先し、CSV日付範囲も当月に限定する。

### Sheets列配置
- **D-03:** 検証タイムスタンプは AB列(27) に書き込む。検証エラー詳細は AC列(28) に書き込む。AA列(26)は既存の HAM assignId で使用中のため、その直後に配置。
- **D-04:** 検証タイムスタンプの形式は ISOタイムスタンプ（例: "2026-04-06T13:45:00"）。非空であれば検証済みとしてスキップする。
- **D-05:** Sheets データ取得範囲を A2:AC に拡張し、AB/AC列も読み込む。TranscriptionRecord 型に verifiedAt / verificationError フィールドを追加する。

### コンソール報告
- **D-06:** 事業所ごとにサマリー（チェック件数・一致件数・不一致件数・extraInHam件数）を logger.info で出力する。
- **D-07:** 不一致レコードごとに患者名・訪問日・不一致フィールド（time/service/staff）を logger.warn で出力する。一致レコードの詳細は出力しない。
- **D-08:** extraInHam レコードは logger.info で患者名・訪問日のみ出力する（情報レベル）。

### エラー時の継続性
- **D-09:** 検証ステップでエラーが発生した場合（CSVダウンロード失敗、Sheets書き込み失敗等）、logger.warn で警告を記録し、次の事業所の転記は通常通り続行する。検証は補助的なステップであり、転記ワークフローを停止すべきではない。
- **D-10:** 検証エラーが発生した事業所の WorkflowResult には検証スキップの旨を含める。

### Claude's Discretion
- 検証ステップのメソッド名・シグネチャの詳細設計
- processLocation() 内での検証呼び出し位置の具体的な実装
- VerificationResult から Sheets 書き込みへの変換ロジック
- コンソール出力のフォーマット詳細（区切り線、インデントなど）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 転記ワークフロー
- `src/workflows/transcription/transcription.workflow.ts` — processLocation() メソッドが検証統合の対象。L94-440 が事業所処理の全体フロー。WorkflowResult 型で結果を返却。
- `src/workflows/base-workflow.ts` — 抽象基底クラス、タイミングインフラ

### Phase 1 実装済み検証コア
- `src/services/reconciliation.service.ts` — verify() メソッド（L468+）、VerificationMismatch/VerificationResult 型、checkTimeMismatch/checkServiceMismatch/checkStaffMismatch ヘルパー
- `src/services/schedule-csv-downloader.service.ts` — computeVerificationDateRange()、downloadScheduleCsv() with startDay/endDay

### Google Sheets インターフェース
- `src/services/spreadsheet.service.ts` — updateTranscriptionStatus() (L105)、getTranscriptionRecords() (L60)、列定数定義 (L16-31)。AB/AC列追加が必要。

### 型定義
- `src/types/spreadsheet.types.ts` — TranscriptionRecord 型定義。verifiedAt/verificationError フィールド追加が必要。
- `src/types/workflow.types.ts` — WorkflowResult, WorkflowError 型定義

### 設定
- `src/config/app.config.ts` — 事業所定義、SheetLocation 型

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ReconciliationService.verify()` — Phase 1 で構築済み。csvPath + TranscriptionRecord[] → VerificationResult を返す
- `computeVerificationDateRange()` — TranscriptionRecord[] → VerificationDateRange[] を計算
- `ScheduleCsvDownloaderService.downloadScheduleCsv()` — startDay/endDay パラメータで日付範囲CSV取得
- `SpreadsheetService.updateTranscriptionStatus()` — 既存のステータス書き込みパターン。検証ステータスにも同様のメソッドを追加

### Established Patterns
- processLocation() は各事業所の処理を for ループで実行し、WorkflowResult を accumulate
- エラーハンドリングは try-catch + logger.error/warn + errors 配列への追加
- Sheets 列は定数 (COL_XX) で管理、colToLetter() で変換
- 既存の updateTranscriptionStatus() は単純な Google Sheets API 呼び出し

### Integration Points
- processLocation() の return 文（L430）の直前に検証ステップを追加
- SpreadsheetService に COL_VERIFIED_AT(27), COL_VERIFICATION_ERROR(28) 定数を追加
- TranscriptionRecord に verifiedAt, verificationError プロパティを追加
- getTranscriptionRecords() のデータ取得範囲を A2:AC に拡張

</code_context>

<specifics>
## Specific Ideas

- 未検証レコードの定義: TranscriptionRecord.transcriptionFlag === '転記済み' かつ TranscriptionRecord.verifiedAt が空文字列
- 検証成功時: AB列にISOタイムスタンプを書き込み、AC列は空のまま
- 検証失敗（不一致）時: AB列にタイムスタンプを書き込み、AC列に不一致フィールドの要約（例: "time:endTime,service:serviceCode"）
- レコード未存在（missingInHam）時: AB列にタイムスタンプ、AC列に "missing_in_ham"

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-workflow-integration*
*Context gathered: 2026-04-06*
