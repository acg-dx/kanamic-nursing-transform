/**
 * 利用者マスタ CSV 自動ダウンロードサービス
 *
 * HAM の利用者マスター管理 (u1-1) から CSV を自動エクスポートする。
 * 月1回だけダウンロードし、ローカルにキャッシュする。
 *
 * 操作フロー:
 *   1. HAM メインメニュー (t1-2) → act_u1-1 → 利用者マスタ管理
 *   2. user_list.jpg 画像クリック → 利用者一覧ページ
 *   3. 「CSV出力」ボタン → csvDownload(this.form, 'alluser_csv')
 *   4. Playwright download イベントでファイル保存
 *
 * CSV ファイル仕様:
 *   - エンコード: Shift-JIS
 *   - ファイル名例: {事業所番号}_userallfull_{YYYYMM}.csv
 */
import path from 'path';
import fs from 'fs';
import { logger } from '../core/logger';
import type { KanamickAuthService } from './kanamick-auth.service';

export interface CsvDownloadOptions {
  /** 対象年月 (YYYYMM 形式, e.g. "202602") */
  targetMonth: string;
  /** ダウンロード保存先ディレクトリ (デフォルト: ./downloads) */
  downloadDir?: string;
  /** タイムアウト (ms, デフォルト: 60000) */
  timeout?: number;
  /** 強制再ダウンロード (デフォルト: false) */
  force?: boolean;
}

export class PatientCsvDownloaderService {
  private auth: KanamickAuthService;

  constructor(auth: KanamickAuthService) {
    this.auth = auth;
  }

  /**
   * 当月 CSV がローカルに存在すればそのパスを返す。
   * なければ HAM からダウンロードして返す。
   */
  async ensurePatientCsv(options: CsvDownloadOptions): Promise<string> {
    if (!options.force) {
      const existing = this.findLocalCsv(options.targetMonth, options.downloadDir);
      if (existing) {
        logger.info(`利用者マスタ CSV: ローカルキャッシュ使用 → ${existing}`);
        return existing;
      }
    }

    return this.downloadPatientCsv(options);
  }

  /**
   * ローカルに当月の CSV が存在するか検索
   * パターン: *userallfull*{YYYYMM}*.csv
   */
  findLocalCsv(targetMonth: string, downloadDir?: string): string | null {
    const dirs = [
      path.resolve(downloadDir || './downloads'),
      path.resolve('.'),  // プロジェクトルート
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      const match = files.find(f =>
        f.includes('userallfull') && f.includes(targetMonth) && f.endsWith('.csv')
      );
      if (match) {
        const fullPath = path.join(dir, match);
        const stat = fs.statSync(fullPath);
        if (stat.size > 100) return fullPath;
      }
    }
    return null;
  }

  /**
   * HAM から利用者マスタ CSV をダウンロード
   * searchdate はデフォルトで当月が selected なので変更不要。
   */
  async downloadPatientCsv(options: CsvDownloadOptions): Promise<string> {
    const { targetMonth, timeout = 60000 } = options;
    const downloadDir = path.resolve(options.downloadDir || './downloads');

    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    logger.info(`利用者マスタ CSV ダウンロード開始: 対象月=${targetMonth}`);
    const nav = this.auth.navigator;

    // === Step 1: メインメニューに戻る ===
    await this.auth.navigateToMainMenu();

    // === Step 2: 利用者マスタ管理 (u1-1) へ遷移 ===
    await nav.submitForm({
      action: 'act_u1-1',
      waitForPageId: 'u1-1',
      timeout: 30000,
    });

    // === Step 3: user_list.jpg 画像クリック → 利用者一覧サブページ ===
    let mainFrame = await nav.getMainFrame('u1-1');
    await mainFrame.click('img#Image2');
    await this.sleep(2000);

    // CSV出力ボタンが出現するまで待機
    mainFrame = await nav.getMainFrame();
    for (let i = 0; i < 10; i++) {
      const hasCsvBtn = await mainFrame.evaluate(() => {
        return !!document.querySelector('input[name="act-csv122"]');
      }).catch(() => false);
      if (hasCsvBtn) break;
      await this.sleep(500);
      mainFrame = await nav.getMainFrame();
    }

    // === Step 4: CSV出力ボタンクリック → ダウンロード待機 ===
    const hamPage = nav.hamPage;
    const downloadPromise = hamPage.waitForEvent('download', { timeout });

    await mainFrame.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      const form = document.forms[0];
      if (!form) throw new Error('form not found');

      if (typeof win.csvDownload === 'function') {
        win.csvDownload(form, 'alluser_csv');
      } else {
        win.submited = 0;
        form.doAction.value = 'alluser_csv';
        form.target = '_self';
        form.submit();
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    logger.debug('CSV ダウンロード待機中...');
    const download = await downloadPromise;

    const suggestedName = download.suggestedFilename() || `userallfull_${targetMonth}.csv`;
    const savePath = path.join(downloadDir, suggestedName);
    await download.saveAs(savePath);

    const fileSize = fs.statSync(savePath).size;
    logger.info(`CSV ダウンロード完了: ${savePath} (${fileSize} bytes)`);

    if (fileSize < 100) {
      throw new Error(`CSV ファイルが小さすぎます (${fileSize} bytes)`);
    }

    // === Step 5: メインメニューに戻る ===
    await this.auth.navigateToMainMenu();

    return savePath;
  }

  static getCurrentMonth(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}${month}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
