/**
 * TRITRUS 同一建物管理ページナビゲーター
 *
 * TRITRUS ポータル（Tab 0）の同一建物管理ページを操作する。
 * HAM iframe 構造とは完全に別で、通常の Page 操作を使う。
 *
 * ページ構造:
 *   /tritrus/premisesIndex/index — 施設一覧
 *     ├── テーブル: 施設名 + button[onclick="transferPremisesUpdate({premisesId})"]
 *     └── button[onclick="transferPremisesUpdate({id})"] → 施設詳細
 *   /tritrus/premisesDetail/index — 施設詳細
 *     ├── 施設名、事業所設定（上部）
 *     ├── 施設利用者テーブル（登録済み利用者）
 *     │   ├── #applydateStart_{N} — 入居日（warekidatepicker, readonly）
 *     │   └── #applydateEnd_{N}   — 退去日（warekidatepicker, readonly）
 *     ├── button「利用者を追加」→ openCareuserWindow() → 利用者選択弾窗
 *     ├── button「保存して戻る」→ saveAndTransferIndexForm()
 *     └── button「保存しないで戻る」→ transferIndexForm()
 *   利用者選択弾窗（remodal モーダル #addCareuserDiv）:
 *     ├── #chkCareuserSelect_{N}  — checkbox（CSS非表示、label経由でクリック）
 *     ├── #careuser_name_{N}       — 利用者名（全角スペース区切り）
 *     ├── #careuser_serviceofficeName_{N} — 事業所名
 *     ├── button「追加する」→ addCareuserToMain() → 弾窗閉じ、利用者テーブルに追加
 *     └── button「キャンセル」
 *
 * 登録フロー:
 *   1. 施設詳細 → 「利用者を追加」→ 弾窗でチェック → 「追加する」→ 弾窗閉じる
 *   2. 施設詳細の利用者テーブルで入居日・退去日を入力
 *   3. 「保存して戻る」→ 保存＋施設一覧に遷移
 */
import { Page } from 'playwright';
import { logger } from './logger';

/** 施設一覧から取得した施設マッピング */
export interface PremisesMapping {
  /** TRITRUS上の施設名（例: "★【武】鹿児島市武3-13-4"） */
  tritrusName: string;
  /** premisesId（例: 7870） */
  premisesId: number;
}

/** 弾窗内の利用者行情報 */
export interface DialogUserRow {
  /** 行インデックス（0-based） */
  index: number;
  /** 利用者名（全角スペース除去済み） */
  userName: string;
  /** 事業所名 */
  officeName: string;
  /** チェック済みかどうか */
  checked: boolean;
  /** careuid（内部ID） */
  careuid: string;
}

/**
 * TRITRUS施設名 → 連携シート施設名のマッチングテーブル
 *
 * TRITRUS 施設一覧の施設名は以下2形式:
 *   1. "★【XXX】住所..." — ★付きは拠点名が【】内にある
 *   2. "XXX" — ★なしはそのまま施設名
 *
 * 連携シートの施設名は「共生ホーム武」「有料老人ホームあおぞら博多」等のカナミック登録名。
 *
 * マッチング戦略:
 *   ※ ★付き施設は弃用済み（旧拠点）のためマッチング対象外
 *   1. 非★施設名から短縮名を抽出して照合
 *   2. 特殊ケースはハードコードマッピングで対応
 */
const TRITRUS_TO_KANAMICK_OVERRIDES: Record<string, string> = {
  // TRITRUS名 → 連携シート施設名（自動マッチングで解決できない例外）
  // 注: うらら・四元は旧施設(8953-8955)と新施設(10470-10472)が共存。
  //     新施設は完全一致(step 2)で先にマッチするため、旧施設のoverride不要。
  '有料老人ホームあおぞら': '有料老人ホームあおぞら', // 田上。末尾に地名なしのため完全一致で固定
  '共同生活援助あおぞら': '共同生活援助あおぞら', // 宇宿。末尾に地名なしのため完全一致で固定
  '共生ホーム田村': '有料老人ホームあおぞら田村', // 連携シートでは「有料老人ホームあおぞら田村」だがTRITRUSでは「共生ホーム田村」
};

export class PremisesNavigator {
  private page: Page;
  private premisesBaseUrl: string;

