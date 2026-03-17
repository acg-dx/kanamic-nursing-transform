# 転記RPA 全体仕様書

最終更新: 2026-03-16  
対象バージョン: コードベース現状（`git log --oneline -1` 参照）

---

## 1. システム概要

### 目的
Google Sheets に蓄積された訪問看護記録データを、カナミック HAM（Healthcare Administration Manager）に自動転記する RPA システム。

### 実行環境
- **ランタイム**: Node.js
- **ブラウザ自動化**: Playwright
- **スプレッドシート**: Google Sheets API v4（googleapis）
- **スケジューリング**: node-cron

### 対象事業所
`src/config/app.config.ts` の `locations` に4拠点が定義されている（谷山・荒田・博多・姶良）。

環境変数 `RUN_LOCATIONS` で処理対象をフィルタ:
- **現在の本番設定: `RUN_LOCATIONS=姶良`（姶良のみ処理）**
- `RUN_LOCATIONS=姶良,谷山`: 複数指定も可能
- 未設定: 全4事業所を処理（本番では使用していない）

### ワークフロー種別
| ワークフロー | 説明 | 実行タイミング |
|------------|------|--------------|
| transcription | 月次シートの看護記録を HAM に転記 | 日次 cron |
| deletion | 削除シートのレコードを HAM から削除 | 日次 cron |
| building | 同一建物管理シートの更新 | 別 cron |

### 手動実行
```bash
node dist/index.js --workflow=transcription
node dist/index.js --workflow=deletion
node dist/index.js --workflow=building
```

---

## 2-1. ログインフロー

**ソース**: `src/services/kanamick-auth.service.ts`

### フロー概要
```
TRITRUS ポータル → JOSSO SSO ログイン → マイページ → goCicHam.jsp → HAM
```

### 詳細ステップ

**Step 1: JOSSO SSO ログイン**
- URL: `config.kanamick.url`（TRITRUS ポータル）→ `https://bi.kanamic.net/josso/signon/login.do` にリダイレクト
- セレクタ:
  - ユーザー名: `#josso_username`
  - パスワード: `#josso_password`
  - ログインボタン: `input.submit-button[type="button"]`
- `waitForLoadState('networkidle', { timeout: 15000 })`
- sleep: 2000ms

**Step 2: マイページから HAM リンク検索**
- `a[href*="goCicHam.jsp"][href*="h={hamOfficeCode}"][href*="k={hamOfficeKey}"]`
- hamOfficeKey デフォルト: `6`（HAM直接アクセス）
- hamOfficeCode デフォルト: `400021814`（姶良）
- フォールバック1: 訪問看護フィルタ適用（`searchServiceTypeText` = `4`）
- フォールバック2: 事業所名の部分一致（姶良/荒田/谷山/福岡）

**Step 3: goCicHam.jsp クリック → 新タブ**
- `context.waitForEvent('page', { timeout: 15000 })`
- `hamPage.waitForURL('**/kanamic/ham/**', { timeout: 30000 })`
- ダイアログ自動承認: `hamPage.on('dialog', dialog => dialog.accept())`
- sleep: 2000ms（フレーム構造安定待ち）

**Step 4: venobox ポップアップクローズ**
- セレクタ: `div.vbox-close`
- sleep: 500ms

### リトライ設定
```
maxAttempts: 2
baseDelay: 3000ms
```

### セッション管理（ensureLoggedIn）
- `isLoggedIn` フラグで管理
- HAM ページ URL に `login` / `expired` / `about:blank` が含まれる場合は再ログイン
- ページアクセスエラー時も再ログイン

---

## 2-2. HAMフレーム構造とフォーム送信パターン

**ソース**: `src/core/ham-navigator.ts`

### フレーム構造
```
Tab 0: TRITRUS ポータル (https://portal.kanamic.net/tritrus/index/)
Tab 1: HAM (https://www2.kanamic.net/kanamic/ham/hamfromout.go)
  └── frame "kanamicmain" → k2_X_right.jsp
      ├── frame "topFrame" → k2_X_top.jsp (ヘッダー)
      └── frame "mainFrame" → goPageAction.go?pageId=k2_X (全操作対象)
```

### getMainFrame() の検索優先順位
1. `pageId` 指定あり: URL に `pageId={pageId}` を含むフレーム
2. `goPageAction.go` を含むフレーム
3. `Action.go` を含むフレーム（`hamfromout` 除く）
4. 名前 `mainFrame` のフレーム
5. `kanamicmain` の子フレーム（最後の子）

### 標準フォーム送信パターン（submitForm）
```javascript
window.submited = 0;           // 送信ロック解除
form.doAction.value = action;  // アクション設定
form.lockCheck.value = '1';    // 修正操作時のみ
form.target = 'commontarget';
form.doTarget.value = 'commontarget';
form.submit();
```

### submitTargetFormEx（特殊遷移）
k2_1→k2_2（利用者選択）、k2_2→k2_2f（配置ボタン）で使用:
```javascript
// onclick="submitTargetFormEx(this.form,'k2_2',careuserid,'8876382')"
window.submitTargetFormEx(form, pageId, hiddenField, value);
```
フォールバック: `form.target = 'mainFrame'` で直接遷移。

### waitForMainFrame のポーリング
- ポーリング間隔: 300ms
- デフォルトタイムアウト: 15000ms
- DOM 準備確認: `document.forms[0]` の存在チェック

### esbuild/tsx __name polyfill

tsx（esbuild）の `keepNames` 変換は関数定義に `__name` ヘルパーを注入する。Playwright の `evaluate()` でブラウザにコードが送信される際、ブラウザ側に `__name` が存在せず `ReferenceError` になる。

**対策**: `BrowserManager.launch()` で `context.addInitScript()` を使い、全フレームに polyfill を注入:
```javascript
globalThis.__name = (fn) => fn;
```

### setSelectValue のフォールバック戦略
1. 完全一致
2. ゼロパディング除去（`"09"` → `"9"`）
3. ゼロパディング追加（`"9"` → `"09"`）
4. テキスト部分一致
- ポーリング: 最大15回 × 500ms間隔

