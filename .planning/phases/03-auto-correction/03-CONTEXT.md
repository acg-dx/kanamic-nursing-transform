# Phase 3: 自動修正 - Context

**Gathered:** 2026-04-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 2 の検証で検出された不一致レコードを自動修正する。不一致タイプに応じて DeletionWorkflow 経由の削除 + 専用メソッドによる再転記を行い、修正後に再検証を実行して修正成功/失敗を確認する。修正は1サイクルのみ実行し、再検証でまだ不一致なら手動エラーとして記録する。

</domain>

<decisions>
## Implementation Decisions

### 修正トリガー
- **D-01:** 検証直後に即時修正を実行する。同一 processLocation() 内で 検証→削除→再転記→再検証 まで完結させる。HAMセッションが生きている間に全て完了。
- **D-02:** 修正後の再検証は同一実行内で行う。再度 verify() を呼び出し、修正成功/失敗を Sheets と コンソールに記録。

### 削除対象の決定
- **D-03:** 全不一致タイプが修正対象。time/service/staff 不一致は「HAM上のレコードを削除→再転記」で修正。
- **D-04:** missingInHam（SheetsにあるがHAMにない）は削除不要。T列ステータスを「未転記」にリセットし、既存の転記ルートで再転記する。assignId もクリアする。
- **D-05:** extraInHam（HAMにあるがSheetsにない）は自動修正の対象外。情報として記録するのみ。

### 再転記の仕組み
- **D-06:** 対象レコードIDを指定して転記を直接実行する専用メソッドを作成する。既存 processLocation() の転記ループとは別のパスで、指定レコードのみを処理する。
- **D-07:** 削除完了後、対象レコードの T列を「未転記」に、AB列（検証タイムスタンプ）とAC列（検証エラー）をクリアしてから再転記を実行。

### リトライ制限
- **D-08:** 自動修正は1サイクルのみ（削除→再転記→再検証を1回だけ実行）。再検証でまだ不一致が残る場合はエラーとして Sheets AC列に記録し、手動対応に委ねる。無限ループは発生しない。
- **D-09:** 修正サイクル内で例外が発生した場合（削除失敗、再転記失敗等）、そのレコードをエラーとして記録し、残りの不一致レコードの修正は続行する。

### Claude's Discretion
- 修正メソッドの名前・シグネチャ
- DeletionWorkflow の呼び出し方法（クラスインスタンスを直接使うか、processRecord を呼ぶか）
- 再転記メソッドの内部実装（既存の transcribeSingleRecord を抽出・再利用するか、新メソッドを作るか）
- 修正結果のコンソール出力フォーマット

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 削除ワークフロー
- `src/workflows/deletion/deletion.workflow.ts` — DeletionWorkflow.processRecord() が1レコード削除の実装。assignId ベースの精密削除とフォールバック（日時マッチ）をサポート。
- `src/workflows/deletion/deletion.workflow.ts` L197-235 — processRecord() のシグネチャと削除ステップ

### 転記ワークフロー
- `src/workflows/transcription/transcription.workflow.ts` — processLocation() 内の転記ループ（L260-430付近）。単一レコードの転記ロジック。Phase 2 で追加した runVerification() も含む。

### Phase 1/2 検証コア
- `src/services/reconciliation.service.ts` — verify() メソッド、VerificationMismatch/VerificationResult 型
- `src/services/schedule-csv-downloader.service.ts` — computeVerificationDateRange(), downloadScheduleCsv()

### Sheets インターフェース
- `src/services/spreadsheet.service.ts` — updateTranscriptionStatus() (T列書き込み), writeVerificationStatus() (AB/AC列書き込み), COL_VERIFIED_AT=27, COL_VERIFICATION_ERROR=28

### 型定義
- `src/types/spreadsheet.types.ts` — TranscriptionRecord（verifiedAt, verificationError フィールド含む）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `DeletionWorkflow.processRecord()` — 1レコード削除の既存実装。assignId ベースで動作。
- `TranscriptionWorkflow` の転記ロジック — 単一レコードの14ステップ転記処理
- `SpreadsheetService.updateTranscriptionStatus()` — T列ステータス書き込み
- `SpreadsheetService.writeVerificationStatus()` — AB/AC列書き込み（Phase 2で追加済み）
- `ReconciliationService.verify()` — 再検証に再利用
- `TranscriptionRecord.hamAssignId` — AA列の assignId（削除に使用）

### Established Patterns
- processLocation() 内での検証→修正フロー（Phase 2 の runVerification() パターンに追加）
- try-catch + logger.warn でエラーをキャッチしワークフロー続行
- WorkflowResult.errors 配列にエラーを蓄積

### Integration Points
- Phase 2 の runVerification() の戻り値（VerificationResult）から mismatches/missingInHam を読み取り
- 修正対象レコードの特定: VerificationMismatch[] + missingInHam
- 削除: DeletionWorkflow の processRecord() または同等のロジック
- 再転記: TranscriptionWorkflow 内の既存転記ロジックの一部を再利用
- ステータスリセット: updateTranscriptionStatus() で T列を「未転記」に

</code_context>

<specifics>
## Specific Ideas

- 修正フロー: runVerification() → mismatches あり → runAutoCorrection() → 削除+再転記 → runVerification() (再検証) → 結果記録
- missingInHam の処理: 削除スキップ → T列リセット → 再転記 → 再検証
- time/service/staff 不一致の処理: assignId で HAM 削除 → T列リセット → 再転記 → 再検証
- 再検証後もまだ不一致: AC列に "auto_correction_failed: {reason}" を記録

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-auto-correction*
*Context gathered: 2026-04-06*