  constructor(page: Page, baseUrl = 'https://portal.kanamic.net') {
    this.page = page;
    this.premisesBaseUrl = baseUrl;
  }

  // ─── 施設一覧 ────────────────────────────────────────

  /** 施設一覧ページへ遷移 */
  async navigateToPremisesList(): Promise<void> {
    const url = `${this.premisesBaseUrl}/tritrus/premisesIndex/index`;
    logger.info(`施設一覧へ遷移: ${url}`);
    await this.page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    // 施設選択ボタンが表示されるまで待機
    await this.page.waitForSelector('button[onclick*="transferPremisesUpdate"]', { timeout: 15000 });
    logger.debug('施設一覧ページ読み込み完了');
  }

  /**
   * 施設一覧テーブルから施設名 → premisesId のマッピングを取得
   *
   * HTML 構造:
   *   <tbody>
   *     <tr>
   *       <td>★【武】鹿児島市武3-13-4</td>
   *       ...
   *       <td><button onclick="transferPremisesUpdate(7870)">選択</button></td>
   *     </tr>
   *   </tbody>
   */
  async scrapePremisesMapping(): Promise<PremisesMapping[]> {
    const mappings = await this.page.evaluate(() => {
      const results: { tritrusName: string; premisesId: number }[] = [];
      const rows = document.querySelectorAll('tbody tr');
      rows.forEach(tr => {
        const nameCell = tr.querySelector('td:first-child');
        const name = nameCell?.textContent?.trim() || '';
        const btn = tr.querySelector('button[onclick*="transferPremisesUpdate"]');
        const match = btn?.getAttribute('onclick')?.match(/transferPremisesUpdate\((\d+)\)/);
        if (name && match) {
          results.push({ tritrusName: name, premisesId: parseInt(match[1]) });
        }
      });
      return results;
    });

    logger.info(`施設一覧: ${mappings.length} 件取得`);
    for (const m of mappings) {
      logger.debug(`  ${m.tritrusName} → premisesId=${m.premisesId}`);
    }
    return mappings;
  }

  /**
   * TRITRUS 施設マッピングから、連携シートの施設名 → premisesId の変換テーブルを構築
   *
   * @param mappings scrapePremisesMapping() の結果
   * @param sheetFacilityNames 連携シートに存在する施設名の一覧
   * @returns Map<連携シート施設名, premisesId>
   */
  buildFacilityToPremisesMap(
    mappings: PremisesMapping[],
    sheetFacilityNames: string[],
  ): { matched: Map<string, number>; unmatched: string[] } {
    const matched = new Map<string, number>();
    const unmatched: string[] = [];

    for (const sheetName of sheetFacilityNames) {
      const premisesId = this.findPremisesId(sheetName, mappings);
      if (premisesId !== null) {
        matched.set(sheetName, premisesId);
      } else {
        unmatched.push(sheetName);
      }
    }

    return { matched, unmatched };
  }

  /**
   * 連携シートの施設名から premisesId を検索
   */
  private findPremisesId(sheetFacilityName: string, mappings: PremisesMapping[]): number | null {
    // 1. ハードコードオーバーライドの逆引き:
    //    TRITRUS_TO_KANAMICK_OVERRIDES の value が sheetFacilityName と一致する場合、
    //    対応する key（TRITRUS名）で非★施設を完全一致検索
    for (const [tritrusKey, kanamickName] of Object.entries(TRITRUS_TO_KANAMICK_OVERRIDES)) {
      if (kanamickName === sheetFacilityName) {
        // 完全一致を優先（「共同生活援助あおぞら」が「共同生活援助あおぞら上荒田」にマッチするのを防止）
        const exactMapping = mappings.find(m =>
          !m.tritrusName.startsWith('★') && m.tritrusName === tritrusKey
        );
        if (exactMapping) return exactMapping.premisesId;
      }
    }

    // 2. 非★施設名で完全一致（最優先）
    const exactMatch = mappings.find(m =>
      !m.tritrusName.startsWith('★') && m.tritrusName === sheetFacilityName
    );
    if (exactMatch) return exactMatch.premisesId;

    // 3. 非★施設で拠点短縮名を照合（★施設は弃用済みのため除外）
    //    連携シート: "共生ホーム武" → "武" を抽出
    //    TRITRUS: "共生ホーム武" → "武" 含む → マッチ
    const shortName = this.extractShortName(sheetFacilityName);
    if (shortName) {
      const partialMatch = mappings.find(m =>
        !m.tritrusName.startsWith('★') && m.tritrusName.includes(shortName)
      );
      if (partialMatch) return partialMatch.premisesId;
    }

    // 4. 非★施設名全体の部分一致（フォールバック）
    const directMatch = mappings.find(m =>
      !m.tritrusName.startsWith('★') &&
      (m.tritrusName.includes(sheetFacilityName) || sheetFacilityName.includes(m.tritrusName))
    );
    if (directMatch) return directMatch.premisesId;

    return null;
  }

