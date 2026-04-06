# Phase 3: 自動修正 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.

**Date:** 2026-04-06
**Phase:** 03-auto-correction
**Areas discussed:** 修正トリガー, 削除対象の決定, 再転記の仕組み, リトライ制限

---

## 修正トリガー

| Option | Description | Selected |
|--------|-------------|----------|
| 検証直後に即時修正 | 同一processLocation()内で検証→削除→再転記→再検証まで完結 | ✓ |
| 別ワークフロー実行で修正 | 削除Sheetに登録し次回DeletionWorkflow実行で削除 | |

**User's choice:** 検証直後に即時修正

| Option | Description | Selected |
|--------|-------------|----------|
| 同一実行内で再検証 | 削除+再転記後にもう一度verify()を実行 | ✓ |
| 次回実行時に検証 | 修正後の検証は次回の転記ワークフロー実行時に行う | |

**User's choice:** 同一実行内で再検証

---

## 削除対象の決定

| Option | Description | Selected |
|--------|-------------|----------|
| time/service/staff不一致のみ | HAMにレコードが存在するが内容が違う場合のみ | |
| 全不一致タイプ | missingInHamも含めて全て修正対象 | ✓ |
| Claudeに任せる | 各不一致タイプの技術的制約から判断 | |

**User's choice:** 全不一致タイプ

| Option | Description | Selected |
|--------|-------------|----------|
| 再転記のみ | HAMに存在しないので削除不要、ステータスリセットして再転記 | ✓ |
| エラー記録のみ | エラーとして記録するが自動修正はしない | |

**User's choice:** missingInHam は再転記のみ（削除不要）

---

## 再転記の仕組み

| Option | Description | Selected |
|--------|-------------|----------|
| ステータスリセット+既存転記ループ再利用 | T列を「未転記」にリセットし既存のprocessLocation()転記ループが拾う | |
| 専用の再転記メソッド | 対象レコードIDを指定して転記を直接実行する専用メソッド | ✓ |

**User's choice:** 専用の再転記メソッド

---

## リトライ制限

| Option | Description | Selected |
|--------|-------------|----------|
| 1回のみ | 削除→再転記→再検証を1サイクルのみ | ✓ |
| 2回まで | 最大2回の修正サイクル | |
| Claudeに任せる | 技術的な制約から最適な回数を判断 | |

**User's choice:** 1回のみ

---

## Claude's Discretion

- 修正メソッドの名前・シグネチャ
- DeletionWorkflow の呼び出し方法
- 再転記メソッドの内部実装
- 修正結果のコンソール出力フォーマット

## Deferred Ideas

None
