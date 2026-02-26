import { logger } from '../../core/logger';
import { SmartHRService } from '../../services/smarthr.service';
import { BrowserManager } from '../../core/browser-manager';
import { SelectorEngine } from '../../core/selector-engine';
import { KanamickAuthService } from '../../services/kanamick-auth.service';

const WORKFLOW_NAME = 'staff-sync';

export interface StaffSyncResult {
  synced: number;
  skipped: number;
  errors: number;
}

export class StaffSyncService {
  private smarthr: SmartHRService;
  private browser: BrowserManager;
  private selectors: SelectorEngine;
  private auth: KanamickAuthService;

  constructor(
    smarthr: SmartHRService,
    browser: BrowserManager,
    selectors: SelectorEngine,
    auth: KanamickAuthService
  ) {
    this.smarthr = smarthr;
    this.browser = browser;
    this.selectors = selectors;
    this.auth = auth;
  }

  /**
   * SmartHRからスタッフ情報を取得し、カナミックに登録する。
   * 失敗しても例外を投げない（エラー数を返す）。
   */
  async syncStaff(): Promise<StaffSyncResult> {
    const result: StaffSyncResult = { synced: 0, skipped: 0, errors: 0 };

    try {
      logger.info('SmartHR スタッフ同期開始');
      const crews = await this.smarthr.getAllCrews();
      const staffEntries = crews.map(c => this.smarthr.toStaffMasterEntry(c));

      logger.info(`SmartHR: ${staffEntries.length}名のスタッフを取得`);

      await this.auth.ensureLoggedIn();

      for (const staff of staffEntries) {
        if (!staff.staffNumber || !staff.staffName) {
          logger.warn(`スタッフ情報不完全のためスキップ: ${JSON.stringify(staff)}`);
          result.skipped++;
          continue;
        }

        try {
          const registered = await this.registerStaffIfNotExists(staff.staffNumber, staff.staffName, staff.staffNameYomi);
          if (registered) {
            result.synced++;
          } else {
            result.skipped++;
          }
        } catch (error) {
          logger.error(`スタッフ登録エラー [${staff.staffNumber}]: ${(error as Error).message}`);
          result.errors++;
        }
      }

      logger.info(`スタッフ同期完了: 登録=${result.synced}, スキップ=${result.skipped}, エラー=${result.errors}`);
    } catch (error) {
      logger.error(`スタッフ同期全体エラー: ${(error as Error).message}`);
      result.errors++;
    }

    return result;
  }

  private async registerStaffIfNotExists(
    staffNumber: string,
    staffName: string,
    staffNameYomi: string
  ): Promise<boolean> {
    // スタッフ管理メニューへ移動
    await this.browser.safeClick('menu_staff', WORKFLOW_NAME);

    // 既存スタッフ検索
    await this.browser.safeType('staff_search_input', staffNumber, WORKFLOW_NAME);
    await this.browser.safeClick('staff_search_button', WORKFLOW_NAME);

    // 検索結果確認
    const staffItems = await this.browser.getTexts('staff_list_items', WORKFLOW_NAME).catch(() => []);
    const alreadyExists = staffItems.some(item => item.includes(staffNumber));

    if (alreadyExists) {
      logger.debug(`スタッフ既存のためスキップ: ${staffNumber}`);
      return false;
    }

    // 新規登録
    await this.browser.safeClick('add_staff_button', WORKFLOW_NAME);
    await this.browser.safeType('staff_number_input', staffNumber, WORKFLOW_NAME);
    await this.browser.safeType('staff_name_input', staffName, WORKFLOW_NAME);
    if (staffNameYomi) {
      await this.browser.safeType('staff_name_yomi_input', staffNameYomi, WORKFLOW_NAME);
    }
    await this.browser.safeClick('save_button', WORKFLOW_NAME);
    await this.browser.waitForElement('save_success_indicator', WORKFLOW_NAME, 10000);

    logger.info(`スタッフ登録完了: ${staffNumber} ${staffName}`);
    return true;
  }
}