  /**
   * カナミック施設名から拠点短縮名を抽出
   *
   * "共生ホーム武" → "武"
   * "有料老人ホームあおぞら博多" → "博多"
   * "共同生活援助あおぞら小松原" → "小松原"
   * "七福の里" → "七福の里"
   * "地域密着型特別養護老人ホームあおぞら梅ヶ丘" → "梅ヶ丘"
   * "介護付有料老人ホームうらら" → "うらら"（※オーバーライドで処理済み）
   */
  private extractShortName(facilityName: string): string | null {
    // 末尾の拠点名を取得するパターン（長い接頭辞を除去）
    const prefixes = [
      '地域密着型特別養護老人ホームあおぞら',
      '介護付有料老人ホームあおぞら',
      '介護付有料老人ホーム',
      '有料老人ホームあおぞら',
      '共同生活援助あおぞら',
      '共生ホーム',
      'グループホーム',
    ];
    for (const prefix of prefixes) {
      if (facilityName.startsWith(prefix) && facilityName.length > prefix.length) {
        return facilityName.slice(prefix.length);
      }
    }
    // プレフィックスが見つからない場合はそのまま返す
    return facilityName;
  }

  // ─── 施設詳細 ────────────────────────────────────────

  /**
   * 施設詳細（編集）ページへ遷移
   *
   * 施設一覧テーブルの該当行の「施設情報・編集」ボタンをクリック。
   * onclick="return transferPremisesUpdate({id})" で遷移する。
   */
  async openFacilityDetail(premisesId: number): Promise<void> {
    logger.debug(`施設詳細へ遷移: premisesId=${premisesId}`);

    // 施設一覧の該当行の「施設情報・編集」ボタンをクリック → ページ遷移
    const selector = `button[onclick*="transferPremisesUpdate(${premisesId})"]`;
    await Promise.all([
      this.page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
      this.page.click(selector),
    ]);

    logger.debug(`施設詳細ページ表示完了: premisesId=${premisesId}`);
  }

  /**
   * 施設詳細ページで既に登録済みの利用者名一覧を取得
   * 重複登録を防止するために使用
   */
  async getRegisteredUsers(): Promise<string[]> {
    return this.page.evaluate(() => {
      const names: string[] = [];
      // 施設詳細の利用者テーブルから名前を取得
      const rows = document.querySelectorAll('table tbody tr');
      rows.forEach(tr => {
        const cells = tr.querySelectorAll('td');
        // 利用者名は通常2列目（事業所名, 利用者名, ...）
        if (cells.length >= 2) {
          const name = cells[1]?.textContent?.trim().replace(/[\s\u3000]/g, '') || '';
          if (name) names.push(name);
        }
      });
      return names;
    });
  }

  // ─── 利用者追加弾窗 ────────────────────────────────────

  /**
   * 利用者追加弾窗を開く
   */
  async openAddUserDialog(): Promise<void> {
    logger.debug('利用者追加弾窗を開きます');

    // 「利用者を追加」ボタンをクリック（onclick="return openCareuserWindow();"）
    await this.page.click('button[onclick*="openCareuserWindow"]');

    // 弾窗 remodal が開くまで待機
    await this.page.waitForSelector('#addCareuserDiv.remodal-is-opened', { timeout: 15000 });
    await this.sleep(1000); // DOM 安定待ち
    logger.debug('利用者追加弾窗が開きました');
  }

