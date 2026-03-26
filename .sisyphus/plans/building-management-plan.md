# 同一建物管理 実装計画

## 概要

毎月3日に前月の入居利用者を、連携スプレッドシートから読み取り、カナミック TRITRUS の同一建物管理画面に自動登録する RPA ワークフロー。

## 前提条件（未確認事項）

以下3点はユーザー確認待ち。計画は「C: カナミック登録のみ」前提で進め、データ取得は後続フェーズとする。

1. **データ取得の実装方式** — GAS側で拡張 or Node.js移植？→ 計画では連携シートにデータ済みを前提
2. **共同生活援助のデータ元スプレッドシートID** — 後続フェーズで対応
3. **施設IDマッピング管理方法** — 計画では施設一覧ページから動的スクレイピング

---

## Phase 1: 基盤整備

### Task 1.1: .env に設定追加

```
BUILDING_MGMT_SHEET_ID=18DueDsYPsNmePiYIp9hVpD1rIWWMCyPX5SdWzXOnZBY
```

### Task 1.2: BuildingManagementRecord 型の修正

**ファイル**: `src/types/spreadsheet.types.ts`

現在の型は月度タブのヘッダと一致していない。実際のヘッダ:
```
A: 入居施設 | B: あおぞらID | C: 利用者名 | D: 利用訪問看護事業所名 | E: 入居日 | F: 退去日 | G: 新規フラグ | H: ステータス | I: 備考
```

修正後:
```typescript
export interface BuildingManagementRecord {
  rowIndex: number;
  facilityName: string;        // A: 入居施設（カナミック登録施設名）
  aozoraId: string;            // B: あおぞらID
  userName: string;            // C: 利用者名
  nursingOfficeName: string;   // D: 利用訪問看護事業所名
  moveInDate: string;          // E: 入居日
  moveOutDate?: string;        // F: 退去日
  isNew: boolean;              // G: 新規フラグ
  status: string;              // H: ステータス
  notes?: string;              // I: 備考
}
```
→ 現在の型と同一。変更不要。

### Task 1.3: getBuildingManagementRecords に tab パラメータ追加

**ファイル**: `src/services/spreadsheet.service.ts`

現在:
```typescript
async getBuildingManagementRecords(sheetId: string): Promise<BuildingManagementRecord[]> {
    const range = '同一建物管理!A2:I';
```

修正: tab パラメータを追加。月度タブ名は `2026/02` 形式（転記の `2026年02月` とは異なる）。

```typescript
async getBuildingManagementRecords(sheetId: string, tab?: string): Promise<BuildingManagementRecord[]> {
    // デフォルト: 前月タブ（例: "2026/02"）
    tab = tab || this.getPreviousMonthBuildingTab();
    const range = `${tab}!A2:I`;
```

新規ヘルパー追加:
```typescript
private getPreviousMonthBuildingTab(): string {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${prev.getFullYear()}/${String(prev.getMonth() + 1).padStart(2, '0')}`;
}
```

### Task 1.4: updateBuildingManagementStatus に tab パラメータ追加

```typescript
async updateBuildingManagementStatus(sheetId: string, rowIndex: number, status: string, tab?: string, errorDetail?: string): Promise<void> {
    tab = tab || this.getPreviousMonthBuildingTab();
    // H列(ステータス)更新
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tab}!H${rowIndex}`,
      ...
    });
    // I列(備考/エラー)更新
    if (errorDetail !== undefined) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${tab}!I${rowIndex}`,
        ...
      });
    }
}
```

### Task 1.5: 施設定義を読み取るメソッド追加

**ファイル**: `src/services/spreadsheet.service.ts`

```typescript
export interface FacilityDefinition {
  sourceNameA: string;    // A列: 拠点名（有料老人ホーム系）
  sourceNameB: string;    // B列: 拠点名（共同生活援助系）
  kanamickName: string;   // C列: カナミック登録施設名
}

