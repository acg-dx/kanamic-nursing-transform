import { google, sheets_v4 } from 'googleapis';
import { logger } from '../core/logger';
import type { TranscriptionRecord, DeletionRecord, CorrectionRecord, BuildingManagementRecord } from '../types/spreadsheet.types';
import type { TranscriptionStatus, DeletionStatus } from '../types/workflow.types';

// Column indices (0-based)
const COL_A = 0, COL_B = 1, COL_C = 2, COL_D = 3, COL_E = 4;
const COL_F = 5, COL_G = 6, COL_H = 7, COL_I = 8, COL_J = 9;
const COL_K = 10, COL_L = 11, COL_M = 12, COL_N = 13, COL_O = 14;
const COL_P = 15, COL_Q = 16, COL_R = 17, COL_S = 18, COL_T = 19;
const COL_U = 20, COL_V = 21, COL_W = 22, COL_X = 23, COL_Y = 24;

function colToLetter(col: number): string {
  return String.fromCharCode(65 + col); // A=0, B=1, ...
}

function getCurrentMonthTab(): string {
  const now = new Date();
  return `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月`;
}

function parseBoolean(val: string | undefined): boolean {
  return val === 'TRUE' || val === 'true' || val === '1' || val === 'はい';
}

export class SpreadsheetService {
  private sheets: sheets_v4.Sheets;

  constructor(serviceAccountKeyPath: string) {
    const auth = new google.auth.GoogleAuth({
      keyFile: serviceAccountKeyPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth });
  }

