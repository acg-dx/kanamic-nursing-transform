## [2026-02-27] Task: completion-status-filter-and-spec

### Task 1: completionStatus フィルタ追加

**実装パターン**:
- `isTranscriptionTarget` は純粋関数（record のみ依存）→ `null as any` でコンストラクタをモック可能
- vitest テストは `src/**/*.test.ts` パターンで自動検出される
- `__tests__` ディレクトリは手動作成が必要（`mkdir -p` で作成）

**型の注意点**:
- `completionStatus` は `string` 型（数値ではない）→ `=== ''` と `=== '1'` で文字列比較
- `SpreadsheetService` が `row[COL_M] || ''` でデフォルト化済み → 空文字チェックは確実に機能する

**既存の型エラー**:
- `src/scripts/` 配下に既存の型エラーあり（`Element` に `name`/`value` プロパティなし）
- これらは今回の変更とは無関係の既存問題 → `npx tsc --noEmit 2>&1 | grep -v "src/scripts/"` で確認

### Task 2: RPA全体仕様書

**仕様書作成のポイント**:
- sleep 合計: 通常フロー最小 16,000ms（starttype変更なし、従業員リスト即時）
- starttype 変更時: +3,000ms = 19,000ms
- 修正レコード（Step 4.5）: +4,000ms
- I5フロー: 7,500ms（大幅に短い）

**コードから抽出した重要な実値**:
- 転記リトライ: maxAttempts=2, baseDelay=3000, maxDelay=15000
- ログインリトライ: maxAttempts=2, baseDelay=3000
- 削除リトライ: maxAttempts=3, baseDelay=2000, maxDelay=10000
- waitForMainFrame ポーリング: 300ms間隔、デフォルトタイムアウト 15000ms
- setSelectValue ポーリング: 最大15回 × 500ms

### コミット情報
- `8382798`: fix(transcription): completionStatus "1"/空白 を転記対象から除外
- `e9e96d1`: docs: RPA全体仕様書を作成（エラー処理、ページ遷移、処理時間等）