async getFacilityDefinitions(sheetId: string): Promise<FacilityDefinition[]> {
    const range = '施設定義!A2:C';
    const response = await this.sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    const rows = response.data.values || [];
    return rows.filter(r => r[2]).map(r => ({
      sourceNameA: r[0] || '',
      sourceNameB: r[1] || '',
      kanamickName: r[2] || '',
    }));
}
```

---

## Phase 2: TRITRUS 同一建物管理ナビゲーション

### Task 2.1: PremisesNavigator クラス新規作成

**ファイル**: `src/core/premises-navigator.ts`（新規）

TRITRUS ポータルの同一建物管理ページを操作する専用ナビゲータ。
HAM の iframe 構造とは完全に別。TRITRUS ポータルページ（Tab 0）で直接操作。

```typescript
export class PremisesNavigator {
  private page: Page;
  
  constructor(page: Page) {
    this.page = page;
  }
  
  /** 施設一覧ページへ遷移 */
  async navigateToPremisesList(): Promise<void> {
    await this.page.goto('https://portal.kanamic.net/tritrus/premisesIndex/index');
    await this.page.waitForSelector('button.select_editBtn');
  }
  
  /** 施設一覧から施設名→premisesId マッピングを取得 */
  async scrapePremisesMapping(): Promise<Map<string, number>> {
    // テーブルの各行から施設名とonclick内のIDを抽出
    return await this.page.evaluate(() => {
      const map: Record<string, number> = {};
      document.querySelectorAll('tbody tr').forEach(tr => {
        const name = tr.querySelector('td:first-child')?.textContent?.trim() || '';
        const btn = tr.querySelector('button[onclick]');
        const match = btn?.getAttribute('onclick')?.match(/transferPremisesUpdate\((\d+)\)/);
        if (name && match) map[name] = parseInt(match[1]);
      });
      return map;
    });
  }
  
  /** 特定の施設詳細ページに遷移 */
  async openFacilityDetail(premisesId: number): Promise<void> {
    await this.page.evaluate((id) => {
      (window as any).transferPremisesUpdate(id);
    }, premisesId);
    await this.page.waitForSelector('button[onclick*="openCareuserWindow"]');
  }
  
  /** 利用者追加弾窗を開く */
  async openAddUserDialog(): Promise<void> {
    await this.page.evaluate(() => {
      (window as any).openCareuserWindow();
    });
    // ポップアップ or モーダル待機
    await this.page.waitForSelector('#chkCareuserSelectAll', { timeout: 10000 });
  }
  
  /** 弾窗内で利用者を検索してチェック */
  async selectUserInDialog(userName: string, officeName: string): Promise<boolean> {
    // テーブル行を走査し、事業所名+利用者名が一致する行をチェック
    return await this.page.evaluate(({ userName, officeName }) => {
      let found = false;
      for (let i = 0; ; i++) {
        const nameEl = document.getElementById(`careuser_name_${i}`);
        if (!nameEl) break;
        const officeEl = document.getElementById(`careuser_serviceofficeName_${i}`);
        const name = nameEl.textContent?.replace(/[\s\u3000]/g, '') || '';
        const office = officeEl?.textContent?.trim() || '';
        if (name === userName.replace(/[\s\u3000]/g, '') && office.includes(officeName)) {
          const checkbox = document.getElementById(`chkCareuserSelect_${i}`) as HTMLInputElement;
          if (checkbox && !checkbox.checked) checkbox.click();
          found = true;
          break; // 最初の一致で停止
        }
      }
      return found;
    }, { userName, officeName });
  }
  
  /** 追加確定 */
  async confirmAddUser(): Promise<void> {
    await this.page.evaluate(() => {
      (window as any).addCareuserToMain();
    });
    // 確認ダイアログ対応（alert/confirm があれば）
    // 追加完了後のページ遷移待機
    await this.page.waitForLoadState('networkidle', { timeout: 10000 });
  }
  
