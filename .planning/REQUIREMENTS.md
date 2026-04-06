# Requirements: 転記後自動検証システム

**Defined:** 2026-04-06
**Core Value:** 転記済みと記録されたすべてのレコードが、HAM上でも正確に登録されていることを保証する

## v1 Requirements

### 検証トリガー (Verification Trigger)

- [ ] **VER-01**: 各事業所の転記完了後、自動で検証ステップを実行する
- [ ] **VER-02**: 検証対象は「転記済み」かつ「未検証」の全レコード（日数制限なし）

### CSV取得 (CSV Download)

- [ ] **CSV-01**: 転記と同一HAMセッション内で8-1 CSVをダウンロードする
- [ ] **CSV-02**: 未検証レコードの日付範囲に基づいてCSVダウンロード範囲を決定する

### 突合検証 (Reconciliation Checks)

- [ ] **REC-01**: レコード存在性 — Sheets「転記済み」がHAM CSVに存在するか確認
- [ ] **REC-02**: 時間一致性 — 訪問日・開始時刻・終了時刻の一致を確認
- [ ] **REC-03**: サービス内容 — サービス種類・コードの一致を確認
- [ ] **REC-04**: スタッフ配置 — 配置スタッフの一致を確認
- [ ] **REC-05**: extraInHam検出 — HAMに存在するがSheetsにないレコードを検出

### 自動修正 (Auto-Correction)

- [ ] **FIX-01**: 不一致レコードをDeletionWorkflow経由で削除する
- [ ] **FIX-02**: 削除後に対象レコードを再転記する
- [ ] **FIX-03**: 再転記後に再度検証を実行し、修正を確認する

### ステータス管理 (Status Management)

- [ ] **STS-01**: 検証済みレコードにフラグ/タイムスタンプを記録する
- [ ] **STS-02**: 検証エラーのレコードにエラー詳細を記録する

### レポート (Reporting)

- [ ] **RPT-01**: 検証結果をコンソールに構造化ログとして出力する

## v2 Requirements

### 通知 (Notifications)

- **NTF-01**: 検証エラー発生時にSlack/メール通知を送信する
- **NTF-02**: 日次検証サマリーを関係者に通知する

### レポート拡張 (Extended Reporting)

- **RPT-02**: 検証結果をGoogle Sheetsの専用タブに書き出す
- **RPT-03**: 月次検証統計レポートを自動生成する

## Out of Scope

| Feature | Reason |
|---------|--------|
| 月次監査レポート改修 | 既存のrun-march-auditで対応可能 |
| Google Sheets UIへの検証結果書き込み | コンソールログで十分（v2で検討） |
| 手動トリガーの独立スクリプト | ワークフロー自動実行のみでシンプルに |
| リアルタイム検証（レコード単位） | 事業所単位のバッチ検証で十分な精度 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| (populated by roadmapper) | | |

**Coverage:**
- v1 requirements: 16 total
- Mapped to phases: 0
- Unmapped: 16

---
*Requirements defined: 2026-04-06*
*Last updated: 2026-04-06 after initial definition*