  async getTranscriptionRecords(sheetId: string): Promise<TranscriptionRecord[]> {
    const tab = getCurrentMonthTab();
    const range = `${tab}!A2:Y`;
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });
      const rows = response.data.values || [];
      return rows.map((row, index) => ({
        rowIndex: index + 2, // 1-indexed, header is row 1
        recordId: row[COL_A] || '',
        timestamp: row[COL_B] || '',
        updatedAt: row[COL_C] || '',
        staffNumber: row[COL_D] || '',
        staffName: row[COL_E] || '',
        aozoraId: row[COL_F] || '',
        patientName: row[COL_G] || '',
        visitDate: row[COL_H] || '',
        startTime: row[COL_I] || '',
        endTime: row[COL_J] || '',
        serviceType1: row[COL_K] || '',
        serviceType2: row[COL_L] || '',
        completionStatus: row[COL_M] || '',
        accompanyCheck: row[COL_N] || '',
        emergencyFlag: row[COL_O] || '',
        accompanyClerkCheck: row[COL_P] || '',
        multipleVisit: row[COL_Q] || '',
        emergencyClerkCheck: row[COL_R] || '',
        transcriptionFlag: row[COL_S] || '',
        masterCorrectionFlag: parseBoolean(row[COL_T]),
        errorDetail: row[COL_U] || '',
        dataFetchedAt: row[COL_V] || '',
        serviceTicketCheck: parseBoolean(row[COL_W]),
        notes: row[COL_X] || '',
        recordLocked: parseBoolean(row[COL_Y]),
      }));
    } catch (error) {
      logger.error(`転記レコード取得エラー (sheetId: ${sheetId}): ${(error as Error).message}`);
      throw error;
    }
  }

  async updateTranscriptionStatus(
    sheetId: string,
    rowIndex: number,
    status: TranscriptionStatus,
    errorDetail?: string
  ): Promise<void> {
    const tab = getCurrentMonthTab();
    const updates: Array<{ range: string; values: string[][] }> = [
      { range: `${tab}!${colToLetter(COL_S)}${rowIndex}`, values: [[status]] },
    ];
    if (errorDetail !== undefined) {
      updates.push({ range: `${tab}!${colToLetter(COL_U)}${rowIndex}`, values: [[errorDetail]] });
    } else if (status === '転記済み') {
      updates.push({ range: `${tab}!${colToLetter(COL_U)}${rowIndex}`, values: [['']] });
    }
    for (const update of updates) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: update.range,
        valueInputOption: 'RAW',
        requestBody: { values: update.values },
      });
    }
    logger.debug(`転記ステータス更新: row=${rowIndex}, status=${status}`);
  }

  async writeDataFetchedAt(sheetId: string, rowIndex: number, timestamp: string): Promise<void> {
    const tab = getCurrentMonthTab();
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tab}!${colToLetter(COL_V)}${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[timestamp]] },
    });
  }

  async getDeletionRecords(sheetId: string): Promise<DeletionRecord[]> {
    const range = '削除Sheet!A2:M';
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });
      const rows = response.data.values || [];
      return rows
        .filter(row => row[COL_A]) // skip empty rows
        .map((row, index) => ({
          rowIndex: index + 2,
          recordId: row[COL_A] || '',
          timestamp: row[COL_B] || '',
          updatedAt: row[COL_C] || '',
          staffNumber: row[COL_D] || '',
          staffName: row[COL_E] || '',
          aozoraId: row[COL_F] || '',
          patientName: row[COL_G] || '',
          visitDate: row[COL_H] || '',
          startTime: row[COL_I] || '',
          endTime: row[COL_J] || '',
          serviceType1: row[COL_K] || '',
          serviceType2: row[COL_L] || '',
          completionStatus: row[COL_M] || '',
        }));
    } catch (error) {
      logger.error(`削除レコード取得エラー: ${(error as Error).message}`);
      throw error;
    }
  }

  async updateDeletionStatus(sheetId: string, rowIndex: number, status: DeletionStatus): Promise<void> {
    // 削除SheetのステータスはM列（完了ステータス）に書き込む
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `削除Sheet!M${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status]] },
    });
  }

  async getCorrectionRecords(sheetId: string): Promise<CorrectionRecord[]> {
    const range = '看護記録修正管理!A2:G';
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });
      const rows = response.data.values || [];
      return rows
        .filter(row => row[COL_A])
        .map((row, index) => ({
          rowIndex: index + 2,
          correctionId: row[COL_A] || '',
          recordId: row[COL_B] || '',
          patientName: row[COL_C] || '',
          correctedAt: row[COL_D] || '',
          changeDetail: row[COL_E] || '',
          status: row[COL_F] || '',
          errorLog: row[COL_G] || '',
        }));
    } catch (error) {
      logger.error(`修正レコード取得エラー: ${(error as Error).message}`);
      return []; // 修正管理Sheetが存在しない場合は空配列
    }
  }

  async updateCorrectionStatus(
    sheetId: string,
    rowIndex: number,
    status: string,
    errorLog?: string
  ): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `看護記録修正管理!F${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status]] },
    });
    if (errorLog !== undefined) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `看護記録修正管理!G${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[errorLog]] },
      });
    }
  }

  async appendCorrectionRecord(
    sheetId: string,
    record: Omit<CorrectionRecord, 'rowIndex'>
  ): Promise<void> {
    // F列（ステータス）とG列（エラーログ）は書き込まない。
    // F列にはプルダウン（データ入力規則）が設定されているため、
    // RAW で値を書き込むとプルダウンが消失する。
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: '看護記録修正管理!A:E',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          record.correctionId,
          record.recordId,
          record.patientName,
          record.correctedAt,
          record.changeDetail,
        ]],
      },
    });
  }

  async getBuildingManagementRecords(sheetId: string): Promise<BuildingManagementRecord[]> {
    const range = '同一建物管理!A2:I';
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });
      const rows = response.data.values || [];
      return rows
        .filter(row => row[COL_A])
        .map((row, index) => ({
          rowIndex: index + 2,
          facilityName: row[0] || '',
          aozoraId: row[1] || '',
          userName: row[2] || '',
          nursingOfficeName: row[3] || '',
          moveInDate: row[4] || '',
          moveOutDate: row[5] || undefined,
          isNew: parseBoolean(row[6]),
          status: row[7] || '',
          notes: row[8] || undefined,
        }));
    } catch (error) {
      logger.error(`建物管理レコード取得エラー: ${(error as Error).message}`);
      throw error;
    }
  }

  async updateBuildingManagementStatus(
    sheetId: string,
    rowIndex: number,
    status: string
  ): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `同一建物管理!H${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status]] },
    });
  }

  /**
   * 月次シートの S列（転記フラグ）と U列（エラー詳細）に折返表示を設定。
   * 文字が見切れないように wrapStrategy: WRAP を適用する。
   */
  async formatTranscriptionColumns(sheetId: string): Promise<void> {
    const tab = getCurrentMonthTab();
    try {
      const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId: sheetId });
      const sheet = spreadsheet.data.sheets?.find(s => s.properties?.title === tab);
      if (!sheet?.properties?.sheetId && sheet?.properties?.sheetId !== 0) {
        logger.warn(`formatTranscriptionColumns: シート「${tab}」が見つかりません`);
        return;
      }
      const gid = sheet.properties.sheetId;

      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: { sheetId: gid, startColumnIndex: COL_S, endColumnIndex: COL_S + 1 },
                cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
                fields: 'userEnteredFormat.wrapStrategy',
              },
            },
            {
              repeatCell: {
                range: { sheetId: gid, startColumnIndex: COL_U, endColumnIndex: COL_U + 1 },
                cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
                fields: 'userEnteredFormat.wrapStrategy',
              },
            },
          ],
        },
      });
      logger.debug(`formatTranscriptionColumns: S列・U列の折返表示設定完了 (${tab})`);
    } catch (error) {
      logger.warn(`formatTranscriptionColumns エラー: ${(error as Error).message}`);
    }
  }
}
