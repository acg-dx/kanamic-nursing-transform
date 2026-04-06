# Phase 2: ワークフロー統合 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-06
**Phase:** 02-workflow-integration
**Areas discussed:** 検証トリガー位置, Sheets列配置, コンソール報告粒度, エラー時の継続性

---

## 検証トリガー位置

| Option | Description | Selected |
|--------|-------------|----------|
| 事業所単位即時検証 | processLocation()完了直後にその事業所の検証を実行 | ✓ |
| 全事業所完了後一括検証 | 全事業所の転記完了後にまとめて検証 | |
| Claudeに任せる | 技術的な制約とコードパターンから最適な実装を判断 | |

**User's choice:** 事業所単位即時検証
**Notes:** HAMセッションが生きている間にCSVを取得するため、転記直後が最適

| Option | Description | Selected |
|--------|-------------|----------|
| 当月+前月 | 現在の転記ワークフローと同様に当月タブと前月タブの両方をチェック | |
| 当月のみ | 当月タブの未検証レコードのみ | ✓ |
| 全期間 | 日付制限なく未検証レコードを全件チェック | |

**User's choice:** 当月のみ

---

## Sheets列配置

| Option | Description | Selected |
|--------|-------------|----------|
| 新規列追加 (AB+AC) | AB(27)=検証タイムスタンプ、AC(28)=検証エラー詳細 | ✓ |
| 既存V列に追記 | 既存のエラー詳細V列に検証結果も追記 | |
| Claudeに任せる | 既存の列レイアウトを分析して最適な配置を判断 | |

**User's choice:** AB列+AC列
**Notes:** AA列は既にHAM assignIdで使用中。その直後のAB/ACに配置。

| Option | Description | Selected |
|--------|-------------|----------|
| ISOタイムスタンプ | "2026-04-06T13:45:00" 形式 | ✓ |
| ブール値 | TRUE/FALSE | |

**User's choice:** ISOタイムスタンプ

---

## コンソール報告粒度

| Option | Description | Selected |
|--------|-------------|----------|
| サマリー+不一致一覧 | 件数サマリー + 不一致レコードごとの詳細 | ✓ |
| 件数サマリーのみ | カウントのみ | |
| フル詳細 | 全フィールドの期待値と実際値を各レコードに出力 | |

**User's choice:** サマリー+不一致一覧

---

## エラー時の継続性

| Option | Description | Selected |
|--------|-------------|----------|
| 検証失敗は警告のみ | 検証エラーをログに警告として記録し、次の事業所の転記は通常通り続行 | ✓ |
| 検証失敗でワークフロー停止 | 検証が失敗したら以降の事業所処理を中止 | |

**User's choice:** 検証失敗は警告のみ
**Notes:** 検証は補助的なステップであり、転記ワークフローを停止すべきではない

---

## Claude's Discretion

- 検証ステップのメソッド名・シグネチャ
- processLocation() 内の具体的な呼び出し位置
- VerificationResult → Sheets書き込みの変換ロジック
- コンソール出力のフォーマット詳細

## Deferred Ideas

None
