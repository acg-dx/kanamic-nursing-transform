/**
 * HAM Frame Navigator
 *
 * HAM (Kanamick healthcare system) uses nested framesets for its UI.
 * All form interactions must target the correct frame and use
 * JavaScript evaluation (not Playwright click/fill) because forms
 * use custom submit functions with lockCheck guards.
 *
 * Frame structure:
 *   Tab 0: TRITRUS portal (https://portal.kanamic.net/tritrus/index/)
 *   Tab 1: HAM (https://www2.kanamic.net/kanamic/ham/hamfromout.go)
 *     └── frame "kanamicmain" → k2_X_right.jsp
 *         ├── frame "topFrame" → k2_X_top.jsp (header)
 *         └── frame "mainFrame" → goPageAction.go?pageId=k2_X (ALL interactions)
 */
import { Page, Frame, BrowserContext } from 'playwright';
import { logger } from './logger';

export interface FormSubmitOptions {
  /** form.doAction.value を設定 */
  action: string;
  /** hidden fields を設定 (key=field name, value=field value) */
  hiddenFields?: Record<string, string>;
  /** lockCheck を '1' に設定 (修正操作時に必要) */
  setLockCheck?: boolean;
  /** 送信後の待機対象 pageId */
  waitForPageId?: string;
  /** 送信後の待機タイムアウト (ms) */
  timeout?: number;
}

export class HamNavigator {
  private context: BrowserContext;
  private _tritrusPage: Page | null = null;
  private _hamPage: Page | null = null;

  constructor(context: BrowserContext) {
    this.context = context;
  }

  /** TRITRUS ポータルページ (Tab 0) */
  get tritrusPage(): Page {
    if (!this._tritrusPage) {
      this._tritrusPage = this.context.pages()[0];
    }
    if (!this._tritrusPage) throw new Error('TRITRUS page not found');
    return this._tritrusPage;
  }

  /** HAM ページ (Tab 1) */
  get hamPage(): Page {
    if (!this._hamPage) {
      const pages = this.context.pages();
      this._hamPage = pages.find(p => p.url().includes('kanamic.net/kanamic/ham'))
        || pages.find(p => p.url().includes('www2.kanamic.net'))
        || pages[1] || null;
    }
    if (!this._hamPage) throw new Error('HAM page not found. TRITRUS → HAM 遷移が必要です');
    return this._hamPage;
  }

  /** HAM が開かれた後に hamPage を再検出 */
  refreshHamPage(): Page {
    this._hamPage = null;
    return this.hamPage;
  }

  /**
   * mainFrame を pageId で検索
   * HAM のフレーム構造は動的に変わるため、毎回 URL パターンで検索する
   */
  async getMainFrame(pageId?: string): Promise<Frame> {
    const hamPage = this.hamPage;
    await hamPage.waitForLoadState('load').catch(() => {});

    // 全フレームからメインフレームを検索
    const allFrames = hamPage.frames();

    if (pageId) {
      const frame = allFrames.find(f => f.url().includes(`pageId=${pageId}`));
      if (frame) return frame;
    }

    // pageId 指定なしの場合、goPageAction.go を含むフレームを返す
    const actionFrame = allFrames.find(f => f.url().includes('goPageAction.go'));
    if (actionFrame) return actionFrame;

    // Action.go を含むフレーム
    const hamActionFrame = allFrames.find(f =>
      f.url().includes('Action.go') && !f.url().includes('hamfromout')
    );
    if (hamActionFrame) return hamActionFrame;

    // mainFrame という名前のフレーム
    const namedFrame = hamPage.frame('mainFrame');
    if (namedFrame) return namedFrame;

    // 最後の手段: kanamicmain 内のフレーム
    const kanamicmain = hamPage.frame('kanamicmain');
    if (kanamicmain) {
      const childFrames = kanamicmain.childFrames();
      if (childFrames.length > 0) {
        // mainFrame は通常2番目のフレーム
        return childFrames[childFrames.length - 1];
      }
    }

    throw new Error(`mainFrame が見つかりません (pageId=${pageId || 'any'})`);
  }

