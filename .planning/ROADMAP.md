# Roadmap: 転記後自動検証システム

## Overview

既存のHAM転記RPAシステムに、転記後の自動検証レイヤーを段階的に追加する。まず8-1 CSV突合の検証コアを構築し（Phase 1）、それを転記ワークフローに統合してステータス管理と報告を実装し（Phase 2）、最後に不一致レコードの自動削除+再転記による自動修正を実現する（Phase 3）。

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: 突合検証コア** - 転記と同一セッションで8-1 CSVをダウンロードし、5つの検証チェックを実行する独立したサービスを構築する
- [ ] **Phase 2: ワークフロー統合** - 検証コアを転記ワークフローに接続し、検証ステータス管理とコンソール報告を実装する
- [ ] **Phase 3: 自動修正** - 不一致レコードをDeletionWorkflow経由で削除し、再転記+再検証を実行する

## Phase Details

### Phase 1: 突合検証コア
**Goal**: 8-1 CSVダウンロード機能と5つの突合検証チェックが、既存ワークフローとは独立して動作する
**Depends on**: Nothing (first phase)
**Requirements**: CSV-01, CSV-02, REC-01, REC-02, REC-03, REC-04, REC-05
**Success Criteria** (what must be TRUE):
  1. 転記と同一HAMセッション内で8-1 CSVをダウンロードでき、再認証は発生しない
  2. 未検証レコードの日付範囲を計算し、その範囲のCSVのみ取得する
  3. Sheets「転記済み」レコードのうちCSVに存在しないものを検出できる（REC-01）
  4. 訪問日・開始時刻・終了時刻の不一致、サービス種類・コードの不一致、スタッフ配置の不一致をそれぞれ個別に検出できる（REC-02, REC-03, REC-04）
  5. HAMに存在するがSheetsにないレコード（extraInHam）を検出・一覧できる（REC-05）
**Plans**: TBD

### Phase 2: ワークフロー統合
**Goal**: 各事業所の転記完了直後に自動で検証が実行され、検証結果がSheetsに記録されコンソールに出力される
**Depends on**: Phase 1
**Requirements**: VER-01, VER-02, STS-01, STS-02, RPT-01
**Success Criteria** (what must be TRUE):
  1. 各事業所の転記ワークフロー完了後、自動で検証ステップが起動する（手動トリガー不要）
  2. 「転記済み」かつ「未検証」のレコードが日数制限なく全件チェックされる
  3. 検証済みレコードにはタイムスタンプが書き込まれ、次回実行でスキップされる
  4. エラーレコードにはエラー詳細（不一致フィールド・期待値・実際値）がSheetsに記録される
  5. 検証完了後、事業所ごとに「チェック件数・一致件数・不一致件数・extraInHam件数」がコンソールに出力される
**Plans**: TBD

### Phase 3: 自動修正
**Goal**: 不一致が確認されたレコードが自動的に削除・再転記・再検証され、手動介入なしに修正が完了する
**Depends on**: Phase 2
**Requirements**: FIX-01, FIX-02, FIX-03
**Success Criteria** (what must be TRUE):
  1. 不一致が確認されたレコードがDeletionWorkflow経由でHAMから削除される（手動削除は発生しない）
  2. 削除後、対象レコードが自動で再転記される（既存のTranscriptionWorkflowを再利用）
  3. 再転記後に再度検証が実行され、修正成功/失敗の結果がコンソールとSheetsに記録される
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. 突合検証コア | 0/? | Not started | - |
| 2. ワークフロー統合 | 0/? | Not started | - |
| 3. 自動修正 | 0/? | Not started | - |