---

## 2-3. 転記ワークフロー（通常フロー・14ステップ）

**ソース**: `src/workflows/transcription/transcription.workflow.ts` — `processRecord()`

### ページ遷移図
```
t1-2 (メインメニュー)
  → k1_1 (訪問看護業務ガイド)
    → k2_1 (利用者検索)
      → k2_2 (月間スケジュール)
        → k2_3 (スケジュール追加)
          → k2_3a (サービスコード選択)
            → k2_3b (確認)
              → k2_2 (月間スケジュール)
                → k2_2f (スタッフ配置)
                  → k2_2 (月間スケジュール)
                    → t1-2 (メインメニューへ戻る)
```

### ステップ詳細

| ステップ | 操作 | アクション | 遷移先 | sleep(ms) |
|---------|------|----------|--------|-----------|
| Step 1 | メインメニュー → 業務ガイド | `act_k1_1` | k1_1 | - |
| Step 2 | 業務ガイド → 利用者検索 | `act_k2_1` | k2_1 | - |
| Step 3 | 年月設定 → 全利用者検索 | `act_search` | k2_1 | 1000 |
| Step 4 | 利用者特定 → submitTargetFormEx | `k2_2` | k2_2 | 1000 |
| Step 4.5a | 重複チェック（既存エントリ検出時はスキップ） | `checkDuplicateOnK2_2` | k2_2 | - |
| Step 4.5b | 修正レコード: 既存スケジュール削除 | `confirmDelete` | k2_2 | 2000 + 2000 |
| Step 5 | 追加ボタン | `act_addnew` | k2_3 | 1000 |
| Step 6 | starttype 変更（条件付き） | `onchange` | k2_3 | 3000（変更時のみ） |
| Step 6 | 時間設定 → 次へ | `act_next` | k2_3a | 1000 |
| Step 7 | 保険種別切替 | `act_change` | k2_3a | 1500 |
| Step 7 | サービスコード選択 | radio 選択 | k2_3a | - |
| Step 7.5 | 資格チェックボックス選択（医療保険のみ） | evaluate | k2_3a | - |
| Step 8 | 次へ | `act_next` | k2_3b | 500 |
| Step 8 | 決定 | `act_do` | k2_2 | 1500 |
| Step 9 | 配置ボタン → submitTargetFormEx | `act_modify` | k2_2f | 1000 |
| Step 10 | 配置ボタンクリック → 従業員リスト | `act_select` | k2_2f | 2000 |
| Step 10 | 従業員リスト待機（最大15回） | ポーリング | - | 1000×n |
| Step 10 | スタッフ選択 → k2_2 | `act_select` | k2_2 | 1000 |
| Step 10.5 | 上書き保存（1回目: 配置確定） | `act_update` | k2_2 | 2000 |
| Step 11 | 全1ボタン（実績フラグ一括設定） | `checkAllAndSet1('results')` | k2_2 | 500 |
| Step 11.5 | 緊急時加算チェック（必要な場合） | `urgentflags` チェック | k2_2 | - |
| Step 12 | 上書き保存（2回目: 実績確定） | `act_update` | k2_2 | 2000 |
| Step 13 | 保存結果検証（エラー文字列チェック） | `getFrameContent` | k2_2 | - |
| Step 14 | Google Sheets S列・V列更新 | Sheets API | - | - |
| - | メインメニューへ戻る | `act_back` | t1-2 | - |

### syserror.jsp チェックポイント
Step 4（k2_2 遷移後）、Step 5（k2_3 遷移後）、Step 9（k2_2f 遷移後）で `checkForSyserror()` を実行。

### Step 4.5a: 重複チェック（checkDuplicateOnK2_2）
- k2_2 テーブルの全行を走査し、同一日付 + 同一開始時刻 + 「編集」ボタン有りの行を検索
- 該当行が存在する場合: 既に転記済みと判断し、S列を「転記済み」に更新してスキップ
- 条件: `transcriptionFlag !== '修正あり'`（修正レコードは先に既存を削除するため重複チェック不要）
- これにより、同一データの二重登録とスタッフ選択不可エラーを防止する

### Step 4.5b: 修正レコードの既存スケジュール削除
- 条件: `transcriptionFlag === '修正あり'`（通常フロー・I5フロー共通）
- **hamAssignId（AA列）が存在する場合**: assignId で直接行を特定して削除（日付・時刻に依存しない）
  - 修正で日付・時刻が変更された場合でも、assignId は不変のため確実に旧スケジュールを特定可能
  - I5 レコードはカンマ区切りで複数 assignId → `deleteScheduleByAssignId()` で順次削除
- **hamAssignId が存在しない場合**: 従来の同一日付+同一開始時刻+スタッフ名で検索（フォールバック）
- `confirmDelete(assignid, record2flag)` を呼び出し
- `record2flag === '1'`（記録書II存在）の場合はエラー（削除不可）
- 削除後に `act_update` で保存（sleep: 2000ms）

### sleep 合計（最小ケース: starttype変更なし、従業員リスト即時表示）
```
1000 + 1000 + 1000 + 1500 + 500 + 1500 + 1000 + 2000 + 1000 + 2000 + 500 + 2000 = 16,000ms
```
（starttype 変更時: +3000ms = 19,000ms）

---

## 2-4. 転記ワークフロー（I5フロー：介護リハビリ）

**ソース**: `src/workflows/transcription/transcription.workflow.ts` — `processI5Record()`

### 分岐条件
```typescript
serviceType1 === '介護' && serviceType2 === 'リハビリ'
→ codeResult.useI5Page = true
→ processI5Record() を呼び出し
```

