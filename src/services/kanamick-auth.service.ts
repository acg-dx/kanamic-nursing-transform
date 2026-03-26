import { Page, BrowserContext } from 'playwright';
import { logger } from '../core/logger';
import { HamNavigator } from '../core/ham-navigator';
import { withRetry } from '../core/retry-manager';
import type { BrowserManager } from '../core/browser-manager';

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
  private browserManager: BrowserManager | null = null;

  constructor(config: KanamickAuthConfig) {
    this.config = config;
  }

  /** BrowserContext を設定（launch 後に呼ぶ） */
  setContext(context: BrowserContext, browserManager?: BrowserManager): void {
    this.context = context;
    this._navigator = new HamNavigator(context);
    if (browserManager) {
      this.browserManager = browserManager;
    }
  }

  /**
   * BrowserContext が死んでいる場合、BrowserManager 経由でブラウザを再起動し
   * context / navigator を更新する。
   * @returns true if relaunch was performed
   */
  private async relaunchIfContextDead(): Promise<boolean> {
    if (!this.browserManager) return false;
    if (this.browserManager.isContextAlive()) return false;

    logger.warn('BrowserContext 死亡を検出 — ブラウザを再起動します');
    await this.browserManager.relaunch();
    this.context = this.browserManager.browserContext;
    this._navigator = new HamNavigator(this.context);
    this.isLoggedIn = false;
    return true;
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

  /** ページがなければ作成。コンテキスト死亡時は自動再起動 */
  private async ensurePage(): Promise<Page> {
    if (!this.context) throw new Error('BrowserContext が未設定です');

    try {
      const pages = this.context.pages();
      if (pages.length > 0) return pages[0];
      return await this.context.newPage();
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('has been closed') || msg.includes('Target closed')) {
        // BrowserContext 自体が死んでいる → 再起動を試行
        const relaunched = await this.relaunchIfContextDead();
        if (relaunched && this.context) {
          const pages = this.context.pages();
          if (pages.length > 0) return pages[0];
          return await this.context.newPage();
        }
      }
      throw err;
    }
  }

  /**
   * TRITRUS ポータルにのみログイン（HAM は開かない）
   *
   * 同一建物管理など TRITRUS ポータル上で完結する操作に使用。
   * HAM タブを開かないため高速。
   */
  async loginTritrusOnly(): Promise<Page> {
    if (!this.context) throw new Error('BrowserContext が未設定です');

    await withRetry(
      async () => {
        logger.info('TRITRUS ログイン開始（ポータルのみ）...');
        const page = await this.ensurePage();

        await page.goto(this.config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
        logger.debug(`TRITRUS ポータル表示: ${page.url()}`);

        const isAlreadyOnPortal = page.url().includes('portal.kanamic.net/tritrus/index');
        if (isAlreadyOnPortal) {
          logger.info('既にポータルにログイン済み — ログインステップをスキップ');
        } else {
          await page.fill('#josso_username', this.config.username);
          await page.fill('#josso_password', this.config.password);
          await page.click('input.submit-button[type="button"]');
          await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
          await this.sleep(2000);
          logger.debug(`ログイン完了: ${page.url()}`);
        }

        this.isLoggedIn = true;
        logger.info('TRITRUS ポータルログイン完了');
      },
      'TRITRUS ログイン（ポータルのみ）',
      { maxAttempts: 2, baseDelay: 3000 }
    );

    return this.page;
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
        // networkidle はページが重い場合にクラッシュするため domcontentloaded を使用
        await page.goto(this.config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
        logger.debug(`TRITRUS ポータル表示: ${page.url()}`);

        // リトライ時、既にポータルにログイン済みならログインをスキップ
        const isAlreadyOnPortal = page.url().includes('portal.kanamic.net/tritrus/index');
        if (isAlreadyOnPortal) {
          logger.info('既にポータルにログイン済み — ログインステップをスキップ');
        } else {
          // JOSSO ログインフォーム — 確定セレクタ (2026-02-26 検証済)
          await page.fill('#josso_username', this.config.username);
          await page.fill('#josso_password', this.config.password);
          await page.click('input.submit-button[type="button"]');
          await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
          await this.sleep(2000);
          logger.debug(`ログイン完了: ${page.url()}`);
        }

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
            await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
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
    // BrowserContext が死んでいる場合は再起動してから再ログイン
    await this.relaunchIfContextDead();

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

      // HAM フレームが chrome-error:// の場合はサーバー接続断 → 再ログイン
      const frames = hamPage.frames();
      const hasErrorFrame = frames.some(f => f.url().startsWith('chrome-error://'));
      if (hasErrorFrame) {
        logger.warn('HAM フレームに chrome-error:// を検出 — サーバー接続断、再ログイン...');
        this.isLoggedIn = false;
        return this.login();
      }

      // HAM サーバー側エラー（メモリ不足、ページ開けない等）を検出
      // 長時間セッションで HAM がリソース不足になった場合に発生する
      const pageContent = await hamPage.evaluate(() => document.body?.innerText || '').catch(() => '');
      const hamServerError = ['メモリ不足', '開けません', 'サーバーエラー', '一時的に利用できません',
        'E00010', '502 Bad Gateway', '503 Service', 'Internal Server Error'];
      const detectedError = hamServerError.find(keyword => pageContent.includes(keyword));
      if (detectedError) {
        logger.warn(`HAM サーバーエラー検出: "${detectedError}" — ページリロード後に再ログイン...`);
        // HAM ページをリロードしてサーバー側のエラー状態をクリア
        await hamPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        this.isLoggedIn = false;
        return this.login();
      }

      // フレーム内の syserror/エラーページも検出
      for (const frame of frames) {
        const frameUrl = frame.url();
        if (frameUrl.includes('syserror') || frameUrl.includes('error/')) {
          logger.warn(`HAM フレームにエラーページ検出: ${frameUrl} — ページリロード後に再ログイン...`);
          await hamPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          this.isLoggedIn = false;
          return this.login();
        }
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
   * HAM メインメニューから 8-1 スケジュールデータ出力へ遷移
   * メニュー階層: t1-2 → k1_1（訪問看護）→ k11_1（8-1 スケジュールデータ出力）
   */
  async navigateToScheduleDataExport(): Promise<void> {
    const nav = this.navigator;
    // Step 1: 訪問看護業務ガイドへ
    await this.navigateToBusinessGuide();
    // Step 2: 8-1 スケジュールデータ出力へ
    await nav.submitForm({
      action: 'act_k11_1',
      waitForPageId: 'k11_1',
      timeout: 30000,
    });
    logger.debug('8-1 スケジュールデータ出力に遷移');
  }

  /**
   * HAM メインメニュー (t1-2) へ戻る
   *
   * HAM の画面階層は t1-2 → k1_1 → k2_1 → k2_2 → ... と深くなるため、
   * 現在位置に関わらず t1-2 に到達するまで act_back を繰り返す。
   * 最大 MAX_BACK_STEPS 回で打ち切り（無限ループ防止）。
   */
  async navigateToMainMenu(): Promise<void> {
    const nav = this.navigator;

    // まず現在位置を確認
    const pageId = await nav.getCurrentPageId();
    if (pageId === 't1-2') {
      logger.debug('メインメニューに遷移完了');
      return;
    }

    // pageId 取得可能なら act_back / 総合メニューへ を1回だけ試行
    if (pageId) {
      try {
        if (pageId === 'k2_1' || pageId === 'k1_1') {
          // k2_1, k1_1 は act_back が効かないため topFrame「総合メニューへ」
          const clicked = await this.clickMainMenuLink(nav);
          if (clicked) {
            await this.sleep(2000);
            const after = await nav.getCurrentPageId();
            if (after === 't1-2') { logger.debug('メインメニューに遷移完了'); return; }
          }
        } else {
          await nav.submitForm({ action: 'act_back' });
          await this.sleep(1500);
          const after = await nav.getCurrentPageId();
          if (after === 't1-2') { logger.debug('メインメニューに遷移完了'); return; }
        }
      } catch (err) {
        logger.warn(`navigateToMainMenu: 通常復帰失敗: ${(err as Error).message}`);
      }
    }

    // 通常復帰で到達できなかった → 強制復帰（フレーム直接書き換え / リロード / 再ログイン）
    logger.warn(`navigateToMainMenu: 通常復帰失敗 (pageId=${pageId}) → 強制復帰へ`);
    await this.forceNavigateToMainMenu(nav);
  }

  /**
   * kanamicmain フレームを直接 t1-2 の URL にナビゲートして強制復帰。
   * 通常の act_back / 総合メニューへ が全て失敗した場合の最終手段。
   */
  private async forceNavigateToMainMenu(nav: HamNavigator): Promise<void> {
    try {
      const hamPage = nav.hamPage;

      // 方法1: kanamicmain フレームの URL を t1-2Action.go に直接書き換え
      try {
        const kanamicmain = hamPage.frame('kanamicmain');
        if (kanamicmain) {
          const currentUrl = kanamicmain.url();
          const baseMatch = currentUrl.match(/(https?:\/\/[^/]+\/kanamic\/)/);
          if (baseMatch) {
            const t12Url = `${baseMatch[1]}ham/t1-2Action.go`;
            logger.debug(`forceNavigateToMainMenu: kanamicmain → ${t12Url}`);
            await hamPage.evaluate((url) => {
              const frame = document.querySelector('frame[name="kanamicmain"]') as HTMLFrameElement;
              if (frame) frame.src = url;
            }, t12Url);
            await this.sleep(3000);
            await hamPage.waitForLoadState('load').catch(() => {});
            const pageId = await nav.getCurrentPageId();
            if (pageId === 't1-2') {
              logger.info('forceNavigateToMainMenu: 強制復帰成功');
              return;
            }
          }
        }
      } catch (e1) {
        logger.warn(`forceNavigateToMainMenu: 方法1 失敗: ${(e1 as Error).message}`);
      }

      // 方法2: HAM ページ自体をリロード（hamfromout.go → 自動的に t1-2）
      try {
        logger.debug('forceNavigateToMainMenu: HAM ページリロード');
        await hamPage.reload({ waitUntil: 'load', timeout: 30000 });
        await this.sleep(3000);
        await nav.closeVenoboxPopup();
        const pageId = await nav.getCurrentPageId();
        if (pageId === 't1-2') {
          logger.info('forceNavigateToMainMenu: リロードで復帰成功');
          return;
        }
      } catch (e2) {
        logger.warn(`forceNavigateToMainMenu: 方法2(リロード) 失敗: ${(e2 as Error).message}`);
      }

      // 方法3: ページが完全にクラッシュしている場合、HAM URL に直接ナビゲート
      try {
        const hamUrl = hamPage.url();
        logger.warn(`forceNavigateToMainMenu: 方法3 — HAM ページに再ナビゲート (${hamUrl})`);
        await hamPage.goto(hamUrl, { waitUntil: 'load', timeout: 30000 });
        await this.sleep(3000);
        await nav.closeVenoboxPopup();
        const pageId = await nav.getCurrentPageId();
        if (pageId === 't1-2') {
          logger.info('forceNavigateToMainMenu: 再ナビゲートで復帰成功');
          return;
        }
      } catch (e3) {
        logger.warn(`forceNavigateToMainMenu: 方法3(再ナビゲート) 失敗: ${(e3 as Error).message}`);
      }

      // 方法4: 完全再ログイン（最終手段）
      // まず BrowserContext 死亡を検出 → ブラウザ再起動
      const relaunched = await this.relaunchIfContextDead();
      if (relaunched) {
        logger.info('forceNavigateToMainMenu: ブラウザ再起動済み — 再ログインへ');
      }

      // ERR_CONNECTION_RESET の場合、サーバー復旧を待つためにバックオフ付きリトライ
      const MAX_RELOGIN_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_RELOGIN_ATTEMPTS; attempt++) {
        const backoffSec = attempt * 10; // 10s, 20s, 30s
        logger.error(`forceNavigateToMainMenu: 全方法失敗 — 再ログインを試行 (${attempt}/${MAX_RELOGIN_ATTEMPTS}, ${backoffSec}秒待機)`);
        await this.sleep(backoffSec * 1000);

        // 各リトライでもコンテキスト死亡チェック
        await this.relaunchIfContextDead();

        this.isLoggedIn = false;
        try {
          await this.login();
        } catch (loginErr) {
          logger.error(`forceNavigateToMainMenu: 再ログイン失敗 (${attempt}/${MAX_RELOGIN_ATTEMPTS}): ${(loginErr as Error).message}`);
          if (attempt === MAX_RELOGIN_ATTEMPTS) {
            throw new Error(`HAM サーバー接続不可 — ${MAX_RELOGIN_ATTEMPTS}回の再ログイン全て失敗`);
          }
          continue;
        }

        // 再ログイン後、HAM フレームが本当に読み込まれたか確認
        // navigator が再起動で更新されている可能性があるため最新を使用
        nav = this.navigator;
        const hamPage = nav.hamPage;
        const frames = hamPage.frames();
        const hasErrorFrame = frames.some(f => f.url().startsWith('chrome-error://'));
        if (hasErrorFrame) {
          logger.error(`forceNavigateToMainMenu: 再ログイン後も chrome-error:// を検出 (${attempt}/${MAX_RELOGIN_ATTEMPTS})`);
          if (attempt === MAX_RELOGIN_ATTEMPTS) {
            throw new Error('HAM サーバー接続不可 — 再ログイン後もフレーム読み込み失敗');
          }
          continue;
        }

        logger.info('forceNavigateToMainMenu: 再ログインで復帰成功');
        return;
      }
    } catch (err) {
      logger.error(`forceNavigateToMainMenu エラー: ${(err as Error).message}`);
      throw err; // 上位に伝播して早期終了させる
    }
  }

  /**
   * topFrame の「総合メニューへ」ボタン/リンクをクリック
   * k2_1, k2_2 等の画面ヘッダーに表示される汎用メニューボタン
   */
  private async clickMainMenuLink(nav: HamNavigator): Promise<boolean> {
    const hamPage = nav.hamPage;
    for (const frame of hamPage.frames()) {
      try {
        // <a> or <input> with text 総合メニューへ
        const link = await frame.$('a:has-text("総合メニューへ")');
        if (link) {
          await link.click();
          return true;
        }
        const btn = await frame.$('input[value="総合メニューへ"]');
        if (btn) {
          await btn.click();
          return true;
        }
      } catch { /* ignore */ }
    }
    logger.warn('「総合メニューへ」が見つかりません');
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