  /**
   * 弾窗内の全利用者行を取得
   */
  async getDialogUsers(): Promise<DialogUserRow[]> {
    return this.page.evaluate(() => {
      const rows: { index: number; userName: string; officeName: string; checked: boolean; careuid: string }[] = [];
      for (let i = 0; ; i++) {
        const nameEl = document.getElementById(`careuser_name_${i}`);
        if (!nameEl) break;

        const officeEl = document.getElementById(`careuser_serviceofficeName_${i}`);
        const checkbox = document.getElementById(`chkCareuserSelect_${i}`) as HTMLInputElement | null;
        const careuIdEl = document.getElementById(`careuser_careuid_${i}`) as HTMLInputElement | null;

        rows.push({
          index: i,
          userName: (nameEl.textContent || '').replace(/[\s\u3000]/g, ''),
          officeName: officeEl?.textContent?.trim() || '',
          checked: checkbox?.checked || false,
          careuid: careuIdEl?.value || '',
        });
      }
      return rows;
    });
  }

  /**
   * 弾窗内で利用者を名前+事業所名でマッチしてチェック
   *
   * マッチングロジック:
   *   1. 利用者名の完全一致（スペース除去後）
   *   2. 事業所名の部分一致（訪問看護事業所名がカンマ区切りの場合もある）
   *   3. 複数一致 → 最初の未チェック行を選択（ワーニング付き）
   *
   * @returns マッチした行のインデックス。見つからなければ null
   */
  async selectUserInDialog(
    userName: string,
    nursingOfficeName: string,
  ): Promise<{ matchedIndex: number; multipleMatches: boolean } | null> {
    const normalizedName = userName.replace(/[\s\u3000]/g, '');
    // 事業所名はカンマ区切りの可能性がある
    const officeNames = nursingOfficeName.split(',').map(s => s.trim());

    const result = await this.page.evaluate(
      ({ normalizedName, officeNames }) => {
        const matches: number[] = [];
        for (let i = 0; ; i++) {
          const nameEl = document.getElementById(`careuser_name_${i}`);
          if (!nameEl) break;

          const dialogName = (nameEl.textContent || '').replace(/[\s\u3000]/g, '');
          const officeEl = document.getElementById(`careuser_serviceofficeName_${i}`);
          const dialogOffice = officeEl?.textContent?.trim() || '';

          // 名前一致チェック
          if (dialogName !== normalizedName) continue;

          // 事業所名一致チェック（いずれかの事業所名が含まれていればOK）
          const officeMatch = officeNames.some(office => dialogOffice.includes(office));
          if (!officeMatch && officeNames.length > 0 && officeNames[0] !== '') continue;

          matches.push(i);
        }

        if (matches.length === 0) return null;

        // 最初の未チェック行を選択
        let targetIndex = matches[0];
        for (const idx of matches) {
          const cb = document.getElementById(`chkCareuserSelect_${idx}`) as HTMLInputElement | null;
          if (cb && !cb.checked) {
            targetIndex = idx;
            break;
          }
        }

        // チェック
        const checkbox = document.getElementById(`chkCareuserSelect_${targetIndex}`) as HTMLInputElement;
        if (checkbox && !checkbox.checked) {
          checkbox.click();
        }

        return { matchedIndex: targetIndex, multipleMatches: matches.length > 1 };
      },
      { normalizedName, officeNames },
    );

    return result;
  }

  /**
   * 弾窗の「追加する」ボタンを押す（addCareuserToMain）
   *
   * 弾窗が閉じ、選択した利用者が施設詳細の利用者テーブルに追加される。
   * ※ この時点ではまだ保存されていない。入居日・退去日設定後に saveAndReturn() が必要。
   */
  async confirmAddUsers(): Promise<void> {
    logger.debug('弾窗「追加する」実行');

    // 追加前の利用者数を記録（追加成功の確認用）
    const beforeCount = await this.getDetailUserCount();

    // 弾窗内の「追加する」ボタンをクリック（onclick="addCareuserToMain()" + remodal 閉じ処理）
    await this.page.click('#addCareuserDiv button[onclick*="addCareuserToMain"]');

    // remodal が閉じるのを待機
    try {
      await this.page.waitForFunction(
        () => !document.querySelector('.remodal-wrapper.remodal-is-opened'),
        { timeout: 15000 },
      );
    } catch {
      logger.warn('confirmAddUsers: remodal クローズ待機タイムアウト');
    }

    await this.sleep(1000); // DOM 安定化

    // 利用者テーブルに新しい行が追加されたことを確認
    const afterCount = await this.getDetailUserCount();
    if (afterCount > beforeCount) {
      logger.debug(`弾窗「追加する」完了 — 利用者テーブル: ${beforeCount} → ${afterCount}件`);
    } else {
      logger.warn(`弾窗「追加する」後の利用者数が増えていません: ${beforeCount} → ${afterCount}`);
    }
  }

