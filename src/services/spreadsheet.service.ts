import { google, sheets_v4 } from 'googleapis';
import { logger } from '../core/logger';
import type { TranscriptionRecord, DeletionRecord, CorrectionRecord, BuildingManagementRecord, FacilityDefinition } from '../types/spreadsheet.types';
import type { TranscriptionStatus, DeletionStatus } from '../types/workflow.types';

// Column indices (0-based)
// NOTE: C1 変更後の列レイアウト（加算対象の理由 列を S(18) に挿入）
//   A(0)=記録ID, B(1)=タイムスタンプ, C(2)=更新日時, D(3)=スタッフ番号, E(4)=スタッフ名
//   F(5)=あおぞらID, G(6)=患者名, H(7)=訪問日, I(8)=開始時間, J(9)=終了時間
//   K(10)=サービス種別1, L(11)=サービス種別2, M(12)=完了状態, N(13)=同行チェック
//   O(14)=緊急フラグ, P(15)=同行事務員チェック, Q(16)=複数訪問, R(17)=緊急時事務員チェック
//   S(18)=加算対象の理由 ← NEW (C1 挿入)
//   T(19)=転記フラグ (旧 S), U(20)=マスタ修正フラグ (旧 T), V(21)=エラー詳細 (旧 U)
//   W(22)=データ取得日時 (旧 V), X(23)=サービス票チェック (旧 W), Y(24)=備考 (旧 X)
//   Z(25)=実績ロック (旧 Y)
const COL_A = 0, COL_B = 1, COL_C = 2, COL_D = 3, COL_E = 4;
const COL_F = 5, COL_G = 6, COL_H = 7, COL_I = 8, COL_J = 9;
const COL_K = 10, COL_L = 11, COL_M = 12, COL_N = 13, COL_O = 14;
const COL_P = 15, COL_Q = 16, COL_R = 17, COL_S = 18, COL_T = 19;
const COL_U = 20, COL_V = 21, COL_W = 22, COL_X = 23, COL_Y = 24;
const COL_Z = 25;
// 列の意味（C1 挿入後）
const COL_SURCHARGE_REASON = COL_S;   // S(18) = 加算対象の理由 (NEW)
const COL_TRANSCRIPTION_FLAG = COL_T; // T(19) = 転記フラグ (旧 S)
const COL_MASTER_CORRECTION = COL_U;  // U(20) = マスタ修正フラグ (旧 T)
const COL_ERROR_DETAIL = COL_V;       // V(21) = エラー詳細 (旧 U)
const COL_DATA_FETCHED_AT = COL_W;    // W(22) = データ取得日時 (旧 V)
const COL_SERVICE_TICKET = COL_X;     // X(23) = サービス票チェック (旧 W)
const COL_NOTES = COL_Y;              // Y(24) = 備考 (旧 X)
const COL_RECORD_LOCKED = COL_Z;      // Z(25) = 実績ロック (旧 Y)
const COL_AA = 26;
const COL_HAM_ASSIGN_ID = COL_AA;     // AA(26) = HAM assignId（転記時に保存、削除時に使用）