  /** 施設一覧に戻る */
  async backToPremisesList(): Promise<void> {
    await this.navigateToPremisesList();
  }
}
```

### Task 2.2: 施設名マッチングロジック

TRITRUS の施設一覧名は `★【武】鹿児島市武3-13-4` 形式、スプレッドシートの施設名は `共生ホーム武` 形式。

マッチング戦略:
1. TRITRUS 施設名から `★【XXX】` の XXX 部分を抽出
2. スプレッドシートの施設名の末尾と照合

マッピング例（HTMLから取得済み）:
```
★【武】→ 7870        → 共生ホーム武
★【東千石】→ 7868    → 共生ホーム東千石
★【笹貫】→ 7869      → 共生ホーム笹貫
★【下荒田】→ 7872    → 共生ホーム下荒田
★【南栄】→ 7881      → 共生ホーム南栄
★【野芥】→ 7883      → 共生ホーム野芥
★【田村】→ 7871      → 共生ホーム田村（注: 田上=7871、要確認）
★【博多】→ 7882      → 有料老人ホームあおぞら博多
★【永吉】→ 7873      → 有料老人ホームあおぞら永吉
★【七福の里】→ 7884  → 七福の里
★【宇美】→ 7879      → 有料老人ホームあおぞら宇美
★【油山】→ 9679      → 有料老人ホームあおぞら油山
★【上荒田】→ 7877    → 共同生活援助あおぞら上荒田
★【上塩屋】→ 7878    → 共同生活援助あおぞら上塩屋
★【小松原】→ 7885    → 共同生活援助あおぞら小松原
★【天文館】→ 7880    → 共同生活援助あおぞら天文館
★【紫原】→ 7874      → 共同生活援助あおぞら紫原
★【真砂本町】→ 7876  → 共同生活援助あおぞら真砂本町
★【梅ヶ丘】→ 7477    → 地域密着型特別養護老人ホームあおぞら梅ヶ丘
梅ヶ丘 → 7537         → 梅ヶ丘（別施設）
うらら認知症GH → 8955
うらら介護付有料 → 8954
四元 → 8953
（未使用）笑苑 → 7478
★【宇宿】→ 7875      → ?
```

→ 初回起動時に `scrapePremisesMapping()` でHTMLから取得し、`★【XXX】` → カナミック施設名のマッチングテーブルを構築。

---

## Phase 3: building.workflow.ts 完全書き直し

### Task 3.1: ワークフロー構造

**ファイル**: `src/workflows/building-management/building.workflow.ts`

```
run(context)
  ├── 1. 連携シートから施設定義読み込み
  ├── 2. 月度タブからレコード読み込み + フィルタ（新規 & 未登録）
  ├── 3. 施設ごとにグループ化
  ├── 4. TRITRUS にログイン（既存 auth.login() 利用）
  ├── 5. 施設一覧ページへ遷移 + premisesId マッピング取得
  ├── 6. 施設ループ:
  │     ├── 6a. 施設詳細ページへ遷移（premisesId）
  │     ├── 6b. 利用者追加弾窗を開く
  │     ├── 6c. 利用者ループ:
  │     │     ├── 弾窗内で利用者名+事業所名で検索
  │     │     ├── チェックボックスON
  │     │     └── マッチ失敗 → エラーログ
  │     ├── 6d. 追加確定（addCareuserToMain）
  │     ├── 6e. ステータス書き戻し（登録済み or エラー）
  │     └── 6f. 施設一覧に戻る
  └── 7. 結果レポート