### フロー概要
```
Step 1-4: 通常フローと同じ（メニュー → 検索 → 利用者選択 → k2_2）
Step 4.5a: 重複チェック（通常フローと同じ。既存エントリがあればスキップ）
Step 4.5b: 修正レコード: 既存スケジュール削除（通常フローと同じ。assignId 優先）
Step 5: k2_2 で 訪看I5入力ボタン (act_i5) → k2_7_1
Step 6: k2_7_1 で時間グループ設定（終了時刻は setEndtime() 自動値を使用、-1分補正なし）
Step 7: サービス検索 (act_search) → k2_7_1
Step 8: 戻る (act_back) → k2_2
Step 9: 全1ボタン → 上書き保存 → Google Sheets 更新
```

### k2_7_1 での時間設定フォーム要素
| フォーム要素 | 内容 |
|------------|------|
| `starttimetype` | 時間帯区分（getTimePeriod の結果） |
| `starthour` | 開始時刻（時） |
| `startminute` | 開始時刻（分） |
| `endhour` | 終了時刻（時） |
| `endminute` | 終了時刻（分） |

### 予防/介護の切替判定
`PatientMasterService.determineCareType(careLevel)` で判定。  
予防モードの場合はログ出力のみ（実機検証後に UI 操作を追加予定）。

### sleep 合計（I5フロー）
```
1000（利用者検索後）+ 1000（k2_2遷移後）+ 1000（k2_7_1遷移後）
+ 1500（サービス検索後）+ 1000（k2_2戻り後）+ 2000（上書き保存後）= 7,500ms
```

---

## 2-5. サービスコード決定ロジック

**ソース**: `src/services/service-code-resolver.ts`

### 決定要素
| パラメータ | 説明 | 値 |
|----------|------|-----|
| `showflag` | 保険種別切替 | 1=介護, 2=予防, 3=医療/精神医療 |
| `servicetype` | サービス種類コード | HAM radio value の左側 |
| `serviceitem` | サービス項目コード | HAM radio value の右側 |
| `longcareflag` | 介護保険フラグ | 1=介護保険, 0=医療保険 |
| `pluralnurseflag1` | 複数名訪問加算フラグ | 1=あり, 0=なし |
| `pluralnurseflag2` | 同行事務員フラグ | 1=あり, 0=なし |
| `useI5Page` | I5ページ使用フラグ | true=k2_7_1, false=通常フロー |
| `setUrgentFlag` | 緊急時加算フラグ | 全保険種別共通: O列=true AND R列='加算対象' のときのみ ON |
| `textPattern` | テキストマッチパターン | radio 行テキスト部分一致フォールバック |

### 全分岐決定表

| serviceType1 | serviceType2 | 同行 | 複数名/事務員 | 緊急 | showflag | servicetype | serviceitem | useI5Page |
|-------------|-------------|:----:|:------------:|:----:|:--------:|:-----------:|:-----------:|:---------:|
| 介護 | リハビリ | - | - | - | 1 | - | - | ✓ |
| 医療 | 緊急 | - | - | ✓ | 3 | 93 | 1001 | - |
| 医療 | リハビリ | - | ✓ | - | 3 | 93 | 1001 | - |
| 医療 | リハビリ | - | - | - | 3 | 93 | 1001 | - |
| 医療 | 通常 | ✓ | - | - | 3 | 93 | 1001 | - |
| 医療 | 通常 | - | ✓ | - | 3 | 93 | 1001 | - |
| 医療 | 通常 | - | - | - | 3 | 93 | 1001 | - |
| 精神医療 | 緊急 | - | - | ✓ | 3 | 93 | 1225 | - |
| 精神医療 | 通常 | ✓ | - | - | 3 | 93 | 1225 | - |
| 精神医療 | 通常 | - | ✓ | - | 3 | 93 | 1225 | - |
| 精神医療 | 通常 | - | - | - | 3 | 93 | 1225 | - |
| 介護 | 緊急 | - | - | ✓ | 1 | 13 | 1111 | - |
| 介護 | 通常 | ✓ | - | - | 1 | 13 | 1121 | - |
| 介護 | 通常 | - | ✓ | - | 1 | 13 | 1114 | - |
| 介護 | 通常 | - | - | - | 1 | 13 | 1111 | - |

> **注意**: 介護保険の servicetype/serviceitem は実機未検証。textPattern フォールバックで対応。

### textPattern フォールバック
`servicetype#serviceitem` が HAM の radio value と一致しない場合、`textPattern` で行テキスト部分一致検索。  
例: `textPattern: '訪問看護基本療養費'`

### 資格チェックボックス選択（医療保険のみ: showflag=3）
| 資格 | value | 対象 |
|------|-------|------|
| 看護師等 | `1` | 通常/緊急（看護師優先） |
| 准看護師等 | `2` | 通常/緊急（准看護師） |
| 理学療法士等 | `3` | リハビリのみ |

**医療リハビリの資格制限**: 看護師/准看護師は不可。理学療法士/作業療法士/言語聴覚士のみ。

---

## 2-6. 転記対象判定ロジック

**ソース**: `src/workflows/transcription/transcription.workflow.ts` — `isTranscriptionTarget()`

### 判定フロー（優先順位順）

```
1. recordLocked = true          → 対象外（実績ロック）
2. completionStatus = '' or '1' → 対象外（会議決定: 日々チェック保留）
3. N列「重複」かつ P列が空欄    → 対象外（事務員未判定 — ペアの役割が未確定）
4. O列「緊急支援あり」かつ R列が空欄 → 対象外（緊急時事務員未設定）
5. P列「同行者」                → 対象外（全支援区分共通）
6. transcriptionFlag = '転記済み' → 対象外（転記完了）
7. transcriptionFlag = ''        → 対象（未転記）
8. transcriptionFlag = 'エラー：システム' → 対象（再試行）
9. transcriptionFlag = 'エラー：マスタ不備' AND masterCorrectionFlag = true → 対象（マスタ修正後）
10. transcriptionFlag = '修正あり' → 対象（修正レコード再転記）
11. その他                        → 対象外
```

### 重複グループの跨レコードバリデーション（buildDuplicateBlockedSet）

同一キー（患者名+日付+開始時刻+終了時刻）のグループで N列=重複 のレコードを検出し、以下のルールでブロックする:

