import { Page, BrowserContext } from 'playwright';
import { logger } from '../core/logger';
import { HamNavigator } from '../core/ham-navigator';
import { withRetry } from '../core/retry-manager';

export interface KanamickAuthConfig {
  /** TRITRUS ポータル URL (e.g. https://portal.kanamic.net/tritrus/index/) */
  url: string;
  username: string;
  password: string;
  /** 対象事業所名 (e.g. 訪問看護ステーションあおぞら姶良) */
  stationName: string;
  /** HAM office key (e.g. 6) — goCicHam.jsp の k パラメータ */
  hamOfficeKey?: string;
  /** HAM 事業所コード (e.g. 400021814 for 姶良) — goCicHam.jsp の h パラメータ */
  hamOfficeCode?: string;
}

/**
 * TRITRUS → HAM ログイン管理サービス
 *
 * 検証済みフロー (2026-02-26):
 * 1. TRITRUS ポータル → JOSSO SSO ログイン画面にリダイレクト
 *    - URL: https://bi.kanamic.net/josso/signon/login.do
 *    - #josso_username / #josso_password / input.submit-button[type="button"]
 * 2. ログイン後 → マイページ (https://portal.kanamic.net/tritrus/index/)
 *    - ページ内に goCicHam.jsp リンクが事業所ごとに表示
 *    - k=3 → TRITRUS連携 (target=new_win_4), k=6 → HAM直接アクセス (target=new_win_1)
 * 3. goCicHam.jsp クリック → 新タブ (target="new_win_1")
 *    - URL: /tritrusutil/goCicHam.jsp?c={corp}&h={office}&k=6
 *    - 自動リダイレクト → https://www2.kanamic.net/kanamic/ham/hamfromout.go
 * 4. HAM ページ構造 (タイトル: 総合メニュー):
 *    - kanamicmain → t1-2Action.go
 *      ├── topFrame → t1-2_top.jsp
 *      └── mainFrame → goPageAction.go?pageId=t1-2 (すべての操作はここ)
 *    - commontarget → commontarget.jsp (フォーム送信先)
 */
export class KanamickAuthService {
  private config: KanamickAuthConfig;
  private context: BrowserContext | null = null;
  private _navigator: HamNavigator | null = null;
  private isLoggedIn = false;

  constructor(config: KanamickAuthConfig) {
    this.config = config;
  }

  /** BrowserContext を設定（launch 後に呼ぶ） */
  setContext(context: BrowserContext): void {
    this.context = context;
    this._navigator = new HamNavigator(context);
  }

  get navigator(): HamNavigator {
    if (!this._navigator) throw new Error('BrowserContext が未設定です。setContext() を呼んでください');
    return this._navigator;
  }

  get page(): Page {
    if (!this.context) throw new Error('BrowserContext が未設定です');
    const pages = this.context.pages();
    if (pages.length === 0) throw new Error('ページが未作成です');
    return pages[0];
  }

  /** ページがなければ作成 */
  private async ensurePage(): Promise<Page> {
    if (!this.context) throw new Error('BrowserContext が未設定です');
    const pages = this.context.pages();
    if (pages.length === 0) {
      return await this.context.newPage();
    }
    return pages[0];
  }

