# Phase 1: 突合検証コア - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-06
**Phase:** 01-突合検証コア
**Areas discussed:** CSV下載策略, 突合比較の深さ, 検証結果データ構造, リハビリ統合処理

---

## CSV下載策略

### Q1: CSV下載の日付範囲

| Option | Description | Selected |
|--------|-------------|----------|
| 整月一括下載 | 復用現有ロジック、整月CSV下載後メモリでフィルタリング | |
| 按未検証日期範囲 | 未検証レコードの最早/最晩日付を計算し、その範囲のみ下載 | ✓ |
| Claude決定 | 技術的実現難易度でClaude判断 | |

**User's choice:** 按未検証日期範囲
**Notes:** ScheduleCsvDownloaderServiceを拡張して開始日・終了日パラメータ対応が必要

### Q2: CSVキャッシュ

| Option | Description | Selected |
|--------|-------------|----------|
| 毎回強制再下載 | 最新データ保証、下載時間増 | ✓ |
| 同一セッション内キャッシュ | 同一実行の複数事業所で共有 | |
| Claude決定 | Claude判断に委任 | |

**User's choice:** 毎回強制再下載
**Notes:** 転記直後の最新データ取得が最優先

---

## 突合比較の深さ

### Q3: 時間一致性判定

| Option | Description | Selected |
|--------|-------------|----------|
| 完全一致 | 開始・終了時刻とも完全マッチ | ✓ |
| 5分誤差許容 | 開始/終了時刻に±5分偏差を許容 | |
| 開始時刻のみ | 終了時刻は比較しない | |

**User's choice:** 完全一致
**Notes:** 最も厳格な基準を採用

### Q4: サービス内容比較粒度

| Option | Description | Selected |
|--------|-------------|----------|
| サービス種類+コード | 介護/医療区分 + 具体的サービスコード両方 | ✓ |
| サービス種類のみ | 介護/医療区分のみ確認 | |
| Claude決定 | 既存コードベースで最適な粒度を判断 | |

**User's choice:** サービス種類+コード

### Q5: スタッフ配置比較

| Option | Description | Selected |
|--------|-------------|----------|
| 姓名完全一致 | CJK正規化後の姓名マッチ | |
| 姓名+資質 | 姓名一致 + 准看護師/看護師資質一致 | ✓ |
| Claude決定 | 既存コードベースで最適な粒度を判断 | |

**User's choice:** 姓名+資質

---

## 検証結果データ構造

### Q6: 不一致分類方式

| Option | Description | Selected |
|--------|-------------|----------|
| 不一致タイプ別 | missing/extra/timeMismatch/serviceMismatch/staffMismatch別配列 | |
| レコード聚合 | 各レコード1オブジェクト、全mismatchフィールド含む | ✓ |
| Claude決定 | Phase 3自動修正ニーズに基づき最適構造を設計 | |

**User's choice:** レコード聚合

### Q7: ReconciliationServiceとの関係

| Option | Description | Selected |
|--------|-------------|----------|
| 既存サービス拡張 | ReconciliationServiceに新メソッド追加 | ✓ |
| 新サービス作成 | VerificationService新規作成、内部でReconciliationService呼出 | |
| Claude決定 | アーキテクチャパターンで最適方式を選択 | |

**User's choice:** 既存サービス拡張

---

## リハビリ統合処理

### Q8: リハビリ検証策略

| Option | Description | Selected |
|--------|-------------|----------|
| 統合後比較 | 既存mergeRehabSegments()で統合後にSheets比較 | ✓ |
| 統合+段数チェック | 統合後比較 + 段数と時間長の整合性チェック | |
| Claude決定 | 既存コードで最合理的方式を選択 | |

**User's choice:** 統合後比較

---

## Claude's Discretion

- エラーハンドリングの実装方式
- 検証結果型のフィールド名・構造詳細
- テスト患者・月次加算のフィルタリング規則

## Deferred Ideas

None — discussion stayed within phase scope