  /**
   * HAM フォーム送信（標準パターン）
   *
   * すべての HAM ページは以下のパターンで遷移する:
   * 1. submited = 0 (送信ロック解除)
   * 2. form.doAction.value = '{action}'
   * 3. form.lockCheck.value = '1' (修正時)
   * 4. form.target = 'commontarget'
   * 5. form.doTarget.value = 'commontarget'
   * 6. form.submit()
   */
  async submitForm(options: FormSubmitOptions): Promise<Frame> {
    // フォームが存在するフレームが見つかるまで待機
    let frame: Frame | null = null;
    for (let i = 0; i < 20; i++) {
      const candidate = await this.getMainFrame();
      const hasForm = await candidate.evaluate(() => !!document.forms[0]).catch(() => false);
      if (hasForm) { frame = candidate; break; }
      await this.sleep(500);
    }
    if (!frame) {
      frame = await this.getMainFrame();
    }

    await frame.evaluate((opts) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      // 送信ロック解除
      win.submited = 0;

      const form = document.forms[0];
      if (!form) throw new Error('form not found');

      // HAM 標準フォームフィールドの存在チェック
      // syserror ページやセッション切れページの form には doAction が存在しない
      if (!form.doAction) {
        const bodyText = document.body?.innerText?.substring(0, 200) || '';
        throw new Error(`form.doAction が存在しません（異常ページの可能性）。action=${opts.action}, body=${bodyText}`);
      }

      // lockCheck 設定
      if (opts.setLockCheck && form.lockCheck) {
        form.lockCheck.value = '1';
      }

      // doAction 設定
      form.doAction.value = opts.action;

      // hidden fields 設定
      if (opts.hiddenFields) {
        for (const [key, val] of Object.entries(opts.hiddenFields)) {
          if (form[key]) {
            form[key].value = val;
          } else {
            // hidden input を動的作成
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = key;
            input.value = val;
            form.appendChild(input);
          }
        }
      }

      // ターゲット設定
      form.target = 'commontarget';
      if (form.doTarget) {
        form.doTarget.value = 'commontarget';
      }

      form.submit();
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }, {
      action: options.action,
      setLockCheck: options.setLockCheck || false,
      hiddenFields: options.hiddenFields || {},
    });

    // 遷移待ち
    const timeout = options.timeout || 15000;
    if (options.waitForPageId) {
      return this.waitForMainFrame(options.waitForPageId, timeout);
    }

