import { BaseWorkflow } from '../base-workflow';
import { logger } from '../../core/logger';
import { withRetry } from '../../core/retry-manager';
import type { WorkflowContext, WorkflowResult, WorkflowError } from '../../types/workflow.types';
import type { TranscriptionRecord } from '../../types/spreadsheet.types';
import type { SheetLocation } from '../../types/config.types';

const WORKFLOW_NAME = 'transcription';

export class TranscriptionWorkflow extends BaseWorkflow {
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
    logger.info(`転記処理開始: ${location.name}`);
    const errors: WorkflowError[] = [];
    let processedRecords = 0;

    const records = await this.sheets.getTranscriptionRecords(location.sheetId);
    const targets = records.filter(r => this.isTranscriptionTarget(r));

    logger.info(`${location.name}: 対象レコード ${targets.length}/${records.length}件`);

    for (const record of targets) {
      try {
        await withRetry(
          () => this.processRecord(record, location.sheetId),
          `転記[${record.recordId}]`,
          { maxAttempts: 3, baseDelay: 2000, maxDelay: 10000, backoffMultiplier: 2 }
        );
        processedRecords++;
      } catch (error) {
        const err = error as Error;
        const isMasterError = err.message.includes('マスタ') || err.message.includes('master');
        const status = isMasterError ? 'エラー：マスタ不備' : 'エラー：システム';
        
        await this.sheets.updateTranscriptionStatus(
          location.sheetId,
          record.rowIndex,
          status,
          err.message
        ).catch(e => logger.error(`ステータス更新失敗: ${e.message}`));

        errors.push({
          recordId: record.recordId,
          message: err.message,
          category: isMasterError ? 'master' : 'system',
          recoverable: !isMasterError,
          timestamp: new Date().toISOString(),
        });
        logger.error(`転記エラー [${record.recordId}]: ${err.message}`);
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
      duration: 0, // overwritten by executeWithTiming
    };
  }

  isTranscriptionTarget(record: TranscriptionRecord): boolean {
    if (record.recordLocked) return false;
    if (record.transcriptionFlag === '転記済み') return false;
    if (record.transcriptionFlag === '') return true;
    if (record.transcriptionFlag === 'エラー：システム') return true;
    if (record.transcriptionFlag === 'エラー：マスタ不備' && record.masterCorrectionFlag) return true;
    if (record.transcriptionFlag === '修正あり') return true;
    return false;
  }

  private async processRecord(record: TranscriptionRecord, sheetId: string): Promise<void> {
    await this.auth.ensureLoggedIn(WORKFLOW_NAME);

    // 実績入力メニューへ移動
    await this.browser.safeClick('menu_results', WORKFLOW_NAME);

    // 患者検索
    await this.browser.safeType('search_patient_name', record.patientName, WORKFLOW_NAME);
    await this.browser.safeClick('search_button', WORKFLOW_NAME);

    // 患者一覧から選択
    const patientNames = await this.browser.getTexts('patient_list_names', WORKFLOW_NAME);
    const matchIndex = patientNames.findIndex(name => name.includes(record.patientName));
    if (matchIndex === -1) {
      throw new Error(`患者が見つかりません: ${record.patientName} (マスタ不備の可能性)`);
    }

    // 患者行をクリック（インデックスで選択）
    const selector = await this.selectors.resolve('patient_list_names', WORKFLOW_NAME, this.browser.page);
    await this.browser.page.locator(selector).nth(matchIndex).click();

    // データ入力
    await this.inputRecordData(record);

    // 保存
    await this.browser.safeClick('save_button', WORKFLOW_NAME);
    await this.browser.waitForElement('save_success_indicator', WORKFLOW_NAME, 10000);

    // 転記済みに更新
    await this.sheets.updateTranscriptionStatus(sheetId, record.rowIndex, '転記済み');
    await this.sheets.writeDataFetchedAt(sheetId, record.rowIndex, new Date().toISOString());

    logger.info(`転記完了: ${record.recordId}`);
  }

  private async inputRecordData(record: TranscriptionRecord): Promise<void> {
    await this.browser.safeSelect('service_type1_select', record.serviceType1, WORKFLOW_NAME);
    await this.browser.safeSelect('service_type2_select', record.serviceType2, WORKFLOW_NAME);
    await this.browser.safeType('start_time_input', record.startTime, WORKFLOW_NAME);
    await this.browser.safeType('end_time_input', record.endTime, WORKFLOW_NAME);
    await this.browser.safeType('staff_name_input', record.staffName, WORKFLOW_NAME);

    if (record.accompanyCheck) {
      await this.browser.safeClick('accompany_checkbox', WORKFLOW_NAME);
    }
    if (record.accompanyClerkCheck) {
      await this.browser.safeClick('accompany_clerk_checkbox', WORKFLOW_NAME);
    }
    if (record.emergencyClerkCheck) {
      await this.browser.safeClick('emergency_clerk_checkbox', WORKFLOW_NAME);
    }
    if (record.multipleVisit) {
      await this.browser.safeClick('multiple_visit_checkbox', WORKFLOW_NAME);
    }
  }
}
