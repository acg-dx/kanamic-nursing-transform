import { logger } from '../../core/logger';
import { SpreadsheetService } from '../../services/spreadsheet.service';
import type { TranscriptionRecord, CorrectionRecord } from '../../types/spreadsheet.types';

export class CorrectionDetector {
  private sheets: SpreadsheetService;

  constructor(sheets: SpreadsheetService) {
    this.sheets = sheets;
  }

  /**
   * 転記済みレコードの中で、転記後にデータが変更されたものを検出する。
   * 検出条件: transcriptionFlag === '転記済み' AND updatedAt > dataFetchedAt
   */
  detectCorrections(records: TranscriptionRecord[]): TranscriptionRecord[] {
    return records.filter(record => {
      if (record.transcriptionFlag !== '転記済み') return false;
      if (!record.dataFetchedAt || !record.updatedAt) return false;

      const updatedAt = new Date(record.updatedAt);
      const dataFetchedAt = new Date(record.dataFetchedAt);

      // updatedAt が dataFetchedAt より後 = 転記後にデータが変更された
      return updatedAt > dataFetchedAt;
    });
  }

  /**
   * 修正レコードを看護記録修正管理Sheetに書き込み、
   * 元レコードのステータスを '修正あり' に更新する。
   */
  async writeCorrectionRecord(
    sheetId: string,
    record: TranscriptionRecord,
    changeDetail: string
  ): Promise<void> {
    const correctionId = `CORR-${record.recordId}-${Date.now()}`;
    const correctionRecord: Omit<CorrectionRecord, 'rowIndex'> = {
      correctionId,
      recordId: record.recordId,
      patientName: record.patientName,
      correctedAt: new Date().toISOString(),
      changeDetail,
      status: '未処理',
      errorLog: '',
    };

    await this.sheets.appendCorrectionRecord(sheetId, correctionRecord);
    await this.sheets.updateTranscriptionStatus(sheetId, record.rowIndex, '修正あり');

    logger.info(`修正レコード記録: ${record.recordId} → 看護記録修正管理Sheet`);
  }

  /**
   * 修正検知を実行し、修正レコードをSheetに書き込む。
   * @returns 修正が検出されたレコード数
   */
  async processCorrections(sheetId: string, records: TranscriptionRecord[]): Promise<number> {
    const corrections = this.detectCorrections(records);

    if (corrections.length === 0) {
      logger.debug('修正レコードなし');
      return 0;
    }

    logger.info(`修正レコード検出: ${corrections.length}件`);

    for (const record of corrections) {
      try {
        const changeDetail = `転記後データ変更: updatedAt=${record.updatedAt}, dataFetchedAt=${record.dataFetchedAt}`;
        await this.writeCorrectionRecord(sheetId, record, changeDetail);
      } catch (error) {
        logger.error(`修正レコード書き込みエラー [${record.recordId}]: ${(error as Error).message}`);
      }
    }

    return corrections.length;
  }
}
