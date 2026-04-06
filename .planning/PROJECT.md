# 転記後自動検証システム (Post-Transcription Verification)

## What This Is

HAM転記RPA（実績登録自動化システム）に転記後の自動検証ステップを追加する。転記完了後、8-1 CSVデータをダウンロードし、Google Sheetsの「転記済み」レコードと突合して、登録データの正確性を自動確認する。不一致があれば自動で削除・再転記を行う。

## Core Value

転記済みと記録されたすべてのレコードが、HAM上でも正確に登録されていることを保証する。

## Requirements

### Validated

- ✓ HAM実績転記（14ステップ自動入力） — existing
- ✓ Google Sheets読み書き（SpreadsheetService） — existing
- ✓ HAM 8-1 CSVダウンロード・パース — existing
- ✓ CSV↔Sheets突合（ReconciliationService） — existing
- ✓ HAM実績削除（DeletionWorkflow） — existing
- ✓ 事業所単位のワークフロー処理 — existing
- ✓ エラー分類・ステータス管理 — existing
- ✓ Kanamickセッション管理・認証 — existing

### Active

- [ ] 転記後自動検証: 各事業所の転記完了後に自動で8-1 CSV突合を実行
- [ ] 未検証レコード全件チェック: 転記済みだが未検証のレコードを日付制限なく全件検査
- [ ] 記録存在性検証: Sheetsで転記済みのレコードがHAM CSVに存在するか確認
- [ ] 時間一致性検証: 訪問日・開始時刻・終了時刻の一致を確認
- [ ] サービス内容検証: サービス種類（介護/医療）・サービスコードの一致を確認
- [ ] スタッフ配置検証: 配置されたスタッフがシート上のデータと一致するか確認
- [ ] extraInHam検出: HAMに存在するがSheetsにないレコードを検出・報告
- [ ] 自動修正: 不一致レコードをDeletionWorkflow経由で削除し、再転記を実行
- [ ] 検証ステータス管理: 検証済み/未検証のフラグをSheetsに記録
- [ ] コンソールログ報告: 検証結果を構造化されたコンソール出力で報告

### Out of Scope

- 月次監査レポートの改修 — 既存のrun-march-auditで対応可能
- Google Sheets UIへの検証結果書き込み — コンソールログで十分
- メール/Slack通知 — 現時点では不要
- 手動トリガーの独立スクリプト — ワークフロー自動実行のみ

## Context

**既存システムの課題:**
転記ワークフローは14ステップでHAMに登録後、Sheetsに「転記済み」を記録するが、HAM側の実際のデータ永続化を検証していない。HAM保存ボタンクリック後3秒スリープ+UIエラー検出のみで、CSVレベルでの突合は行われていない。

**歴史的な問題の証拠:**
`src/scripts/`に45以上のcheck/verify/fixスクリプトが存在。これは転記後検証の不在が原因で、手動監査で事後的に問題を発見・修正してきたことを示す。

**既存の突合基盤:**
ReconciliationServiceがCSV↔Sheets突合の主要ロジックを提供済み。患者名CJK正規化、リハビリセグメント統合、テスト患者フィルタリングなどの成熟した処理が含まれる。

**ブラウンフィールド:**
TypeScript + Playwright + Google Sheets APIベースの成熟したRPAシステム。新機能は既存のワークフロー・サービス・コアパターンに統合する形で実装する。

## Constraints

- **Architecture**: 既存のワークフロー・サービス層のパターンに準拠すること
- **HAM Session**: 転記と同一セッション内で8-1 CSVダウンロードを行う（再認証不要）
- **Performance**: 各事業所の検証は追加5-10分以内に完了すること
- **Safety**: 自動削除+再転記は、明確な不一致が確認された場合のみ実行
- **CSV Download**: HAM 8-1画面から当日日期範囲のCSVをダウンロード

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 事業所単位で検証実行 | 転記後即座にフィードバック可能、問題の早期検出 | — Pending |
| 未検証レコード全件チェック | 日数制限なしで最も確実、失敗した日の補完も自動 | — Pending |
| 自動削除+再転記 | 手動介入なしで問題を自動修正、運用負荷軽減 | — Pending |
| DeletionWorkflow再利用 | 既存の削除ロジックを活用、新規開発リスク低減 | — Pending |
| コンソールログ報告 | シンプルで十分、将来的に通知チャネル追加可能 | — Pending |
| ReconciliationService拡張 | 既存の突合ロジックをベースに拡張、重複開発回避 | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check -- still the right priority?
3. Audit Out of Scope -- reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-06 after initialization*