function colToLetter(col: number): string {
  if (col < 26) return String.fromCharCode(65 + col); // A=0 .. Z=25
  // AA=26, AB=27, ...
  return String.fromCharCode(64 + Math.floor(col / 26)) + String.fromCharCode(65 + (col % 26));
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

  async getTranscriptionRecords(sheetId: string, tab?: string): Promise<TranscriptionRecord[]> {
    tab = tab || getCurrentMonthTab();
    const range = `${tab}!A2:AA`; // AA列(26)=HAM assignId まで取得
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
        surchargeReason: row[COL_SURCHARGE_REASON] || '',   // S(18) = 加算対象の理由 (NEW)
        transcriptionFlag: row[COL_TRANSCRIPTION_FLAG] || '', // T(19) = 転記フラグ
        masterCorrectionFlag: parseBoolean(row[COL_MASTER_CORRECTION]), // U(20)
        errorDetail: row[COL_ERROR_DETAIL] || '',           // V(21)
        dataFetchedAt: row[COL_DATA_FETCHED_AT] || '',      // W(22)
        serviceTicketCheck: parseBoolean(row[COL_SERVICE_TICKET]), // X(23)
        notes: row[COL_NOTES] || '',                        // Y(24)
        recordLocked: parseBoolean(row[COL_RECORD_LOCKED]), // Z(25)
        hamAssignId: row[COL_HAM_ASSIGN_ID] || '',       // AA(26)
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
    errorDetail?: string,
    tab?: string,
  ): Promise<void> {
    tab = tab || getCurrentMonthTab();
    const updates: Array<{ range: string; values: string[][] }> = [
      { range: `${tab}!${colToLetter(COL_TRANSCRIPTION_FLAG)}${rowIndex}`, values: [[status]] }, // T(19)
    ];
    if (errorDetail !== undefined) {
      updates.push({ range: `${tab}!${colToLetter(COL_ERROR_DETAIL)}${rowIndex}`, values: [[errorDetail]] }); // V(21)
    } else if (status === '転記済み') {
      updates.push({ range: `${tab}!${colToLetter(COL_ERROR_DETAIL)}${rowIndex}`, values: [['']] }); // V(21)
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

  async writeDataFetchedAt(sheetId: string, rowIndex: number, timestamp: string, tab?: string): Promise<void> {
    tab = tab || getCurrentMonthTab();
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tab}!${colToLetter(COL_DATA_FETCHED_AT)}${rowIndex}`, // W(22) データ取得日時
      valueInputOption: 'RAW',
      requestBody: { values: [[timestamp]] },
    });
  }

  /** HAM assignId を月次Sheet AA列に書き込む（転記時に保存、削除時に使用） */
  async writeHamAssignId(sheetId: string, rowIndex: number, assignId: string, tab?: string): Promise<void> {
    tab = tab || getCurrentMonthTab();
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tab}!${colToLetter(COL_HAM_ASSIGN_ID)}${rowIndex}`, // AA(26)
      valueInputOption: 'RAW',
      requestBody: { values: [[assignId]] },
    });
    logger.debug(`HAM assignId 書き込み: row=${rowIndex}, assignId=${assignId}`);
  }

  /**
   * 月次Sheet の指定セルを空白にクリアする（汎用）
   * @param column 列文字 (e.g. 'N')
   */
  async clearCellValue(sheetId: string, tab: string, column: string, rowIndex: number): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tab}!${column}${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['']] },
    });
  }

  /** 月次Sheet から recordId → hamAssignId のマップを構築（削除ワークフロー用） */
  async getAssignIdMap(sheetId: string, tab?: string): Promise<{
    assignIds: Map<string, string>;
    /** 月次シートで転記済みまたは修正ありと記録されている recordId 集合。
     *  月次シート読み取り失敗時は null（安全のためフォールバック動作を維持）。 */
    registeredIds: Set<string> | null;
  }> {
    tab = tab || getCurrentMonthTab();
    const range = `${tab}!A2:AA`;
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });
      const assignIds = new Map<string, string>();
      const registeredIds = new Set<string>();
      for (const row of response.data.values || []) {
        const recordId = row[COL_A] || '';
        if (!recordId) continue;
        const assignId = row[COL_HAM_ASSIGN_ID] || '';
        const transcriptionFlag = row[COL_TRANSCRIPTION_FLAG] || '';
        if (assignId) {
          assignIds.set(recordId, assignId);
        }
        // HAM に登録済みと判定する条件:
        //   - 転記フラグが「転記済み」（正常完了）
        //   - 転記フラグが「修正あり」（転記済み後に修正検出）
        //   - assignId が存在（HAM 登録の確実な証拠）
        if (transcriptionFlag === '転記済み' || transcriptionFlag === '修正あり' || assignId) {
          registeredIds.add(recordId);
        }
      }
      return { assignIds, registeredIds };
    } catch (error) {
      logger.warn(`assignIdMap 構築エラー（削除はフォールバック方式で続行）: ${(error as Error).message}`);
      return { assignIds: new Map(), registeredIds: null };
    }
  }

  async getDeletionRecords(sheetId: string): Promise<DeletionRecord[]> {
    const range = `${this.DELETION_SHEET_NAME}!A2:M`;
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });
      const rows = response.data.values || [];
      // IMPORTANT: map BEFORE filter to preserve correct rowIndex (sheet row numbers)
      // filter-before-map would produce wrong rowIndex when empty rows exist
      return rows
        .map((row, index) => ({
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
        }))
        .filter(record => record.recordId); // skip empty rows (after rowIndex assignment)
    } catch (error) {
      logger.error(`削除レコード取得エラー: ${(error as Error).message}`);
      throw error;
    }
  }

  async updateDeletionStatus(sheetId: string, rowIndex: number, status: DeletionStatus): Promise<void> {
    // 削除タブのM列（完了ステータス）に書き込む
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${this.DELETION_SHEET_NAME}!M${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status]] },
    });
  }

  /**
   * 月次シートから指定レコードIDの行を削除する
   * 複数マッチした場合は下から順に削除（インデックスずれを防ぐ）
   * @param sheetId スプレッドシートID
   * @param tabName 月次タブ名 (e.g. "2026年02月")
   * @param recordId 削除対象レコードID (A列の値)
   * @returns true: 少なくとも1行削除, false: マッチなし or タブ不存在
   */
  async deleteRowByRecordId(sheetId: string, tabName: string, recordId: string): Promise<boolean> {
    // Step 1: タブの内部 gid を取得
    const spreadsheet = await this.sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: 'sheets.properties',
    });
    const sheet = spreadsheet.data.sheets?.find(s => s.properties?.title === tabName);
    const gid = sheet?.properties?.sheetId;
    if (gid == null) {
      logger.warn(`deleteRowByRecordId: タブ「${tabName}」が見つかりません (sheetId=${sheetId})`);
      return false;
    }

    // Step 2: A列の全データを取得してマッチする行インデックス (0-based) を収集
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabName}!A:A`,
    });
    const rows = response.data.values || [];
    const matchIndices: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i]?.[0] ?? '') === recordId) {
        matchIndices.push(i);
      }
    }

    if (matchIndices.length === 0) {
      logger.debug(`deleteRowByRecordId: 「${tabName}」にレコードID「${recordId}」が見つかりません`);
      return false;
    }

    // Step 3: インデックスずれを防ぐため下から順に deleteDimension リクエストを作成
    const sortedDesc = [...matchIndices].sort((a, b) => b - a);
    const requests = sortedDesc.map(rowIdx => ({
      deleteDimension: {
        range: {
          sheetId: gid,
          dimension: 'ROWS' as const,
          startIndex: rowIdx,
          endIndex: rowIdx + 1,
        },
      },
    }));

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests },
    });

    logger.info(`deleteRowByRecordId: 「${tabName}」から ${matchIndices.length} 行削除 (recordId=${recordId})`);
    return true;
  }

  /** 削除用タブ名 */
  private readonly DELETION_SHEET_NAME = '削除';

  /**
   * 削除Sheet が存在しなければ作成する
   */
  private async ensureDeletionSheetExists(sheetId: string): Promise<void> {
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: 'sheets.properties',
    });
    const exists = meta.data.sheets?.some(
      s => s.properties?.title === this.DELETION_SHEET_NAME
    );
    if (exists) return;

    logger.info(`削除Sheet タブが存在しないため作成します`);
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: this.DELETION_SHEET_NAME,
              gridProperties: { rowCount: 1000, columnCount: 13 },
            },
          },
        }],
      },
    });
    // ヘッダー行を書き込み
    const headers = [
      ['ID', 'タイムスタンプ', '更新日時', '従業員番号', '記録者', 'あおぞらID',
       '利用者', '日付', '開始時刻', '終了時刻', '支援区分1', '支援区分2', '完了ステータス'],
    ];
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${this.DELETION_SHEET_NAME}!A1:M1`,
      valueInputOption: 'RAW',
      requestBody: { values: headers },
    });
  }

  /**
   * 削除Sheetにレコードを追加（予実突合の HAM余剰・資格不一致 用）
   */
  async appendDeletionRecords(
    sheetId: string,
    records: Array<{
      patientName: string;
      visitDate: string;
      startTime: string;
      endTime?: string;
      staffName?: string;
      serviceType1?: string;
      serviceType2?: string;
    }>,
  ): Promise<void> {
    if (records.length === 0) return;
    await this.ensureDeletionSheetExists(sheetId);

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const rows = records.map((r, i) => [
      `del-${Date.now()}-${i}`,
      now,
      now,
      '', // staffNumber
      r.staffName || '',
      '', // aozoraId
      r.patientName,
      r.visitDate.replace(/\//g, '-'),
      r.startTime,
      r.endTime || '',
      r.serviceType1 || '',
      r.serviceType2 || '',
      '', // completionStatus
    ]);
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${this.DELETION_SHEET_NAME}!A2:M`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
    logger.info(`削除Sheetに ${records.length} 件追加`);
  }

  async getCorrectionRecords(sheetId: string): Promise<CorrectionRecord[]> {
    const range = '看護記録修正管理!A2:H';
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
          visitDate: row[COL_D] || '',
          correctedAt: row[COL_E] || '',
          changeDetail: row[COL_F] || '',
          status: row[COL_G] || '',
          errorLog: row[COL_H] || '',
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
      range: `看護記録修正管理!G${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status]] },
    });
    if (errorLog !== undefined) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `看護記録修正管理!H${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[errorLog]] },
      });
    }
  }

  async appendCorrectionRecord(
    sheetId: string,
    record: Omit<CorrectionRecord, 'rowIndex'>
  ): Promise<void> {
    // G列（ステータス）とH列（エラーログ）は書き込まない。
    // G列にはプルダウン（データ入力規則）が設定されているため、
    // RAW で値を書き込むとプルダウンが消失する。
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: '看護記録修正管理!A:F',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          record.correctionId,
          record.recordId,
          record.patientName,
          record.visitDate,
          record.correctedAt,
          record.changeDetail,
        ]],
      },
    });
  }

  // ─── 同一建物管理 ────────────────────────────────────────

  /**
   * 前月の同一建物管理タブ名を返す（形式: "2026/02"）
   * 転記の "2026年02月" とは異なる形式なので注意
   */
  getPreviousMonthBuildingTab(): string {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${prev.getFullYear()}/${String(prev.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * 月度タブから同一建物管理レコードを取得
   * @param sheetId 連携スプレッドシートID
   * @param tab 月度タブ名 (e.g. "2026/02")。省略時は前月
   */
  async getBuildingManagementRecords(sheetId: string, tab?: string): Promise<BuildingManagementRecord[]> {
    tab = tab || this.getPreviousMonthBuildingTab();
    const range = `${tab}!A2:I`;
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
      logger.error(`建物管理レコード取得エラー (tab=${tab}): ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 転記シートから対象月に訪問看護を利用したあおぞらIDの一覧を取得（軽量版）
   * F列(あおぞらID)のみ読み取り、重複を除去して返す。
   *
   * @param sheetId 転記用事業所シートID
   * @param tab 月度タブ名 (e.g. "2026年02月")
   * @returns ユニークなあおぞらIDのSet
   */
  async getVisitedAozoraIds(sheetId: string, tab?: string): Promise<Set<string>> {
    tab = tab || getCurrentMonthTab();
    const range = `${tab}!F2:F`; // F列 = あおぞらID
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });
      const rows = response.data.values || [];
      const ids = new Set<string>();
      for (const row of rows) {
        const id = (row[0] || '').trim();
        if (id) ids.add(id);
      }
      return ids;
    } catch (error) {
      logger.warn(`訪問看護利用者ID取得エラー (sheetId=${sheetId}, tab=${tab}): ${(error as Error).message}`);
      return new Set();
    }
  }

  /**
   * 同一建物管理のステータス（H列）と備考（I列）を更新
   */
  async updateBuildingManagementStatus(
    sheetId: string,
    rowIndex: number,
    status: string,
    tab?: string,
    errorDetail?: string,
  ): Promise<void> {
    tab = tab || this.getPreviousMonthBuildingTab();
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tab}!H${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status]] },
    });
    if (errorDetail !== undefined) {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${tab}!I${rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[errorDetail]] },
      });
    }
  }

  /**
   * 施設定義タブからマッピングを取得
   * A列: 拠点名（有料老人ホーム系）
   * B列: 拠点名（共同生活援助系）
   * C列: カナミック登録施設名
   */
  async getFacilityDefinitions(sheetId: string): Promise<FacilityDefinition[]> {
    const range = '施設定義!A2:C';
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });
      const rows = response.data.values || [];
      return rows
        .filter(r => r[2]) // C列（カナミック名）が必須
        .map(r => ({
          sourceNameA: r[0] || '',
          sourceNameB: r[1] || '',
          kanamickName: r[2] || '',
        }));
    } catch (error) {
      logger.error(`施設定義取得エラー: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 月度タブを新規作成（存在しない場合のみ）
   * 既存タブのヘッダーを元にテンプレート行を追加
   */
  async ensureBuildingMonthlyTab(sheetId: string, tab: string): Promise<void> {
    try {
      const spreadsheet = await this.sheets.spreadsheets.get({ spreadsheetId: sheetId });
      const existing = spreadsheet.data.sheets?.find(s => s.properties?.title === tab);
      if (existing) {
        logger.debug(`建物管理タブ「${tab}」は既に存在します`);
        return;
      }

      // タブ新規作成
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: tab } } }],
        },
      });

      // ヘッダー行を書き込む
      const headers = ['入居施設', 'あおぞらID', '利用者名', '利用訪問看護事業所名', '入居日', '退去日', '新規フラグ', 'ステータス', '備考'];
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${tab}!A1:I1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers] },
      });

      logger.info(`建物管理タブ「${tab}」を新規作成しました`);
    } catch (error) {
      logger.error(`建物管理タブ作成エラー: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 月度タブにレコードを一括書き込み（既存データをクリアして上書き）
   */
  async writeBuildingMonthlyRecords(
    sheetId: string,
    tab: string,
    records: Array<{
      facilityName: string;
      aozoraId: string;
      userName: string;
      nursingOfficeName: string;
      moveInDate: string;
      moveOutDate: string;
      isNew: boolean;
      status: string;
      notes: string;
    }>,
  ): Promise<void> {
    // まず既存データ（A2:I以降）をクリア
    try {
      await this.sheets.spreadsheets.values.clear({
        spreadsheetId: sheetId,
        range: `${tab}!A2:I`,
      });
    } catch {
      // タブが空の場合はエラーになることがあるので無視
    }

    if (records.length === 0) {
      logger.info(`建物管理: 書き込み対象0件 (tab=${tab})`);
      return;
    }

    const values = records.map(r => [
      r.facilityName,
      r.aozoraId,
      r.userName,
      r.nursingOfficeName,
      r.moveInDate,
      r.moveOutDate,
      r.isNew ? 'TRUE' : 'FALSE',
      r.status,
      r.notes,
    ]);

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${tab}!A2:I${records.length + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });

    logger.info(`建物管理: ${records.length} 件を「${tab}」に書き込みました`);
  }

  /**
   * 月次シートの S列（転記フラグ）と U列（エラー詳細）に折返表示を設定。
   * 文字が見切れないように wrapStrategy: WRAP を適用する。
   */
  async formatTranscriptionColumns(sheetId: string, tab?: string): Promise<void> {
    tab = tab || getCurrentMonthTab();
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