1. **いずれかの P列が空欄** → グループ全体をブロック（事務員未判定）
2. **全 P列が入力済み** → 資格優先度が最も高いスタッフの1件のみ転記対象、残りをブロック

資格優先度（staffName プレフィックスで判定）:
| プレフィックス | スコア |
|-------------|:------:|
| 看護師 | 2 |
| 准看護師 | 1 |
| その他 | 0 |

同スコアの場合はシート上の出現順を維持。

### completionStatus の値（M列）
| 値 | 意味 | 転記対象 |
|----|------|:-------:|
| `''` (空白) | 未確認/保留 | ✗ |
| `'1'` | 日々チェック保留 | ✗ |
| `'2'` | 日々チェック完了 | ✓ |
| `'3'` | （値の意味は業務仕様参照） | ✓ |
| `'4'` | （値の意味は業務仕様参照） | ✓ |

> **会議決定（2026-02-27）**: 「1」と空白ステータスは保留として転記から除外し、「2、3、4」をカナミックへの転記対象とする。

---

## 2-7. エラー分類と処理

**ソース**: `src/workflows/transcription/transcription.workflow.ts` — `classifyError()`, `tryRecoverToMainMenu()`

### エラー分類表

| エラーパターン（メッセージ含む文字列） | S列ステータス | カテゴリ | recoverable | U列エラー詳細 |
|----------------------------------|-------------|---------|:-----------:|-------------|
| `スタッフ配置不可` | エラー：マスタ不備 | master | ✗ | スタッフ配置不可：担当スタッフが同時間帯に他利用者の予定と重複しHAMで選択不可（手動配置が必要） |
| `利用者が見つかりません` / `マスタ不備` | エラー：マスタ不備 | master | ✗ | 利用者がHAMに登録されていません |
| `スタッフ` + `見つかりません` | エラー：マスタ不備 | master | ✗ | スタッフがHAMに登録されていません |
| `医療リハビリ資格制限` | エラー：マスタ不備 | master | ✗ | 医療リハビリ：看護師/准看護師は対応不可（理学療法士等のみ） |
| `サービスコード未検出` | エラー：システム | system | ✓ | サービスコードが見つかりません。HAM設定を確認してください |
| `syserror` / `E00010` / `一時的に利用できません` | エラー：システム | network | ✓ | HAMシステムが一時的に利用できません。時間をおいて再実行してください |
| `form not found` / `not found (timeout)` | エラー：システム | system | ✓ | HAM画面の読み込みタイムアウト。再実行してください |
| `mainFrame` / `フレーム` | エラー：システム | system | ✓ | HAM画面遷移エラー。再実行してください |
| `timeout` / `Timeout` / `net::` | エラー：システム | network | ✓ | ネットワークタイムアウト。接続を確認して再実行してください |
| `ログイン` / `expired` / `login` | エラー：システム | network | ✓ | セッション切れ。再ログインして再実行してください |
| その他 | エラー：システム | system | ✓ | システムエラー: {先頭80文字} |

### エラー後の復帰ロジック（tryRecoverToMainMenu）
1. syserror ページの「閉じる」ボタン（`input[type="button"], button`）をクリック（sleep: 1000ms）
2. `act_back` を最大5回繰り返してメインメニューへ（sleep: 1000ms/回）
3. 失敗時: `ensureLoggedIn()` で再ログイン

---

## 2-8. リトライ戦略

**ソース**: `src/core/retry-manager.ts`

### バックオフ計算式
```
delay = min(baseDelay × 2^(attempt-1), maxDelay)
```

### 各ワークフローのリトライ設定

| ワークフロー | maxAttempts | baseDelay(ms) | maxDelay(ms) | backoffMultiplier |
|------------|:-----------:|:-------------:|:------------:|:-----------------:|
| 転記（processRecord） | 2 | 3000 | 15000 | 2 |
| ログイン（login） | 2 | 3000 | - | - |
| 削除（processRecord） | 3 | 2000 | 10000 | 2 |
| デフォルト | 3 | 1000 | 30000 | 2 |

### 連続エラー自動停止（サーキットブレーカー）

- 連続3件の **system/network** エラーが発生した場合、システム障害と判断して処理を自動中止（`MAX_CONSECUTIVE_ERRORS = 3`）
- **マスタ不備エラー（category='master'）は連続エラーカウントに含めない** — 未登録患者の連続レコード等でも処理が停止しない
- 成功したレコードがあればカウンターはリセットされる
- これにより HAM サーバーへの不必要な負荷を防止する
- 実装箇所: `processLocation()` 内のレコード処理ループ

### 実際の待機時間

**転記（maxAttempts=2）**:
- 1回目失敗後: `min(3000 × 2^0, 15000)` = 3000ms 待機
- 2回目失敗後: 終了（最大2回）

**削除（maxAttempts=3）**:
- 1回目失敗後: `min(2000 × 2^0, 10000)` = 2000ms
- 2回目失敗後: `min(2000 × 2^1, 10000)` = 4000ms
- 3回目失敗後: 終了

---

## 2-9. 処理ペース・負荷情報

**ソース**: `src/workflows/transcription/transcription.workflow.ts` の全 sleep() 呼び出し

### 通常フロー sleep 一覧

| 場所 | sleep(ms) | 条件 |
|------|:---------:|------|
| Step 3: 利用者検索後 | 1000 | 常時 |
| Step 4: k2_2 遷移後 | 1000 | 常時 |
| Step 4.5: 削除ボタンクリック後 | 2000 | 修正レコードのみ |
| Step 4.5: 上書き保存後 | 2000 | 修正レコードのみ |
| Step 5: k2_3 遷移後 | 1000 | 常時 |
| Step 6: starttype 変更後 | 3000 | starttype 変更時のみ |
| Step 7: 保険種別切替後 | 1500 | 常時 |
| Step 8: k2_3b 次へ後 | 500 | 常時 |
| Step 8: k2_3b 決定後 | 1500 | 常時 |
| Step 9: k2_2f 遷移後 | 1000 | 常時 |
| Step 10: 配置ボタン後 | 2000 | 常時 |
| Step 10: 従業員リスト待機 | 1000×n | 最大15回 |
| Step 10: スタッフ選択後 | 1000 | 常時 |
| Step 10.5: 上書き保存1回目後 | 2000 | 常時 |
| Step 11: 全1ボタン後 | 500 | 常時 |
| Step 12: 上書き保存2回目後 | 2000 | 常時 |

