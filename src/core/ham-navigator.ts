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
    const frame = await this.getMainFrame();

    await frame.evaluate((opts) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      // 送信ロック解除
      win.submited = 0;

      const form = document.forms[0];
      if (!form) throw new Error('form not found');

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
   * 特定の pageId のフレームが出現するまで待機
   */
  async waitForMainFrame(pageId: string, timeout = 15000): Promise<Frame> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      try {
        const frame = await this.getMainFrame(pageId);
        if (frame && frame.url().includes(pageId)) {
          return frame;
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

    await frame.evaluate(({ name, val }) => {
      const form = document.forms[0];
      const select = form?.[name] as HTMLSelectElement;
      if (!select) throw new Error(`select[name="${name}"] not found`);
      select.value = val;
    }, { name: fieldName, val: value });
  }

  /**
   * フォーム内の input 要素の値を設定
   */
  async setInputValue(fieldName: string, value: string, frameOrPageId?: string | Frame): Promise<void> {
    const frame = typeof frameOrPageId === 'string'
      ? await this.getMainFrame(frameOrPageId)
      : frameOrPageId || await this.getMainFrame();

    await frame.evaluate(({ name, val }) => {
      const form = document.forms[0];
      const input = form?.[name] as HTMLInputElement;
      if (!input) throw new Error(`input[name="${name}"] not found`);
      input.value = val;
    }, { name: fieldName, val: value });
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
   */
  async selectServiceCode(serviceType: string, serviceItem: string, frame?: Frame): Promise<void> {
    const mainFrame = frame || await this.getMainFrame();

    await mainFrame.evaluate(({ type, item }) => {
      const form = document.forms[0];
      const radioValue = `${type}#${item}`;

      // radio ボタン選択
      const radio = form.querySelector(`input[name="radio"][value="${radioValue}"]`) as HTMLInputElement;
      if (!radio) throw new Error(`radio[value="${radioValue}"] not found`);
      radio.checked = true;

      // hidden fields 設定
      form.servicetype.value = type;
      form.serviceitem.value = item;

      // servicepoint 取得
      const obj = document.getElementsByName(radioValue);
      if (obj.length > 0) {
        form.servicepoint.value = (obj.item(0) as HTMLInputElement).value;
      }
    }, { type: serviceType, item: serviceItem });
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
      // change_flag ボタンクリックをシミュレート
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      win.submited = 0;
      /* eslint-enable @typescript-eslint/no-explicit-any */
      form.doAction.value = 'act_change';
      form.target = 'commontarget';
      form.doTarget.value = 'commontarget';
      form.submit();
    }, showflag);

    await this.sleep(1000);
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
   * 現在のフレーム URL を取得
   */
  async getCurrentPageId(): Promise<string | null> {
    try {
      const frame = await this.getMainFrame();
      const url = frame.url();
      const match = url.match(/pageId=(\w+)/);
      return match ? match[1] : null;
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
