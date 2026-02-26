import { BaseWorkflow } from '../base-workflow';
import { logger } from '../../core/logger';
import { withRetry } from '../../core/retry-manager';
import type { WorkflowContext, WorkflowResult, WorkflowError } from '../../types/workflow.types';
import type { DeletionRecord } from '../../types/spreadsheet.types';
import type { SheetLocation } from '../../types/config.types';

const WORKFLOW_NAME = 'deletion';

export class DeletionWorkflow extends BaseWorkflow {
  async run(context: WorkflowContext): Promise<WorkflowResult[]> {
    const locations = context.locations || [];
    const results: WorkflowResult[] = [];

    for (const location of locations) {
      const result = await this.executeWithTiming(() =>
        this.processLocation(location)
      );
      results.push(result);
    }

    return results;
  }

  private async processLocation(location: SheetLocation): Promise<WorkflowResult> {
    logger.info(`削除処理開始: ${location.name}`);
    const errors: WorkflowError[] = [];
    let processedRecords = 0;

    const records = await this.sheets.getDeletionRecords(location.sheetId);
    const targets = records.filter(r => r.recordId && !r.completionStatus.includes('削除済み'));

    logger.info(`${location.name}: 削除対象 ${targets.length}/${records.length}件`);

    for (const record of targets) {
      try {
        await withRetry(
          () => this.processRecord(record, location.sheetId),
          `削除[${record.recordId}]`,
          { maxAttempts: 3, baseDelay: 2000, maxDelay: 10000, backoffMultiplier: 2 }
        );
        processedRecords++;
      } catch (error) {
        const err = error as Error;
        await this.sheets.updateDeletionStatus(
          location.sheetId,
          record.rowIndex,
          'エラー：システム'
        ).catch(e => logger.error(`削除ステータス更新失敗: ${e.message}`));

        errors.push({
          recordId: record.recordId,
          message: err.message,
          category: 'system',
          recoverable: true,
          timestamp: new Date().toISOString(),
        });
        logger.error(`削除エラー [${record.recordId}]: ${err.message}`);
      }
    }

    return {
      workflowName: WORKFLOW_NAME,
      locationName: location.name,
      success: errors.length === 0,
      totalRecords: records.length,
      processedRecords,
      errorRecords: errors.length,
      errors,
      duration: 0,
    };
  }

  private async processRecord(record: DeletionRecord, sheetId: string): Promise<void> {
    await this.auth.ensureLoggedIn();

    // 削除メニューへ移動
    await this.browser.safeClick('menu_deletion', WORKFLOW_NAME);

    // 患者検索
    await this.browser.safeType('search_patient_name', record.patientName, WORKFLOW_NAME);
    await this.browser.safeClick('search_button', WORKFLOW_NAME);

    // 患者一覧から選択
    const patientNames = await this.browser.getTexts('patient_list_names', WORKFLOW_NAME);
    const matchIndex = patientNames.findIndex(name => name.includes(record.patientName));
    if (matchIndex === -1) {
      throw new Error(`削除対象患者が見つかりません: ${record.patientName}`);
    }

    const selector = await this.selectors.resolve('patient_list_names', WORKFLOW_NAME, this.browser.page);
    await this.browser.page.locator(selector).nth(matchIndex).click();

    // 削除ボタンクリック
    await this.browser.safeClick('delete_button', WORKFLOW_NAME);

    // 確認ダイアログ
    await this.browser.safeClick('confirm_delete_button', WORKFLOW_NAME);

    // 成功確認
    await this.browser.waitForElement('delete_success_indicator', WORKFLOW_NAME, 10000);

    // ステータス更新
    await this.sheets.updateDeletionStatus(sheetId, record.rowIndex, '削除済み');

    logger.info(`削除完了: ${record.recordId}`);
  }
}
