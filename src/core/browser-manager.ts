import path from 'path';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { logger } from './logger';
import { SelectorEngine } from './selector-engine';

/**
 * 既知のポップアップ/モーダルの閉じるボタンセレクタ一覧。
 * 新しいパターンが見つかったら追加する。
 */
const POPUP_CLOSE_SELECTORS = [
  // Kanamick vbox ポップアップ（閉じるボタン）
  'div.vbox-close',
  // 一般的なモーダル閉じるボタンパターン
  '.modal .close, .modal [data-dismiss="modal"]',
  // jQuery UI ダイアログ
  '.ui-dialog-titlebar-close',
  // Bootstrap モーダル
  '.modal.show .btn-close, .modal.in .close',
  // 通知/アラート系の閉じるボタン
  '.alert .close, .notification .close',
  // HTML <dialog> 要素
  'dialog[open]',
];

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private _page: Page | null = null;
  private selectorEngine: SelectorEngine;

  constructor(selectorEngine: SelectorEngine) {
    this.selectorEngine = selectorEngine;
  }

  get page(): Page {
    if (!this._page) throw new Error('ブラウザページが未初期化です。launch()を先に呼んでください');
    return this._page;
  }

  /** BrowserContext を取得（auth.setContext() に渡す用） */
  get browserContext(): BrowserContext {
    if (!this.context) throw new Error('BrowserContext が未初期化です。launch()を先に呼んでください');
    return this.context;
  }

  async launch(): Promise<void> {
    logger.info('ブラウザ起動中...');
    this.browser = await chromium.launch({
      headless: process.env.HEADLESS !== 'false',
      slowMo: parseInt(process.env.SLOW_MO || '0', 10),
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: 'ja-JP',
    });

    // tsx/esbuild が keepNames 変換で __name ヘルパーを注入するが、
    // Playwright の evaluate() でシリアライズされるとブラウザ側に __name が存在せず
    // ReferenceError になる。全フレームに polyfill を注入して回避する。
    await this.context.addInitScript(() => {
      if (typeof (globalThis as any).__name === 'undefined') { // eslint-disable-line @typescript-eslint/no-explicit-any
        (globalThis as any).__name = (fn: any) => fn; // eslint-disable-line @typescript-eslint/no-explicit-any
      }
    });

    this._page = await this.context.newPage();
    this._page.setDefaultTimeout(30000);

    // ページ遷移後に自動でポップアップを検知
    this._page.on('load', () => {
      this.dismissPopups().catch(() => { /* ignore */ });
    });

    // ネイティブJS ダイアログ（alert/confirm/prompt）の自動処理
    this._page.on('dialog', async (dialog) => {
      const type = dialog.type();
      const message = dialog.message();
      if (type === 'alert') {
        logger.debug(`ネイティブダイアログ(alert)を自動承認: ${message}`);
        await dialog.accept();
      } else if (type === 'confirm') {
        logger.debug(`ネイティブダイアログ(confirm)を自動承認: ${message}`);
        await dialog.accept();
      } else if (type === 'prompt') {
        logger.debug(`ネイティブダイアログ(prompt)を自動キャンセル: ${message}`);
        await dialog.dismiss();
      } else if (type === 'beforeunload') {
        logger.warn(`beforeunloadダイアログを自動承認（ページ遷移）: ${message}`);
        await dialog.accept();
      } else {
        logger.debug(`未知のダイアログタイプ(${type})を自動承認: ${message}`);
        await dialog.accept();
      }
    });

    logger.info('ブラウザ起動完了');
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this._page = null;
      logger.info('ブラウザ終了');
    }
  }

  async navigate(url: string): Promise<void> {
    logger.info(`遷移先: ${url}`);
    await this.page.goto(url, { waitUntil: 'networkidle' });
    await this.dismissPopups();
  }

  // ========== ポップアップ自動検知・閉じる ==========

  /**
   * 既知のポップアップ/モーダルを検知し、閉じるボタンがあればクリックする。
   * 操作前に呼び出すことで、弾窗による要素遮蔽を防止する。
   */
  async dismissPopups(): Promise<number> {
    let dismissed = 0;

    for (const selector of POPUP_CLOSE_SELECTORS) {
      try {
        const closeBtn = await this.page.$(selector);
        if (closeBtn) {
          const isVisible = await closeBtn.isVisible();
          if (isVisible) {
            await closeBtn.click();
            dismissed++;
            logger.debug(`ポップアップを閉じました: ${selector}`);
            // 閉じた後少し待機（アニメーション完了待ち）
            await this.page.waitForTimeout(300);
          }
        }
      } catch {
        // セレクタが見つからない場合は無視
      }
    }

    // HTML <dialog> 要素の処理（CSS セレクタでは .close() メソッドが呼べないため個別処理）
    try {
      const dialogCount = await this.page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('dialog[open]'));
        dialogs.forEach(d => (d as HTMLDialogElement).close());
        return dialogs.length;
      });
      if (dialogCount > 0) {
        dismissed += dialogCount;
        logger.debug(`HTML <dialog>要素を閉じました: ${dialogCount}個`);
        await this.page.waitForTimeout(300);
      }
    } catch {
      // dialog要素が見つからない場合は無視
    }

    // 複数のポップアップが重なっている場合に備えて再検知
    if (dismissed > 0) {
      const more = await this.dismissPopups();
      dismissed += more;
    }

    return dismissed;
  }

  // ========== 安全な操作メソッド（操作前にポップアップを閉じる） ==========

  async safeClick(selectorId: string, workflowName: string): Promise<void> {
    await this.dismissPopups();
    const selector = await this.selectorEngine.resolve(selectorId, workflowName, this.page);
    try {
      await this.page.click(selector);
    } catch (error) {
      // クリックが遮蔽された場合、再度ポップアップを閉じてリトライ
      const dismissed = await this.dismissPopups();
      if (dismissed > 0) {
        logger.debug(`ポップアップ閉じ後にリトライ: ${selectorId}`);
        await this.page.click(selector);
      } else {
        throw error;
      }
    }
    logger.debug(`クリック: ${selectorId} (${selector})`);
  }

  async safeType(selectorId: string, text: string, workflowName: string): Promise<void> {
    await this.dismissPopups();
    const selector = await this.selectorEngine.resolve(selectorId, workflowName, this.page);
    try {
      await this.page.fill(selector, text);
    } catch (error) {
      // 入力が遮蔽された場合、再度ポップアップを閉じてリトライ
      const dismissed = await this.dismissPopups();
      if (dismissed > 0) {
        logger.debug(`ポップアップ閉じ後にリトライ: ${selectorId}`);
        await this.page.fill(selector, text);
      } else {
        throw error;
      }
    }
    logger.debug(`入力: ${selectorId}`);
  }

  async safeSelect(selectorId: string, value: string, workflowName: string): Promise<void> {
    await this.dismissPopups();
    const selector = await this.selectorEngine.resolve(selectorId, workflowName, this.page);
    try {
      await this.page.selectOption(selector, value);
    } catch (error) {
      // 選択が遮蔽された場合、再度ポップアップを閉じてリトライ
      const dismissed = await this.dismissPopups();
      if (dismissed > 0) {
        logger.debug(`ポップアップ閉じ後にリトライ: ${selectorId}`);
        await this.page.selectOption(selector, value);
      } else {
        throw error;
      }
    }
    logger.debug(`選択: ${selectorId} = ${value}`);
  }

  async waitForElement(selectorId: string, workflowName: string, timeout?: number): Promise<void> {
    const selector = await this.selectorEngine.resolve(selectorId, workflowName, this.page);
    await this.page.waitForSelector(selector, { timeout: timeout || 30000 });
  }

  async getText(selectorId: string, workflowName: string): Promise<string> {
    await this.dismissPopups();
    const selector = await this.selectorEngine.resolve(selectorId, workflowName, this.page);
    return await this.page.textContent(selector) || '';
  }

  async getTexts(selectorId: string, workflowName: string): Promise<string[]> {
    await this.dismissPopups();
    const selector = await this.selectorEngine.resolve(selectorId, workflowName, this.page);
    return await this.page.$$eval(selector, els => els.map(el => el.textContent?.trim() || ''));
  }

  async screenshot(name: string): Promise<string> {
    const screenshotDir = process.env.SCREENSHOT_DIR || './screenshots';
    const safeName = name.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const filePath = path.resolve(screenshotDir, `${safeName}-${Date.now()}.png`);
    if (!filePath.startsWith(path.resolve(screenshotDir))) {
      throw new Error(`パス安全チェック失敗: ${name}`);
    }
    await this.page.screenshot({ path: filePath, fullPage: false });
    logger.info(`スクリーンショット保存: ${filePath}`);
    return filePath;
  }
}
