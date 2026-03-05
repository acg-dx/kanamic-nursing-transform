/**
 * 8-1 スケジュールデータ出力 CSV 自動ダウンロードサービス
 *
 * HAM の 8-1 スケジュールデータ出力ページから CSV を自動エクスポートする。
 * ダウンロードした CSV は予実突合（reconciliation）に使用する。
 *
 * 操作フロー:
 *   1. HAM メインメニュー (t1-2) → act_k11_1 → 8-1 スケジュールデータ出力
 *   2. 期間設定（startdateAttr0/1/2, enddateAttr0/1/2）
 *   3. 「CSV出力」ボタン → submitTargetFormForSlowCSV(this.form, 'act_csv', '/kanamic')
 *   4. Playwright download イベントでファイル保存
 *
 * CSV ファイル仕様:
 *   - エンコード: Shift-JIS
 *   - ファイル名パターン: schedule_8-1_{YYYYMM}.csv
 */
import path from 'path';
import fs from 'fs';
import { logger } from '../core/logger';
import type { KanamickAuthService } from './kanamick-auth.service';

export interface ScheduleCsvDownloadOptions {
  /** 対象年月 (YYYYMM 形式, e.g. "202603") */
  targetMonth: string;
  /** ダウンロード保存先ディレクトリ (デフォルト: ./downloads) */
  downloadDir?: string;
  /** タイムアウト (ms, デフォルト: 120000 — 8-1 CSV は大きいため長めに設定) */
  timeout?: number;
  /** 強制再ダウンロード (デフォルト: false) */
  force?: boolean;
}

export class ScheduleCsvDownloaderService {
  private auth: KanamickAuthService;

  constructor(auth: KanamickAuthService) {
    this.auth = auth;
  }

  /**
   * 当月 CSV がローカルに存在すればそのパスを返す。
   * なければ HAM からダウンロードして返す。
   */
  async ensureScheduleCsv(options: ScheduleCsvDownloadOptions): Promise<string> {
    if (!options.force) {
      const existing = this.findLocalCsv(options.targetMonth, options.downloadDir);
      if (existing) {
        logger.info(`8-1 スケジュール CSV: ローカルキャッシュ使用 → ${existing}`);
        return existing;
      }
    }

    return this.downloadScheduleCsv(options);
  }

  /**
   * ローカルに当月の CSV が存在するか検索
   * パターン: schedule_8-1_{YYYYMM}*.csv
   */
  findLocalCsv(targetMonth: string, downloadDir?: string): string | null {
    const dirs = [
      path.resolve(downloadDir || './downloads'),
      path.resolve('.'),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      const match = files.find(f =>
        f.includes('schedule_8-1') && f.includes(targetMonth) && f.endsWith('.csv')
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
   * HAM 8-1 スケジュールデータ出力から CSV をダウンロード
   */
  async downloadScheduleCsv(options: ScheduleCsvDownloadOptions): Promise<string> {
    const { targetMonth, timeout = 120000 } = options;
    const downloadDir = path.resolve(options.downloadDir || './downloads');

    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    const year = targetMonth.substring(0, 4);
    const month = targetMonth.substring(4, 6);
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();

    logger.info(`8-1 スケジュール CSV ダウンロード開始: ${year}/${month}/01 〜 ${year}/${month}/${lastDay}`);
    const nav = this.auth.navigator;

    // === Step 1: メインメニューに戻る + venobox ポップアップ閉じ ===
    await this.auth.navigateToMainMenu();
    await nav.closeVenoboxPopup();

    // === Step 2: 訪問看護業務ガイド (k1_1) → 8-1 スケジュールデータ出力 (k11_1) ===
    // HAM のメニュー階層: t1-2 → k1_1（訪問看護）→ k11_1（8-1 スケジュールデータ出力）
    await this.auth.navigateToBusinessGuide();
    await this.sleep(1000);
    logger.debug('訪問看護業務ガイドに遷移');

    await nav.submitForm({
      action: 'act_k11_1',
      waitForPageId: 'k11_1',
      timeout: 30000,
    });
    await this.sleep(2000);
    logger.debug('8-1 スケジュールデータ出力に遷移');

    // === Step 3: 期間設定 ===
    const mainFrame = await nav.getMainFrame('k11_1');

    // 開始日: YYYY年MM月01日
    await nav.setSelectValue('startdateAttr0', year, mainFrame);
    await nav.setSelectValue('startdateAttr1', month, mainFrame);
    await nav.setSelectValue('startdateAttr2', '01', mainFrame);

    // 終了日: YYYY年MM月{lastDay}日
    await nav.setSelectValue('enddateAttr0', year, mainFrame);
    await nav.setSelectValue('enddateAttr1', month, mainFrame);
    await nav.setSelectValue('enddateAttr2', String(lastDay).padStart(2, '0'), mainFrame);

    logger.debug(`期間設定完了: ${year}/${month}/01 〜 ${year}/${month}/${lastDay}`);

    // === Step 4: CSV出力ボタンクリック → ダウンロード待機 ===
    const hamPage = nav.hamPage;
    const downloadPromise = hamPage.waitForEvent('download', { timeout });

    // submitTargetFormForSlowCSV を使用（通常の submitForm ではない）
    await mainFrame.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      const form = document.forms[0];
      if (!form) throw new Error('form not found on k11_1');

      win.submited = 0;

      if (typeof win.submitTargetFormForSlowCSV === 'function') {
        // act_csv ボタンを見つけて disabled にする（本来のボタン動作を再現）
        const csvBtn = document.getElementById('act_csv') as HTMLInputElement | null;
        if (csvBtn) csvBtn.disabled = true;
        win.submitTargetFormForSlowCSV(form, 'act_csv', '/kanamic');
      } else {
        // フォールバック: 手動でフォーム送信
        form.doAction.value = 'act_csv';
        form.target = '_self';
        form.submit();
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    logger.debug('8-1 CSV ダウンロード待機中（最大120秒）...');
    const download = await downloadPromise;

    const suggestedName = download.suggestedFilename() || `schedule_8-1_${targetMonth}.csv`;
    // HAM が生成するファイル名を保持しつつ、ローカルキャッシュ用に別名で保存
    const savePath = path.join(downloadDir, `schedule_8-1_${targetMonth}.csv`);
    await download.saveAs(savePath);

    const fileSize = fs.statSync(savePath).size;
    logger.info(`8-1 CSV ダウンロード完了: ${savePath} (${fileSize} bytes, 元名: ${suggestedName})`);

    if (fileSize < 100) {
      throw new Error(`8-1 CSV ファイルが小さすぎます (${fileSize} bytes)`);
    }

    // === Step 5: メインメニューに戻る ===
    await this.auth.navigateToMainMenu();

    return savePath;
  }

  /**
   * 当月の YYYYMM 文字列を返す
   */
  static getCurrentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * 前月の YYYYMM 文字列を返す
   */
  static getPreviousMonth(): string {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${prev.getFullYear()}${String(prev.getMonth() + 1).padStart(2, '0')}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