  /**
   * TRITRUS にログインし、HAM を新しいタブで開く
   */
  async login(): Promise<HamNavigator> {
    if (this.isLoggedIn) {
      logger.info('既にログイン済み');
      return this.navigator;
    }

    if (!this.context) throw new Error('BrowserContext が未設定です');

    await withRetry(
      async () => {
        logger.info('TRITRUS ログイン開始...');
        const page = await this.ensurePage();

        // === Step 1: JOSSO SSO ログイン ===
        // TRITRUS ポータルは bi.kanamic.net/josso にリダイレクトする
        await page.goto(this.config.url, { waitUntil: 'networkidle', timeout: 30000 });
        logger.debug(`TRITRUS ポータル表示: ${page.url()}`);

        // JOSSO ログインフォーム — 確定セレクタ (2026-02-26 検証済)
        await page.fill('#josso_username', this.config.username);
        await page.fill('#josso_password', this.config.password);
        await page.click('input.submit-button[type="button"]');
        await page.waitForLoadState('networkidle', { timeout: 15000 });
        await this.sleep(2000);
        logger.debug(`ログイン完了: ${page.url()}`);

        // === Step 2: マイページから goCicHam.jsp リンクを検索 ===
        // k=6 → HAM直接アクセス (target=new_win_1)
        const kParam = this.config.hamOfficeKey || '6';
        const hParam = this.config.hamOfficeCode || '';

        // 事業所固有リンクを検索
        let hamLink = hParam
          ? await page.$(`a[href*="goCicHam.jsp"][href*="h=${hParam}"][href*="k=${kParam}"]`)
          : await page.$(`a[href*="goCicHam.jsp"][href*="k=${kParam}"]:has-text("${this.config.stationName}")`);

        if (!hamLink) {
          // フィルタリングを適用して再検索
          logger.debug('HAMリンク未検出。訪問看護フィルタを適用...');
          await page.evaluate(() => {
            const sel = document.getElementById('searchServiceTypeText') as HTMLSelectElement;
            if (sel) {
              sel.value = '4'; // 訪問看護
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
          });
          const searchBtn = await page.$('button.btn-search');
          if (searchBtn) {
            await searchBtn.click();
            await page.waitForLoadState('networkidle', { timeout: 10000 });
            await this.sleep(2000);
          }
          hamLink = hParam
            ? await page.$(`a[href*="goCicHam.jsp"][href*="h=${hParam}"][href*="k=${kParam}"]`)
            : await page.$(`a[href*="goCicHam.jsp"][href*="k=${kParam}"]:has-text("${this.config.stationName}")`);
        }

        if (!hamLink) {
          // 事業所名の部分一致フォールバック
          const stationShort = this.config.stationName.includes('姶良') ? '姶良'
            : this.config.stationName.includes('荒田') ? '荒田'
            : this.config.stationName.includes('谷山') ? '谷山'
            : this.config.stationName.includes('福岡') ? '福岡'
            : this.config.stationName;
          hamLink = await page.$(`a[href*="goCicHam.jsp"][href*="k=${kParam}"]:has-text("${stationShort}")`);
        }

        if (!hamLink) {
          const allHamLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="goCicHam"]'))
              .map(a => ({ text: a.textContent?.trim(), href: a.getAttribute('href'), target: a.getAttribute('target') }));
          });
          logger.error(`goCicHam リンク一覧: ${JSON.stringify(allHamLinks, null, 2)}`);
          throw new Error(`HAMリンクが見つかりません: station="${this.config.stationName}" k=${kParam}`);
        }

        const linkInfo = await hamLink.evaluate(el => ({
          href: (el as HTMLAnchorElement).href,
          target: (el as HTMLAnchorElement).target,
          text: el.textContent?.trim(),
        }));
        logger.debug(`HAMリンク: "${linkInfo.text}" target="${linkInfo.target}"`);

        // === Step 3: HAMリンククリック → 新タブ (goCicHam.jsp → hamfromout.go) ===
        const newPagePromise = this.context!.waitForEvent('page', { timeout: 15000 });
        await hamLink.click();
        const hamPage = await newPagePromise;
        logger.debug(`新タブ: ${hamPage.url()}`);

        // ダイアログ自動承認
        hamPage.on('dialog', async (dialog) => {
          logger.debug(`HAM ダイアログ [${dialog.type()}]: ${dialog.message()}`);
          await dialog.accept();
        });

        // goCicHam.jsp → hamfromout.go 自動リダイレクト待ち
        try {
          await hamPage.waitForURL('**/kanamic/ham/**', { timeout: 30000 });
          logger.debug(`HAMリダイレクト完了: ${hamPage.url()}`);
        } catch {
          await hamPage.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
          logger.warn(`HAMリダイレクト待機タイムアウト。URL: ${hamPage.url()}`);
        }

        // フレーム構造安定待ち (kanamicmain → topFrame + mainFrame)
        await this.sleep(2000);
        await hamPage.waitForLoadState('load').catch(() => {});

        // HamNavigator 更新
        this.navigator.refreshHamPage();
        logger.debug(`HAM ページ確認: ${this.navigator.hamPage.url()}`);

        // フレーム構造ログ
        const frames = hamPage.frames();
        logger.debug(`HAM フレーム数: ${frames.length}`);
        for (const f of frames) {
          logger.debug(`  frame: name="${f.name()}" url="${f.url().substring(0, 120)}"`);
        }

        // === Step 4: venobox ポップアップを閉じる ===
        await this.sleep(1000);
        await this.navigator.closeVenoboxPopup();

        this.isLoggedIn = true;
        logger.info('TRITRUS → HAM ログイン完了');
      },
      'TRITRUS ログイン',
      { maxAttempts: 2, baseDelay: 3000 }
    );

    return this.navigator;
  }

  /**
   * セッションが有効かチェック。無効なら再ログイン
   */
  async ensureLoggedIn(): Promise<HamNavigator> {
    if (!this.isLoggedIn) {
      return this.login();
    }

    // HAM セッションが切れていないか確認
    try {
      const hamPage = this.navigator.hamPage;
      const url = hamPage.url();
      if (url.includes('login') || url.includes('expired') || url === 'about:blank') {
        logger.info('HAM セッション期限切れ、再ログイン...');
        this.isLoggedIn = false;
        return this.login();
      }
    } catch {
      logger.info('HAM ページアクセスエラー、再ログイン...');
      this.isLoggedIn = false;
      return this.login();
    }

    return this.navigator;
  }

  /**
   * HAM メインメニューから訪問看護業務ガイドへ遷移 (t1-2 → k1_1)
   */
  async navigateToBusinessGuide(): Promise<void> {
    const nav = this.navigator;
    await nav.submitForm({
      action: 'act_k1_1',
      waitForPageId: 'k1_1',
    });
    logger.debug('訪問看護業務ガイドに遷移');
  }

  /**
   * 訪問看護業務ガイド/メインメニューから利用者検索へ遷移 (→ k2_1)
   * k1_1 業務ガイド上の複数リンクが act_k2_1 を使用:
   *   3-1 訪問看護指示書, 4-2 訪問看護記録書 Ⅰ, 4-8 利用者 スケジュール
   */
  async navigateToUserSearch(): Promise<void> {
    const nav = this.navigator;
    await nav.submitForm({
      action: 'act_k2_1',
      waitForPageId: 'k2_1',
    });
    logger.debug('利用者検索に遷移');
  }

  /**
   * HAM メインメニューからスタッフマスタ管理へ遷移 (t1-2 → h1-1)
   * 注意: action名はハイフン区切り 'act_h1-1' (アンダースコアではない)
   */
  async navigateToStaffMaster(): Promise<void> {
    const nav = this.navigator;
    await nav.submitForm({
      action: 'act_h1-1',
      waitForPageId: 'h1-1',
    });
    logger.debug('スタッフマスタ管理に遷移');
  }

  /**
   * HAM メインメニューへ戻る (topFrame の「戻る」ボタン or act_back)
   */
  async navigateToMainMenu(): Promise<void> {
    const nav = this.navigator;
    await nav.submitForm({
      action: 'act_back',
    });
    // メインメニューページの待機
    await this.sleep(1000);
    logger.debug('メインメニューに遷移');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
