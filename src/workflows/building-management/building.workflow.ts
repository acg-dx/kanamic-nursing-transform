import { BaseWorkflow } from '../base-workflow';
import { logger } from '../../core/logger';
import { withRetry } from '../../core/retry-manager';
import type { WorkflowContext, WorkflowResult, WorkflowError } from '../../types/workflow.types';
import type { BuildingManagementRecord } from '../../types/spreadsheet.types';

const WORKFLOW_NAME = 'building';

export class BuildingManagementWorkflow extends BaseWorkflow {
  async run(context: WorkflowContext): Promise<WorkflowResult[]> {
    const sheetId = context.buildingMgmtSheetId;
    if (!sheetId) {
      throw new Error('buildingMgmtSheetId が設定されていません');
    }

    const result = await this.executeWithTiming(() =>
      this.processBuilding(sheetId)
    );
    return [result];
  }

  private async processBuilding(sheetId: string): Promise<WorkflowResult> {
    logger.info('同一建物管理処理開始');
    const errors: WorkflowError[] = [];
    let processedRecords = 0;

    const records = await this.sheets.getBuildingManagementRecords(sheetId);
    const targets = records.filter(r => r.isNew && r.status !== '登録済み');

    logger.info(`同一建物管理: 対象 ${targets.length}/${records.length}件`);

    // 施設名でグループ化
    const byFacility = new Map<string, BuildingManagementRecord[]>();
    for (const record of targets) {
      const existing = byFacility.get(record.facilityName) || [];
      existing.push(record);
      byFacility.set(record.facilityName, existing);
    }

    for (const [facilityName, facilityRecords] of byFacility) {
      try {
        await withRetry(
          () => this.processFacility(facilityName, facilityRecords, sheetId),
          `建物管理[${facilityName}]`,
          { maxAttempts: 3, baseDelay: 2000, maxDelay: 10000, backoffMultiplier: 2 }
        );
        processedRecords += facilityRecords.length;
      } catch (error) {
        const err = error as Error;
        for (const record of facilityRecords) {
          await this.sheets.updateBuildingManagementStatus(
            sheetId, record.rowIndex, 'エラー'
          ).catch(e => logger.error(`建物管理ステータス更新失敗: ${e.message}`));

          errors.push({
            recordId: record.aozoraId,
            message: err.message,
            category: 'system',
            recoverable: true,
            timestamp: new Date().toISOString(),
          });
        }
        logger.error(`建物管理エラー [${facilityName}]: ${err.message}`);
      }
    }

    return {
      workflowName: WORKFLOW_NAME,
      success: errors.length === 0,
      totalRecords: records.length,
      processedRecords,
      errorRecords: errors.length,
      errors,
      duration: 0,
    };
  }

  private async processFacility(
    facilityName: string,
    records: BuildingManagementRecord[],
    sheetId: string
  ): Promise<void> {
    await this.auth.ensureLoggedIn(WORKFLOW_NAME);

    // 同一建物管理メニューへ移動
    await this.browser.safeClick('menu_building', WORKFLOW_NAME);

    // 施設検索
    await this.browser.safeType('facility_search_input', facilityName, WORKFLOW_NAME);
    await this.browser.safeClick('facility_search_button', WORKFLOW_NAME);

    // 施設一覧から選択
    const facilityItems = await this.browser.getTexts('facility_list_items', WORKFLOW_NAME);
    const matchIndex = facilityItems.findIndex(name => name.includes(facilityName));
    if (matchIndex === -1) {
      throw new Error(`施設が見つかりません: ${facilityName}`);
    }

    const selector = await this.selectors.resolve('facility_list_items', WORKFLOW_NAME, this.browser.page);
    await this.browser.page.locator(selector).nth(matchIndex).click();

    // 各利用者を追加
    for (const record of records) {
      await this.browser.safeClick('add_user_button', WORKFLOW_NAME);
      await this.browser.safeType('user_name_input', record.userName, WORKFLOW_NAME);
      await this.browser.safeType('user_id_input', record.aozoraId, WORKFLOW_NAME);
      await this.browser.safeClick('save_button', WORKFLOW_NAME);
      await this.browser.waitForElement('save_success_indicator', WORKFLOW_NAME, 10000);

      await this.sheets.updateBuildingManagementStatus(sheetId, record.rowIndex, '登録済み');
      logger.info(`建物管理登録完了: ${record.userName} (${facilityName})`);
    }
  }
}