### 処理時間推定

| ケース | sleep合計 | 推定総処理時間 |
|-------|:---------:|:------------:|
| 最小（starttype変更なし、従業員リスト即時） | 16,000ms | 30〜45秒 |
| 標準（starttype変更あり） | 19,000ms | 35〜50秒 |
| 修正レコード（既存削除あり） | +4,000ms | 40〜60秒 |

> **注意**: 上記は sleep のみの合計。`waitForMainFrame`（タイムアウト15秒）、Google Sheets API 呼び出し、ネットワーク遅延を含む実際の処理時間はさらに長くなる。

### I5フロー sleep 合計
```
1000 + 1000 + 1000 + 1500 + 1000 + 2000 = 7,500ms（最小）
```

### ページ遷移・フォーム送信回数（通常フロー）
- ページ遷移: 約8回（t1-2→k1_1→k2_1→k2_2→k2_3→k2_3a→k2_3b→k2_2→k2_2f→k2_2）
- フォーム送信: 約10回（submitForm + submitTargetFormEx）

---

## 2-10. Google Sheets 操作

**ソース**: `src/services/spreadsheet.service.ts`

### 読み取り範囲

| シート | タブ名 | 範囲 | 列数 |
|-------|-------|------|:----:|
| 月次シート | `{YYYY年MM月}` (例: 2026年02月) | `A2:Y` | 25 |
| 削除シート | `削除Sheet` | `A2:M` | 13 |
| 修正管理シート | `看護記録修正管理` | `A2:G` | 7 |
| 建物管理シート | `同一建物管理` | `A2:I` | 9 |

### 書き込み列（月次シート）

| 列 | インデックス | 内容 | 書き込みタイミング |
|----|:-----------:|------|----------------|
| S列 | 18 | 転記フラグ（転記済み/エラー：システム/エラー：マスタ不備） | 転記完了時・エラー時 |
| U列 | 20 | エラー詳細（日本語メッセージ） | エラー時（転記済み時はクリア） |
| V列 | 21 | データ取得日時（ISO 8601形式） | 転記完了時 |

### 書式設定
`formatTranscriptionColumns()` — 月次シートの S列・U列に `wrapStrategy: WRAP` を適用（文字折返表示）。