  // ─── 施設詳細ページ：入居日・退去日・保存 ─────────────────

  /**
   * 施設詳細ページの利用者テーブルで入居日を設定
   *
   * 追加後のHTML:
   *   <input type="text" id="applydateStart_{N}" class="warekidatepicker" readonly>
   *
   * @param rowIndex 利用者テーブルの行インデックス（0-based）
   * @param dateStr 日付文字列（例: "2025/02/03"）
   */
  async setMoveInDate(rowIndex: number, dateStr: string): Promise<void> {
    if (!dateStr) return;
    logger.debug(`入居日設定: row=${rowIndex}, date=${dateStr}`);
    await this.setDateViaWarekiPicker(`applydateStart_${rowIndex}`, dateStr);
  }

  /**
   * 施設詳細ページの利用者テーブルで退去日を設定
   *
   * @param rowIndex 利用者テーブルの行インデックス（0-based）
   * @param dateStr 日付文字列（空白なら何もしない）
   */
  async setMoveOutDate(rowIndex: number, dateStr: string): Promise<void> {
    if (!dateStr) return;
    logger.debug(`退去日設定: row=${rowIndex}, date=${dateStr}`);
    await this.setDateViaWarekiPicker(`applydateEnd_${rowIndex}`, dateStr);
  }

  /**
   * 施設詳細ページの利用者テーブルの行数を取得
   * confirmAddUsers() 後に、新しい利用者が何行目に追加されたかを特定するために使用
   */
  async getDetailUserCount(): Promise<number> {
    return this.page.evaluate(() => {
      let count = 0;
      for (let i = 0; ; i++) {
        const el = document.getElementById(`applydateStart_${i}`);
        if (!el) break;
        count++;
      }
      return count;
    });
  }