```

### Task 3.2: 重要な注意点

1. **TRITRUS ポータルページで操作**（HAM iframe ではない）
   - `auth.login()` 後、`navigator.tritrusPage` を使用
   - HAM タブは開かない（or 不要）

2. **弾窗の同名利用者問題**
   - 青空太郎が2行出る例がHTML内にある（careuid が異なる）
   - マッチング: 利用者名 + 事業所名の両方で一致する行を選択
   - それでも複数一致 → 最初の未チェック行を選択 + 備考にワーニング

3. **弾窗は施設詳細ページ内のモーダル**（新しい window.open ではない可能性）
   - `openCareuserWindow()` の挙動を実機で要確認
   - popup の場合は `page.waitForEvent('popup')` で対応

4. **既に追加済みの利用者は弾窗に表示されない可能性**
   - 新規フラグが TRUE のレコードのみ処理

5. **連続エラー熔断器**
   - 転記ワークフローと同様、3連続エラーで自動停止

### Task 3.3: 実行スクリプト

**ファイル**: `src/scripts/run-building.ts`（新規）

```typescript
// npx tsx src/scripts/run-building.ts
// npx tsx src/scripts/run-building.ts --tab=2026/02
// npx tsx src/scripts/run-building.ts --dry-run
```

---

## Phase 4: テスト・検証

### Task 4.1: 施設一覧スクレイピング検証スクリプト

**ファイル**: `src/scripts/explore-premises.ts`（新規）

TRITRUS にログインし、施設一覧から全施設名+premisesId を取得して表示するだけの検証スクリプト。
まずこれで施設名マッチングの精度を確認する。

### Task 4.2: 利用者追加弾窗の動作確認

`explore-premises.ts` を拡張し、特定の施設で `openCareuserWindow()` を実行し弾窗の HTML 構造をダンプ。

### Task 4.3: ドライランモード

`--dry-run` で実際の `addCareuserToMain()` は実行せず、マッチング結果のみ表示。

### Task 4.4: 実機テスト

1. 1施設分の小規模テスト（手動でシートに1-2件入力）
2. 全施設テスト

---

## 実装順序（推奨）

```
Phase 1 (基盤) → Phase 2 (ナビゲータ) → Task 4.1 (施設一覧検証)
    → Task 4.2 (弾窗確認) → Phase 3 (ワークフロー) → Task 4.3-4.4 (テスト)
```

全体見積り: コード実装 4-6時間 + 実機テスト 2-3時間

---

## 付録: TRITRUS 施設一覧 HTML から取得済みの premisesId マッピング

| TRITRUS 施設名 | premisesId |
|---|---|
| 梅ヶ丘 | 7537 |
| うらら認知症GH | 8955 |
| うらら介護付有料 | 8954 |
| ★【油山】 | 9679 |
| ★【上荒田】 | 7877 |
| ★【宇宿】 | 7875 |
| ★【宇美】 | 7879 |
| ★【梅ヶ丘】 | 7477 |
| ★【上塩屋】 | 7878 |
| ★【小松原】 | 7885 |
| ★【笹貫】 | 7869 |
| ★【七福の里】 | 7884 |
| ★【下荒田】 | 7872 |
| ★【田上】 | 7871 |
| ★【武】 | 7870 |
| ★【天文館】 | 7880 |
| ★【永吉】 | 7873 |
| ★【南栄】 | 7881 |
| ★【野芥】 | 7883 |
| ★【博多】 | 7882 |
| ★【東千石】 | 7868 |
| ★【真砂本町】 | 7876 |
| ★【紫原】 | 7874 |
| （未使用）笑苑 | 7478 |
| 四元 | 8953 |

## 付録: 利用者追加弾窗の HTML ID 規則

```
行 N (0-indexed):
  checkbox:   #chkCareuserSelect_{N}
  事業所名:    #careuser_serviceofficeName_{N}
  利用者名:    #careuser_name_{N}  (全角スペース区切り "青空　太郎")
  性別:       #careuser_sexName_{N}
  被保険者番号: #careuser_insurantcd_{N}
  hidden:
    - #careuser_serviceofficeid_{N} (事業所コード e.g. "400021814")
    - #careuser_careuid_{N}         (利用者固有ID e.g. "8806571")
    - #careuser_firstname_{N}       (姓)
    - #careuser_lastname_{N}        (名)
    - #careuser_cichamFlag_{N}      (常に "1")
  入居日:     #careuser_applydateStartJp_{N} (warekidatepicker)
  退去日:     #careuser_applydateEndJp_{N}   (warekidatepicker)

全選択: #chkCareuserSelectAll → selectAllCareuser()
追加確定: addCareuserToMain()
```