### 月次シートタブ名生成
```typescript
`${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月`
// 例: "2026年02月"
```

デフォルトは当月タブを自動生成。`--tab` CLI パラメータで任意のタブ名を指定可能:
```bash
node dist/index.js --workflow=transcription --tab=2026年02月
npx tsx src/scripts/run-transcription.ts --tab=2026年02月
```

`SpreadsheetService` の全メソッド（`getTranscriptionRecords`, `updateTranscriptionStatus`, `writeDataFetchedAt`, `formatTranscriptionColumns`）がオプション `tab?` パラメータを受け付け、`WorkflowContext.tab` 経由で全レイヤーに伝播される。

### 注意事項
- `CorrectionDetector` クラスは `src/index.ts` にインポートされているが、インスタンス化されていない（**デッドコード**）。修正管理シートへの書き込みは本プロジェクトの範囲外。
- `appendCorrectionRecord()` は A〜E列のみ書き込み（F列のプルダウン保持のため）。

---

## 2-11. 日次ジョブフロー

**ソース**: `src/index.ts`

### 実行順序（runDailyJob）

```
1. 防重入チェック（isRunning フラグ）
   └── 実行中の場合: スキップ

2. SmartHR スタッフ同期（SMARTHR_ACCESS_TOKEN 設定時のみ）
   └── 失敗しても転記は続行

3. 転記ワークフロー（全事業所）
   └── 失敗しても削除は続行

4. 削除ワークフロー（全事業所）

5. メール通知（NOTIFICATION_EMAIL_ENABLED=true 時のみ）
```

### cron スケジュール
```typescript
cron.schedule(config.scheduling.transcriptionCron, () => runDailyJob());
cron.schedule(config.scheduling.buildingMgmtCron, () => runWorkflow('building'));
```
（実際のスケジュール値は `src/config/app.config.ts` 参照）

### 環境変数

| 変数名 | デフォルト値 | 説明 |
|-------|------------|------|
| `KANAMICK_STATION_NAME` | `訪問看護ステーションあおぞら姶良` | 対象事業所名 |
| `KANAMICK_HAM_OFFICE_KEY` | `6` | goCicHam.jsp の k パラメータ |
| `KANAMICK_HAM_OFFICE_CODE` | `400021814` | goCicHam.jsp の h パラメータ（姶良） |
| `DRY_RUN` | `false` | `true` で HAM 操作をスキップ |
| `NOTIFICATION_EMAIL_ENABLED` | `false` | メール通知の有効化 |
| `NOTIFICATION_FROM` | - | 送信元メールアドレス（Service Account に委任されたユーザー） |
| `NOTIFICATION_TO` | - | 送信先メールアドレス（カンマ区切り） |
| `RUN_LOCATIONS` | （全事業所） | 処理対象の事業所名（カンマ区切り、例: `姶良` / `姶良,谷山`） |
| `SMARTHR_ACCESS_TOKEN` | - | SmartHR API トークン（未設定時は同期スキップ） |
| `SMARTHR_BASE_URL` | `https://acg.smarthr.jp/api/v1` | SmartHR API URL |

---

## 2-12. timetype 計算ルール

**ソース**: `src/services/time-utils.ts`

### calcDurationMinutes（所要時間計算）
```typescript
startMin = startHour * 60 + startMinute
endMin   = endHour   * 60 + endMinute
// 日跨ぎ対応（例: 23:00 → 01:00）
if (endMin <= startMin) endMin += 24 * 60
duration = endMin - startMin
```

### calcTimetype（HAM timetype 値）

| 所要時間（分） | timetype | HAM表示 |
|:------------:|:--------:|--------|
| 0〜20分 | `'20'` | 20分未満 |
| 21〜30分 | `'30'` | 30分未満 |
| 31〜60分 | `'60'` | 1時間未満 |
| 61〜90分 | `'90'` | 1時間30分未満 |
| 91分以上 | `'91'` | 1時間30分以上 |

> **注意**: `timetype='21'`（20分ちょうど）は不使用（専務確認済み 2026-02-26）

### getTimePeriod（starttype/endtype: 時間帯区分）

| 時刻範囲 | 値 | HAM表示 |
|---------|:--:|--------|
| 6:00〜17:59 | `'1'` | 日中 |
| 18:00〜21:59 | `'2'` | 夜間・早朝 |
| 22:00〜5:59 | `'3'` | 深夜 |

### 終了時間の扱い

**通常フロー（k2_3）**: `calcCorrectedEndTime(endTime)` で終了時間を補正（endTime - 1分）。  
ただし分の1の位が既に 9 の場合（:29, :59 等）は補正不要（既に HAM の inclusive 形式）。

| 入力例 | 出力 | 補正 |
|-------|------|:----:|
| `12:35` | `12:34` | -1分 |
| `13:00` | `12:59` | -1分 |
| `11:29` | `11:29` | なし |
| `11:59` | `11:59` | なし |

**I5フロー（k2_7_1）**: `setEndtime()` が20分単位で正確に自動計算するため、-1分補正は適用しない。HAM 自動値をそのまま使用。

---

## 2-13. 削除ワークフロー

**ソース**: `src/workflows/deletion/deletion.workflow.ts`

### 概要
削除Sheet に登録されたレコードに基づき、HAM 上の該当スケジュールを削除する。転記ワークフロー完了後に実行される。

### 削除Sheet 列構成

| 列 | インデックス | 内容 |
|----|:-----------:|------|
| A | 0 | ID |
| B | 1 | タイムスタンプ |
| C | 2 | 更新日時 |
| D | 3 | 従業員番号 |
| E | 4 | 記録者 |
| F | 5 | あおぞらID |
| G | 6 | 利用者 |
| H | 7 | 日付 |
| I | 8 | 開始時刻 |
| J | 9 | 終了時刻 |
| K | 10 | 支援区分1 |
| L | 11 | 支援区分2 |
| M | 12 | 完了ステータス（RPA書き込み先） |

### M列（完了ステータス）の値

| 値 | 意味 | 次回実行時 |
|----|------|-----------|
| `''`（空白） | 未処理 | 削除対象 |
| `'削除済み'` | HAM から削除完了 | スキップ |
| `'削除不要'` | HAM に該当スケジュールなし | スキップ |
| `'エラー：システム'` | システムエラー | リトライ対象 |

### 対象レコード判定
```typescript
records.filter(r =>
  r.recordId &&
  !r.completionStatus.includes('削除済み') &&
  !r.completionStatus.includes('削除不要')
);
```

### ページ遷移図
```
t1-2 (メインメニュー)
  → k1_1 (訪問看護業務ガイド)
    → k2_1 (利用者検索)
      → k2_2 (月間スケジュール)
        → [削除ボタンクリック + 上書き保存]
          → t1-2 (メインメニューへ戻る)
```

### ステップ詳細（processRecord）

| ステップ | 操作 | アクション | 遷移先 | sleep(ms) |
|---------|------|----------|--------|:---------:|
| Step 1 | メインメニュー → 業務ガイド → 利用者検索 | `act_k1_1` → `act_k2_1` | k2_1 | - |
| Step 2 | 年月設定 → 全利用者検索 | `setSelectValue('searchdate')` → `act_search` | k2_1 | 1000 |
| Step 3 | 利用者特定 → 月間スケジュール | `submitTargetFormEx` → `waitForMainFrame('k2_2')` | k2_2 | 1000 |
| Step 3.5 | syserror チェック | `checkForSyserror()` | - | - |
| Step 4 | 対象スケジュール行を特定 → 削除ボタンクリック | `deleteSchedule()` | k2_2 | 2000 |
| Step 4（不一致時） | HAM に該当なし → 削除不要 | `updateDeletionStatus('削除不要')` | t1-2 | - |
| Step 5 | 上書き保存 | `act_update` (setLockCheck: true) | k2_2 | 2000 |
| Step 6 | Google Sheets M列更新 | `updateDeletionStatus('削除済み')` | - | - |
| - | メインメニューへ戻る | `navigateToMainMenu()` | t1-2 | - |

### deleteSchedule の詳細

**行特定ロジック**:
1. `visitDateHam` から日数を抽出 → `dayDisplay = "${dayNum}日"`
2. k2_2 の全 `<tr>` を走査し、`rowText` に `dayDisplay` と `startTime` の両方を含む行を検索
3. 行内の `input[name="act_delete"][value="削除"]` ボタンの `onclick` 属性から `assignid` と `record2flag` を正規表現で抽出

**record2flag チェック**:
- `record2flag === '1'` → 記録書IIが存在するため削除不可（Error をスロー）
- `record2flag !== '1'` → 削除実行

**削除ボタンクリック**:
1. Playwright native click: `frame.$('input[name="act_delete"][onclick*="confirmDelete(\'${assignid}\'"]')` → `click()`
2. フォールバック: `frame.evaluate()` で `window.confirmDelete(assignid, '0')` を直接呼び出し
3. いずれの場合も事前に `window.submited = 0` で送信ロックを解除

### findPatientId（利用者ID検索）

転記ワークフローと同一ロジック:
1. `input[name="act_result"][value="決定"]` ボタンの親 `<tr>` のテキストで利用者名マッチ → `onclick` から `careuserid` 抽出
2. フォールバック: `document.body.innerHTML` を `<tr` で分割し、行テキストで部分一致検索
3. 利用者名は `normalize()` で全角/半角スペース・`&nbsp;` を除去して比較

### エラー処理（tryRecoverToMainMenu）
1. syserror ページの「閉じる」ボタンをクリック（sleep: 1000ms）
2. `act_back` を最大5回繰り返してメインメニュー（`t1-2`）へ復帰（sleep: 1000ms/回）
3. 復帰失敗時: `ensureLoggedIn()` で再ログイン

### リトライ設定
```
maxAttempts: 3
baseDelay: 2000ms
maxDelay: 10000ms
backoffMultiplier: 2
```

### sleep 合計（正常ケース）
```
1000（利用者検索後）+ 1000（k2_2遷移後）+ 2000（削除ボタン後）+ 2000（上書き保存後）= 6,000ms
```

---

## 2-14. AI セレクタ自愈機能

**ソース**: `src/core/ai-healing-service.ts`, `src/core/selector-engine.ts`

### 概要
HAM のページ構造が変更され CSS セレクタが失効した場合に、OpenAI GPT-4o を使って自動的に新しいセレクタを推定・検証・永続化する機能。

### セレクタ解決優先順位（SelectorEngine.resolve）

```
1. aiHealed（AI修復済みセレクタ）  → ページ上で要素が見つかれば使用
2. primary（プライマリセレクタ）    → 通常はこれが使われる
3. fallbacks（フォールバック配列）  → primary 失敗時に順次試行
4. AI自愈（healSelector）          → 全て失敗した場合のみ発動
```

### AI自愈処理フロー

```
セレクタ解決失敗
  │
  ├── 1. スクリーンショット取得 → base64 エンコード
  ├── 2. ページ HTML 取得（先頭 10,000 文字）
  ├── 3. OpenAI GPT-4o に送信（画像 + HTML + プロンプト）
  │       └── レスポンス: { selector, confidence, reasoning }
  ├── 4. confidence >= 0.5 かチェック
  ├── 5. 実際にページ上で要素検証（page.$(selector)）
  ├── 6. 検証成功 → selectors.json に永続化
  │       ├── config.aiHealed = selector
  │       ├── config.lastHealed = timestamp
  │       └── config.confidence = confidence
  └── 7. 次回以降は aiHealed が最優先で使用される
```

### セレクタ定義ファイル
- パス: `src/config/selectors/{workflowName}.selectors.json`
- 構造:
```json
{
  "version": "1.0",
  "workflow": "transcription",
  "lastUpdated": "2026-02-27T...",
  "selectors": {
    "selectorId": {
      "id": "selectorId",
      "description": "説明",
      "primary": "#main-selector",
      "fallbacks": [".fallback-1", ".fallback-2"],
      "context": "このセレクタの用途説明",
      "aiHealed": null,
      "lastHealed": null,
      "confidence": null
    }
  }
}
```

### 安全性チェック（isValidCSSSelector）
- 空文字・空白のみ → 拒否
- `<`, `>`, `javascript:` を含む → 拒否（スクリプトインジェクション防止）
- 500文字超 → 拒否

### PHI（個人健康情報）保護
スクリーンショットは `finally` ブロックで即削除。API 呼び出しの成否に関わらず、ローカルに画像が残らない。

### 環境変数

| 変数名 | デフォルト値 | 説明 |
|-------|------------|------|
| `OPENAI_API_KEY` | （必須） | OpenAI API キー |
| `AI_HEALING_MODEL` | `gpt-4o` | 使用モデル |
| `AI_HEALING_MAX_ATTEMPTS` | `3` | 最大試行回数 |
| `SCREENSHOT_DIR` | `./screenshots` | スクリーンショット一時保存先 |

### コスト
GPT-4o: $2.50/M input, $10/M output。通常運用ではセレクタ失効時のみ発動するため、コストは極めて低い（月数回程度の想定）。

---

## 2-15. 全体処理フロー

**ソース**: `src/index.ts`

### システム構成図

```
Cloud Run Job トリガー (日本時間 13:00)
  │
  ├── 1. SmartHR スタッフ同期（オプション: SMARTHR_ACCESS_TOKEN 設定時のみ）
  │     └── 失敗しても後続処理は続行
  │
  ├── 2. 転記ワークフロー
  │     ├── ブラウザ起動 → TRITRUS ログイン → HAM
  │     ├── 各事業所の月次シートを処理
  │     │     └── 各レコード: 利用者検索 → スケジュール追加 → 保存 → S列更新
  │     └── ブラウザ終了
  │
  ├── 3. 削除ワークフロー
  │     ├── ブラウザ起動 → TRITRUS ログイン → HAM
  │     ├── 各事業所の削除シートを処理
  │     │     └── 各レコード: 利用者検索 → スケジュール削除 → 保存 → M列更新
  │     └── ブラウザ終了
  │
  └── 4. メール通知
        ├── 全成功: [カナミックRPA] 転記処理結果 {date}
        └── エラーあり: [カナミックRPA] ⚠️ エラー発生 {date} + エラー詳細テーブル
```

### デプロイ構成
- **実行環境**: GCP Cloud Run Job
- **スケジューリング**: Cloud Scheduler（日本時間 13:00 トリガー）
- **コード内 cron**: `node-cron` はローカル開発用のフォールバック（本番では使用しない）

### 実行モード

| モード | コマンド | 動作 |
|-------|---------|------|
| 日次ジョブ | `node dist/index.js`（引数なし） | `runDailyJob()`: 転記→削除→通知 |
| 単体実行 | `node dist/index.js --workflow=transcription` | 転記のみ |
| 単体実行 | `node dist/index.js --workflow=deletion` | 削除のみ |
| 単体実行 | `node dist/index.js --workflow=building` | 同一建物管理のみ |
| 前月タブ処理 | `node dist/index.js --workflow=transcription --tab=2026年02月` | 指定タブの転記 |
| ドライラン | `DRY_RUN=true node dist/index.js` | HAM 操作をスキップ（ログのみ） |

### 防重入制御
`isRunning` フラグで二重実行を防止。前回の処理が完了していない場合はスキップ。

### SIGINT ハンドリング
`process.on('SIGINT')` で Ctrl+C を捕捉し、`process.exit(130)` で即座に終了する。async チェーンが SIGINT を飲み込んでプロセスが停止しない問題を防止。`index.ts` と `run-transcription.ts` の両方に実装。

### メール通知

**ソース**: `src/services/notification.service.ts`

**送信方式**: Google Gmail API（Service Account + ドメイン全体の委任）
- Service Account キーファイル: `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`（デフォルト: `./kangotenki.json`）
- 送信元: `NOTIFICATION_FROM`（Service Account に委任されたユーザーのメールアドレス）
- 送信先: `NOTIFICATION_TO`（カンマ区切り、例: `dxgroup@aozora-cg.com`）
- RFC 2822 形式のメールを base64url エンコードして `gmail.users.messages.send` で送信

**Google Workspace 管理者設定（必須）**:
1. GCP Console で Gmail API を有効化
2. Service Account の「ドメイン全体の委任」を有効化
3. Google Admin Console → セキュリティ → API の制御 → ドメイン全体の委任
   - Client ID: Service Account の Client ID
   - スコープ: `https://www.googleapis.com/auth/gmail.send`

| 条件 | 件名 | 内容 |
|------|------|------|
| 全成功 | `[カナミックRPA] 転記処理結果 {date}` | 処理結果テーブル（ワークフロー×事業所） |
| エラーあり | `[カナミックRPA] ⚠️ エラー発生 {date}` | 処理結果テーブル + エラー詳細テーブル |
| 処理件数0 かつ エラー0 | （送信しない） | - |
| Gmail API 送信失敗 | （ログのみ） | 例外は投げない（後続処理に影響しない） |

**HTML メール構成**:
- 総合結果（✅ 正常完了 / ❌ エラーあり）
- 処理件数・エラー件数
- 詳細テーブル: ワークフロー名、事業所名、結果、処理件数、エラー件数、処理時間
- エラー詳細テーブル（エラーがある場合のみ）: レコードID、カテゴリ、エラー内容

### 全環境変数一覧

| 変数名 | デフォルト値 | 必須 | 説明 |
|-------|------------|:----:|------|
| `KANAMICK_URL` | - | ✓ | TRITRUS ポータル URL |
| `KANAMICK_USERNAME` | - | ✓ | ログインユーザー名 |
| `KANAMICK_PASSWORD` | - | ✓ | ログインパスワード |
| `KANAMICK_STATION_NAME` | `訪問看護ステーションあおぞら姶良` | - | 対象事業所名 |
| `KANAMICK_HAM_OFFICE_KEY` | `6` | - | goCicHam.jsp の k パラメータ |
| `KANAMICK_HAM_OFFICE_CODE` | `400021814` | - | goCicHam.jsp の h パラメータ（姶良） |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | `./kangotenki.json` | - | Google サービスアカウントキー |
| `OPENAI_API_KEY` | - | ✓ | OpenAI API キー（AI自愈用） |
| `AI_HEALING_MODEL` | `gpt-4o` | - | AI自愈モデル |
| `AI_HEALING_MAX_ATTEMPTS` | `3` | - | AI自愈最大試行回数 |
| `DRY_RUN` | `false` | - | `true` で HAM 操作をスキップ |
| `NOTIFICATION_EMAIL_ENABLED` | `false` | - | メール通知の有効化 |
| `NOTIFICATION_FROM` | - | - | 送信元メールアドレス（Service Account に委任されたユーザー） |
| `NOTIFICATION_TO` | - | - | 送信先メールアドレス（カンマ区切り） |
| `RUN_LOCATIONS` | （全事業所） | - | 処理対象の事業所名（カンマ区切り、例: `姶良` / `姶良,谷山`） |
| `SMARTHR_ACCESS_TOKEN` | - | - | SmartHR API トークン（未設定時は同期スキップ） |
| `SMARTHR_BASE_URL` | `https://acg.smarthr.jp/api/v1` | - | SmartHR API URL |
| `LOG_LEVEL` | `info` | - | ログレベル |
| `LOG_DIR` | `./logs` | - | ログ出力先 |
| `SCREENSHOT_DIR` | `./screenshots` | - | スクリーンショット一時保存先 |

---

## 2-16. 利用者マスタ CSV 自動ダウンロード

**ソース**: `src/services/patient-csv-downloader.service.ts`, `src/services/patient-master.service.ts`

### 概要
HAM の利用者一覧画面から CSV ファイルを自動ダウンロードし、要介護度等のマスタ情報を取得する。I5フローでの予防/介護判定、サービスコード選択に使用。

### ダウンロードフロー
```
HAM t1-2 → u1-1（利用者一覧）
  → img#Image2 (user_list.jpg) クリック
    → CSV出力ボタン クリック
      → Playwright download event でファイル保存
```

### ローカルキャッシュ戦略
`ensurePatientCsv()` の検索優先順位:
1. `./downloads/*userallfull*{YYYYMM}*.csv` → ローカルキャッシュ使用
2. プロジェクトルート `./*userallfull*{YYYYMM}*.csv` → フォールバック
3. いずれもなし → HAM から自動ダウンロード

月1回のダウンロードで十分（利用者マスタは頻繁に変更されないため）。

---

## 2-17. 既知の制約事項

### スタッフ選択不可（終了時間重叠問題）

HAM の終了時間は `timetype` に基づいて自動計算される（手動修正しない方針: 専務確認済み 2026-02-26）。

**問題**: 自動計算された終了時間と、同一スタッフの別利用者への訪問開始時間が重複する場合がある。
- 例: 利用者Aの終了時間が自動計算で 11:10、利用者Bの開始時間が 11:00 → 10分の重複が発生
- HAM は時間重複のあるスタッフを従業員リストに表示しない
- RPA は「スタッフが見つかりません」エラー（`エラー：マスタ不備`）として記録する

**原因**: HAM の仕様に起因。RPA 側では回避不可能。

**対処方法**: 該当レコードはエラーとして記録される。手動で HAM 上の終了時間を調整した後、S列をクリアして再転記する。