  /**
   * 「保存して戻る」ボタンを押す（saveAndTransferIndexForm）
   *
   * 入居日・退去日の設定が完了した後に呼ぶ。
   * 保存して施設一覧ページへ遷移する。
   */
  async saveAndReturn(): Promise<void> {
    logger.debug('「保存して戻る」実行');

    // saveAndTransferIndexForm() は JS confirm() を呼ぶ可能性がある
    const dialogHandler = (dialog: { accept: () => Promise<void> }) => {
      logger.debug('JS ダイアログ検出 → 自動承認');
      void dialog.accept();
    };
    this.page.on('dialog', dialogHandler);

    try {
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }),
        this.page.evaluate(() => {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          (window as any).saveAndTransferIndexForm();
          /* eslint-enable @typescript-eslint/no-explicit-any */
        }),
      ]);
    } finally {
      this.page.removeListener('dialog', dialogHandler);
    }

    // 保存後のページ状態を確認:
    //   パターン1: 成功ポップアップ (#saveSuccessDivOkBtn) → OK クリック → 施設一覧
    //   パターン2: 直接施設一覧に遷移 (button[onclick*="transferPremisesUpdate"])
    //   パターン3: どちらでもない（エラーページ等）→ 直接 URL 遷移
    const okBtn = await this.page.$('#saveSuccessDivOkBtn').catch(() => null);
    if (okBtn) {
      logger.debug('保存完了ポップアップ「OK」をクリック');
      try {
        await Promise.all([
          this.page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
          okBtn.click(),
        ]);
      } catch {
        logger.warn('OK クリック後のナビゲーション失敗 → 直接遷移');
        await this.navigateToPremisesList();
        return;
      }
    } else {
      logger.debug('保存完了ポップアップなし（スキップ）');
    }

    // 施設一覧ページに遷移したことを確認（失敗時は直接遷移）
    try {
      await this.page.waitForSelector('button[onclick*="transferPremisesUpdate"]', { timeout: 10000 });
      logger.info('保存完了 — 施設一覧に戻りました');
    } catch {
      logger.warn('施設一覧ボタンが見つからない → 直接遷移します');
      await this.navigateToPremisesList();
      logger.info('保存完了 — 施設一覧に直接遷移しました');
    }
  }

  /**
   * 「保存しないで戻る」— 施設一覧に戻る（変更破棄）
   */
  async returnWithoutSave(): Promise<void> {
    logger.debug('「保存しないで戻る」実行');

    // transferIndexForm() も confirm() を呼ぶ可能性がある
    const dialogHandler = (dialog: { accept: () => Promise<void> }) => {
      void dialog.accept();
    };
    this.page.on('dialog', dialogHandler);

    try {
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
        this.page.evaluate(() => {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          (window as any).transferIndexForm();
          /* eslint-enable @typescript-eslint/no-explicit-any */
        }),
      ]);
    } finally {
      this.page.removeListener('dialog', dialogHandler);
    }

    await this.page.waitForSelector('button[onclick*="transferPremisesUpdate"]', { timeout: 15000 });
    logger.debug('施設一覧に戻りました（保存なし）');
  }

  /**
   * 弾窗を閉じる（追加せずにキャンセル）
   */
  async closeDialog(): Promise<void> {
    // remodal の × 閉じるボタン
    const closeBtn = await this.page.$('#addCareuserDiv button:has-text("閉じる"), #addCareuserDiv .remodal-close');
    if (closeBtn) {
      await closeBtn.click();
    } else {
      // フォールバック: キャンセルボタン
      const cancelBtn = await this.page.$('#addCareuserDiv button:has-text("キャンセル")');
      if (cancelBtn) await cancelBtn.click();
    }
    await this.sleep(500);
  }

  // ─── ユーティリティ ────────────────────────────────────

  /**
   * warekidatepicker 日付設定 — 日历UI操作方式
   *
   * 日历ポップアップを開き、年・月を select で選択後、日付セルをクリック。
   * クリック後は自動的に input.value が設定され、日历が閉じる。
   *
   * 日历構造（warekidatepicker 独自 — jQuery UI datepicker とは別物）:
   *   - 年: select（和暦、例: "令和7" = 2025, "令和8" = 2026）
   *   - 月: select（1〜12）
   *   - 日: テーブル内のセル（クリックで選択）
   *
   * 西暦→和暦変換: 令和 = 西暦 - 2018（令和1年 = 2019年）
   *
   * @param elementId input 要素の id（例: "applydateStart_0"）
   * @param dateStr 日付文字列（"YYYY/MM/DD" 形式、例: "2025/02/03"）
   */
  private async setDateViaWarekiPicker(elementId: string, dateStr: string): Promise<void> {
    const parts = dateStr.split('/');
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10); // 1-based
    const day = parseInt(parts[2], 10);

    // Step 1: input をクリックして日历を開く
    const inputSelector = `#${elementId}`;
    await this.page.click(inputSelector);
    await this.sleep(1000);

    // Step 2: 日历ポップアップの存在確認 + 年月セレクト操作
    // warekidatepicker の日历は年 select と月 select を持つ
    const calendarSet = await this.page.evaluate(
      ({ targetYear, targetMonth }) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        // 日历ポップアップ内の select を探す
        // warekidatepicker は通常 body 直下 or 特定 div にカレンダーを描画
        const allSelects = Array.from(document.querySelectorAll('select'));

        // 表示中の select を探す（年と月）
        const visibleSelects = allSelects.filter(s => {
          const style = window.getComputedStyle(s);
          return style.display !== 'none' && style.visibility !== 'hidden' && s.offsetParent !== null;
        });

        // 和暦年 select を探す（option に "令和" が含まれる）
        let yearSelect: HTMLSelectElement | null = null;
        let monthSelect: HTMLSelectElement | null = null;

        for (const s of visibleSelects) {
          const firstOpt = s.options[0]?.text || '';
          if (firstOpt.includes('令和') || firstOpt.includes('平成')) {
            yearSelect = s;
          } else if (/^[0-9]+月?$/.test(firstOpt) || s.options.length === 12) {
            monthSelect = s;
          }
        }

        if (!yearSelect || !monthSelect) {
          return {
            success: false,
            error: `年/月 select が見つかりません (visible selects: ${visibleSelects.length})`,
          };
        }

        // 和暦年を計算: 令和N年 = 西暦 - 2018
        const reiwaYear = targetYear - 2018;

        // 年 select を変更
        let yearSet = false;
        for (const opt of Array.from(yearSelect.options)) {
          // option.value が和暦年と完全一致、またはテキストが「令和N」を含む
          // ※ opt.text.includes(String(reiwaYear)) は「平成28」が reiwaYear=8 にマッチするため使用不可
          if (opt.value === String(reiwaYear) || opt.text.includes('令和' + String(reiwaYear))) {
            yearSelect.value = opt.value;
            yearSelect.dispatchEvent(new Event('change', { bubbles: true }));
            yearSet = true;
            break;
          }
        }

        // 月 select を変更（value は月番号 1-12 or 0-11）
        let monthSet = false;
        for (const opt of Array.from(monthSelect.options)) {
          const val = parseInt(opt.value, 10);
          const text = opt.text.replace('月', '');
          if (val === targetMonth || val === targetMonth - 1 || text === String(targetMonth)) {
            monthSelect.value = opt.value;
            monthSelect.dispatchEvent(new Event('change', { bubbles: true }));
            monthSet = true;
            break;
          }
        }

        return {
          success: yearSet && monthSet,
          yearSet,
          monthSet,
          reiwaYear,
          yearOptions: Array.from(yearSelect.options).slice(0, 5).map(o => `${o.value}:${o.text}`),
          monthOptions: Array.from(monthSelect.options).slice(0, 3).map(o => `${o.value}:${o.text}`),
        };
        /* eslint-enable @typescript-eslint/no-explicit-any */
      },
      { targetYear: year, targetMonth: month },
    );

    if (!calendarSet.success) {
      // フォールバック: setDate API
      logger.warn(`日历UI操作失敗 (${calendarSet.error}) → setDate API にフォールバック`);
      await this.setDateFallback(elementId, dateStr);
      return;
    }

    logger.debug(`日历 年月設定: 令和${calendarSet.reiwaYear}年 ${month}月`);
    await this.sleep(500); // 日历テーブル更新待ち

    // Step 3: 日付セルをクリック
    // 日历テーブル内で該当日のセル（a タグ or td）をクリック
    const dayClicked = await this.page.evaluate(
      ({ targetDay }) => {
        // 表示中の日历テーブルから日付セルを探す
        // warekidatepicker のカレンダーは通常 table 内に日付を描画
        const tables = Array.from(document.querySelectorAll('table'));
        for (const table of tables) {
          const style = window.getComputedStyle(table);
          if (style.display === 'none') continue;

          // td 内の a または td 自体にテキストが日付のもの
          const cells = Array.from(table.querySelectorAll('td a, td'));
          for (const cell of cells) {
            const text = (cell.textContent || '').trim();
            if (text === String(targetDay)) {
              // 日付カレンダーのセルか確認（親 table がカレンダーっぽいか）
              const parent = cell.closest('table');
              if (parent && parent.querySelectorAll('td').length > 20) {
                (cell as HTMLElement).click();
                return { success: true, clickedText: text };
              }
            }
          }
        }
        return { success: false };
      },
      { targetDay: day },
    );

    if (dayClicked.success) {
      await this.sleep(500); // 日历閉じ + input 値設定待ち
      const finalValue = await this.page.evaluate(
        (id) => (document.getElementById(id) as HTMLInputElement)?.value || '',
        elementId,
      );
      logger.debug(`日历UI設定完了: #${elementId} = "${finalValue}"`);
    } else {
      logger.warn(`日历日付クリック失敗 (day=${day}) → setDate API にフォールバック`);
      await this.setDateFallback(elementId, dateStr);
    }
  }

  /**
   * warekidatepicker setDate API フォールバック
   */
  private async setDateFallback(elementId: string, dateStr: string): Promise<void> {
    const result = await this.page.evaluate(
      ({ id, date }) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const $ = (window as any).jQuery;
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el || !$) return { success: false, error: 'jQuery or element not found' };

        const parts = date.split('/');
        const dateObj = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));

        try {
          $(el).warekidatepicker('setDate', dateObj);
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: el.value !== '', value: el.value };
        } catch (e: any) {
          return { success: false, error: e.message };
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
      },
      { id: elementId, date: dateStr },
    );

    if (result.success) {
      logger.debug(`setDate フォールバック成功: #${elementId} = "${result.value}"`);
    } else {
      logger.warn(`setDate フォールバック失敗: #${elementId} — ${result.error}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