    // pageId 指定なしの場合はフレームのロード完了を待つ
    await this.hamPage.waitForLoadState('load').catch(() => {});
    await this.sleep(500); // フレーム再構築待ち
    return this.getMainFrame();
  }

  /**
   * 特定の pageId のフレームが出現し、DOM が準備完了するまで待機。
   *
   * URL マッチだけでなく document.forms[0] の存在も確認する。
   * HAM の form 送信は commontarget 経由で mainFrame を更新するため、
   * URL が先に変わり DOM が後から描画される空窗期がある。
   */
  async waitForMainFrame(pageId: string, timeout = 15000): Promise<Frame> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const frame = await this.getMainFrame(pageId);
        if (frame && frame.url().includes(pageId)) {
          const domReady = await frame.evaluate(() => !!document.forms[0]).catch(() => false);
          if (domReady) return frame;
        }
      } catch {
        // フレームがまだ準備できていない
      }
      await this.sleep(300);
    }
    // タイムアウトしても最新のフレームを返す（partial match）
    logger.warn(`waitForMainFrame タイムアウト: pageId=${pageId}`);
    return this.getMainFrame();
  }

  /**
   * フォーム内の select 要素の値を設定
   */
  async setSelectValue(fieldName: string, value: string, frameOrPageId?: string | Frame): Promise<void> {
    const frame = typeof frameOrPageId === 'string'
      ? await this.getMainFrame(frameOrPageId)
      : frameOrPageId || await this.getMainFrame();

    for (let i = 0; i < 15; i++) {
      const result = await frame.evaluate(({ name, val }) => {
        const form = document.forms[0];
        const select = form?.[name] as HTMLSelectElement;
        if (!select) return 'no-select';

        // 完全一致
        for (const opt of Array.from(select.options)) {
          if (opt.value === val) { select.value = val; return 'ok'; }
        }

        // ゼロパディング除去で再試行 ("09" → "9")
        const unpadded = val.replace(/^0+/, '') || '0';
        for (const opt of Array.from(select.options)) {
          if (opt.value === unpadded) { select.value = unpadded; return 'ok-unpadded'; }
        }

        // ゼロパディング追加で再試行 ("9" → "09")
        const padded = val.padStart(2, '0');
        for (const opt of Array.from(select.options)) {
          if (opt.value === padded) { select.value = padded; return 'ok-padded'; }
        }

        // テキスト部分一致
        for (const opt of Array.from(select.options)) {
          if (opt.text.includes(val) || opt.text.includes(unpadded)) {
            select.value = opt.value; return 'ok-text';
          }
        }

        const availableVals = Array.from(select.options).slice(0, 10).map(o => o.value);
        return `no-match:${JSON.stringify(availableVals)}`;
      }, { name: fieldName, val: value }).catch(() => 'error');

      if (result.startsWith('ok')) {
        if (result !== 'ok') {
          logger.debug(`setSelectValue ${fieldName}=${value} → ${result}`);
        }
        return;
      }
      if (result === 'no-select') {
        await this.sleep(500);
        continue;
      }
      logger.warn(`setSelectValue: ${fieldName}="${value}" が選択肢に見つかりません (${result})`);
      return;
    }
    throw new Error(`select[name="${fieldName}"] not found (timeout)`);
  }

  /**
   * フォーム内の input 要素の値を設定
   */
  async setInputValue(fieldName: string, value: string, frameOrPageId?: string | Frame): Promise<void> {
    const frame = typeof frameOrPageId === 'string'
      ? await this.getMainFrame(frameOrPageId)
      : frameOrPageId || await this.getMainFrame();

    for (let i = 0; i < 15; i++) {
      const ok = await frame.evaluate(({ name, val }) => {
        const form = document.forms[0];
        const input = form?.[name] as HTMLInputElement;
        if (!input) return false;
        input.value = val;
        return true;
      }, { name: fieldName, val: value }).catch(() => false);
      if (ok) return;
      await this.sleep(500);
    }
    throw new Error(`input[name="${fieldName}"] not found (timeout)`);
  }

  /**
   * フォーム内の checkbox をチェック/アンチェック
   */
  async setCheckbox(fieldName: string, checked: boolean, frameOrPageId?: string | Frame): Promise<void> {
    const frame = typeof frameOrPageId === 'string'
      ? await this.getMainFrame(frameOrPageId)
      : frameOrPageId || await this.getMainFrame();

    await frame.evaluate(({ name, check }) => {
      const form = document.forms[0];
      const cb = form?.[name] as HTMLInputElement;
      if (!cb) throw new Error(`checkbox[name="${name}"] not found`);
      cb.checked = check;
    }, { name: fieldName, check: checked });
  }

  /**
   * サービスコード選択（k2_3a用）
   * radio ボタンを選択し、関連する hidden fields を設定
   *
   * @param serviceType - 完全一致で検索。見つからなければテキストマッチにフォールバック
   * @param serviceItem - 完全一致で検索
   * @param textPattern - テキストマッチ用パターン（部分一致）。空なら値一致のみ
   * @param textRequire - textPattern 一致後の追加必須パターン。設定時は両方を含む行のみ候補とする。
   *   例: 緊急+加算対象 → textRequire='・緊急' で「・緊急」含む行を優先選択。
   */
  async selectServiceCode(serviceType: string, serviceItem: string, frame?: Frame, textPattern?: string, textRequire?: string): Promise<void> {
    const mainFrame = frame || await this.getMainFrame();

    const result = await mainFrame.evaluate(({ type, item, pattern, require }) => {
      const form = document.forms[0];
      if (!form) throw new Error('form not found in k2_3a');

      const radios = Array.from(form.querySelectorAll('input[name="radio"]')) as HTMLInputElement[];
      if (radios.length === 0) throw new Error('No radio buttons found in k2_3a');

      // 方法1: 完全一致（servicetype#serviceitem）
      // ★ textRequire 指定時は行テキストも検証する。
      //    resolveKaigo が汎用 serviceitem を返す場合（介護は等級変動するため固定不可）、
      //    完全一致で別サービスにヒットする可能性がある。
      //    例: 13#1211 → 訪看Ⅰ３ にヒットするが、准看護師は 訪看Ⅰ３・准 が必要。
      const exactValue = `${type}#${item}`;
      let target = radios.find(r => {
        if (r.value !== exactValue) return false;
        if (!require) return true;
        // textRequire が設定されている場合、行テキストにも含まれていることを確認
        const tr = r.closest('tr');
        const rowText = tr?.textContent?.trim() || '';
        return rowText.includes(require);
      });

      // 方法2: テキストパターンマッチ（精准版）
      // - textRequire が指定されている場合は必須条件として扱う（サイレント無視しない）
      // - 「減算」「超過」「移行」等の調整項目を避け、基本サービスを優先する
      // - 最短テキスト行 = 最も基本的なサービスを選択
      if (!target && pattern) {
        const adjustmentKeywords = ['減算', '超過', '移行'];
        let bestCandidate: HTMLInputElement | null = null;
        let bestLength = Infinity;
        for (const r of radios) {
          if (!r.value) continue;
          const tr = r.closest('tr');
          const rowText = tr?.textContent?.trim() || '';
          if (!rowText.includes(pattern)) continue;
          // textRequire: 必須パターン（例: '・准', '・緊急'）— 設定時は厳格に適用
          if (require && !rowText.includes(require)) continue;
          // 調整項目は後回し
          const isAdjustment = adjustmentKeywords.some(kw => rowText.includes(kw));
          if (isAdjustment) continue;
          // 最短テキスト = 最も基本的なサービス
          if (rowText.length < bestLength) {
            bestCandidate = r;
            bestLength = rowText.length;
          }
        }
        // フォールバック: 調整項目も含めて再検索（textRequire は維持 — 精准一致を保証）
        if (!bestCandidate) {
          for (const r of radios) {
            if (!r.value) continue;
            const tr = r.closest('tr');
            const rowText = tr?.textContent?.trim() || '';
            if (!rowText.includes(pattern)) continue;
            if (require && !rowText.includes(require)) continue;
            bestCandidate = r;
            break;
          }
        }
        // ★ フォールバック2 廃止: textRequire 無視での再試行を削除
        // textRequire が設定されている場合、条件を満たさない候補は許容しない
        target = bestCandidate ?? undefined;
      }

      // ★ 方法3 廃止: ランダムフォールバックを削除 → 候補一覧付きエラーで明示的に失敗
      if (!target) {
        const available = radios.slice(0, 30).map(r => {
          const tr = r.closest('tr');
          return `${r.value} → ${tr?.textContent?.trim().replace(/\s+/g, ' ').substring(0, 80) || ''}`;
        });
        throw new Error(
          `サービスコード精准一致失敗: exactValue=${type}#${item}, pattern="${pattern}", require="${require}"\n` +
          `候補一覧 (${radios.length}件中先頭30件):\n${available.join('\n')}`
        );
      }

      target.checked = true;

      // radio value から servicetype / serviceitem を分解して hidden fields に設定
      const parts = target.value.split('#');
      if (parts.length === 2) {
        if (form.servicetype) form.servicetype.value = parts[0];
        if (form.serviceitem) form.serviceitem.value = parts[1];
      }

      // servicepoint 取得
      const obj = document.getElementsByName(target.value);
      if (obj.length > 0 && form.servicepoint) {
        form.servicepoint.value = (obj.item(0) as HTMLInputElement).value;
      }

      return { selected: target.value, method: target.value === exactValue ? 'exact' : 'pattern' };
    }, { type: serviceType, item: serviceItem, pattern: textPattern || '', require: textRequire || '' });

    logger.debug(`selectServiceCode: ${result.selected} (${result.method})`);
  }

  /**
   * 保険種類切替（k2_3a用）
   * showflag: 1=介護, 2=予防, 3=医療
   */
  async switchInsuranceType(showflag: string, frame?: Frame): Promise<void> {
    const mainFrame = frame || await this.getMainFrame();

    await mainFrame.evaluate((flag) => {
      const form = document.forms[0];
      form.showflag.value = flag;
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      win.submited = 0;
      /* eslint-enable @typescript-eslint/no-explicit-any */
      form.doAction.value = 'act_change';
      form.target = 'commontarget';
      form.doTarget.value = 'commontarget';
      form.submit();
    }, showflag);

    // フォーム送信後の DOM 再描画を待つ（radio ボタンが存在するまで）
    for (let i = 0; i < 20; i++) {
      await this.sleep(500);
      try {
        const frame = await this.getMainFrame();
        const hasRadio = await frame.evaluate(() =>
          !!document.forms[0] && document.querySelectorAll('input[name="radio"]').length > 0
        ).catch(() => false);
        if (hasRadio) return;
      } catch { /* retry */ }
    }
    logger.warn('switchInsuranceType: radio ボタンの出現を確認できませんでした');
  }

  /**
   * カナ検索（k2_1用）
   */
  async searchByKana(katakana: string, frame?: Frame): Promise<void> {
    const mainFrame = frame || await this.getMainFrame();

    await mainFrame.evaluate((kana) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      win.xinwork_searchKeyword(document.forms[0], kana, 'act_keyword');
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }, katakana);

    await this.sleep(1000);
  }

  /**
   * ページ内のテキストを取得
   */
  async getFrameContent(pageId?: string): Promise<string> {
    const frame = await this.getMainFrame(pageId);
    return frame.evaluate(() => document.body?.innerText || '');
  }

  /**
   * ページ内の HTML を取得
   */
  async getFrameHTML(pageId?: string): Promise<string> {
    const frame = await this.getMainFrame(pageId);
    return frame.evaluate(() => document.body?.innerHTML || '');
  }

  /**
   * 現在のフレーム URL + DOM 内容を検証して pageId を取得
   *
   * URL だけでは不十分 — HAM がエラー応答を返した場合、frame URL に
   * 旧 pageId が残るが DOM 内容は異常ページになっている。
   * k2_1 の場合は searchdate select の存在も確認する。
   */
  async getCurrentPageId(): Promise<string | null> {
    try {
      const frame = await this.getMainFrame();
      const url = frame.url();
      const match = url.match(/pageId=([\w-]+)/);
      if (!match) return null;

      const pageId = match[1];

      // k2_1 の場合は DOM 内容も検証（searchdate select が存在するか）
      if (pageId === 'k2_1') {
        const hasSearchDate = await frame.evaluate(() =>
          !!document.querySelector('select[name="searchdate"]')
        ).catch(() => false);
        if (!hasSearchDate) {
          logger.warn(`getCurrentPageId: URL は k2_1 だが searchdate が存在しません — 異常ページ`);
          return null;
        }
      }

      // 汎用チェック: form が存在するか（syserror ページ等を除外）
      if (pageId !== 't1-2') {
        const hasForm = await frame.evaluate(() => !!document.forms[0]).catch(() => false);
        if (!hasForm) {
          logger.warn(`getCurrentPageId: URL は ${pageId} だが form が存在しません`);
          return null;
        }
      }

      return pageId;
    } catch {
      return null;
    }
  }

  /**
   * venobox ポップアップを閉じる（HAM メインメニュー表示時）
   */
  async closeVenoboxPopup(): Promise<boolean> {
    try {
      const hamPage = this.hamPage;
      const closeBtn = await hamPage.$('div.vbox-close');
      if (closeBtn && await closeBtn.isVisible()) {
        await closeBtn.click();
        await this.sleep(500);
        logger.debug('venobox ポップアップを閉じました');
        return true;
      }
    } catch {
      // ポップアップなし
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
