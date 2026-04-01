/**
 * 修正管理シート駆動の修正同期
 *
 * 修正管理シート（看護記録修正管理）の「上書きOK」かつ未処理のレコードを読み取り、
 * 月次シートの該当レコードに「修正あり」フラグを強制設定する。
 *
 * これにより updatedAt > dataFetchedAt のタイミング問題で修正が見逃されるバグを防止する。
 * 修正管理シートが「信頼できる唯一の情報源（Single Source of Truth）」として機能する。
 */
import { logger } from '../../core/logger';
import { SpreadsheetService } from '../../services/spreadsheet.service';
import type { TranscriptionRecord, CorrectionRecord } from '../../types/spreadsheet.types';

/**
 * 修正管理シートと月次シートを同期するユーティリティ。
 *
 * processLocation 内で転記ループ前に呼び出し、
 * 修正管理シートの未処理レコードで月次シートのフラグを強制設定する。
 */
export class CorrectionSheetSync {
  private sheets: SpreadsheetService;

  constructor(sheets: SpreadsheetService) {
    this.sheets = sheets;
  }

  /**
   * 修正管理シートから未処理の「上書きOK」レコードを取得
   */
  async getUnprocessedCorrections(sheetId: string): Promise<CorrectionRecord[]> {
    const allCorrections = await this.sheets.getCorrectionRecords(sheetId);
    return allCorrections.filter(c =>
      c.status === '上書きOK' && c.processedFlag !== '1'
    );
  }

  /**
   * 未処理の修正レコードを月次シートのレコードに適用する。
   *
   * - recordId が一致
   * - 月次シートで転記済み (hamAssignId が存在)
   * → transcriptionFlag を「修正あり」に強制設定 + ロック解除
   *
   * @returns recordId → 修正管理レコードの rowIndex 配列のマップ
   *          （転記成功後に処理済みマークを付けるために使用）
   */
  async applyCorrectionsToRecords(
    corrections: readonly CorrectionRecord[],
    records: TranscriptionRecord[],
    sheetId: string,
    tab?: string,
  ): Promise<Map<string, number[]>> {
    const correctionMap = new Map<string, number[]>();

    if (corrections.length === 0) return correctionMap;

    // recordId → TranscriptionRecord のインデックスマップ
    const recordsByRecordId = new Map<string, TranscriptionRecord>();
    for (const r of records) {
      recordsByRecordId.set(r.recordId, r);
    }

    let appliedCount = 0;

    for (const corr of corrections) {
      const record = recordsByRecordId.get(corr.recordId);

      if (!record) {
        logger.debug(`修正管理同期: recordId=${corr.recordId} (${corr.patientName}) が月次シートに存在しません（別月度の可能性）`);
        continue;
      }

      if (!record.hamAssignId) {
        logger.debug(`修正管理同期: recordId=${corr.recordId} (${corr.patientName}) は hamAssignId 未設定（未転記 or 削除済み）→ スキップ`);
        continue;
      }

      // 既に「修正あり」なら重複設定しない（ただし correctionMap には追加）
      if (record.transcriptionFlag !== '修正あり') {
        if (record.transcriptionFlag !== '転記済み') {
          logger.debug(`修正管理同期: recordId=${corr.recordId} (${corr.patientName}) は転記フラグ="${record.transcriptionFlag}" → スキップ`);
          continue;
        }

        // ロック解除 + フラグ強制設定
        if (record.recordLocked) {
          await this.sheets.unlockRecord(sheetId, record.rowIndex, tab);
          record.recordLocked = false;
        }
        await this.sheets.updateTranscriptionStatus(sheetId, record.rowIndex, '修正あり', undefined, tab);
        record.transcriptionFlag = '修正あり';

        logger.info(
          `修正管理同期: recordId=${corr.recordId} (${corr.patientName}) ` +
          `→ 「修正あり」に強制設定 (変更: ${corr.changeDetail.replace(/\n/g, ', ')})`
        );
        appliedCount++;
      }

      // correctionMap に追加（転記成功後の処理済みマーク用）
      const existing = correctionMap.get(corr.recordId) || [];
      existing.push(corr.rowIndex);
      correctionMap.set(corr.recordId, existing);
    }

    if (appliedCount > 0) {
      logger.info(`修正管理同期: ${appliedCount}件のレコードを「修正あり」に設定`);
    } else if (corrections.length > 0) {
      logger.debug(`修正管理同期: 未処理修正 ${corrections.length}件あるが、適用対象なし`);
    }

    return correctionMap;
  }

  /**
   * 転記成功後に、修正管理レコードを「処理済み」にマークする
   */
  async markProcessed(sheetId: string, correctionRowIndexes: number[]): Promise<void> {
    for (const rowIndex of correctionRowIndexes) {
      try {
        await this.sheets.markCorrectionProcessed(sheetId, rowIndex);
      } catch (error) {
        // マーク失敗は致命的ではない（次回実行時に再処理される = 冪等）
        logger.warn(`修正管理処理済みマーク失敗 (row=${rowIndex}): ${(error as Error).message}`);
      }
    }
  }
}
