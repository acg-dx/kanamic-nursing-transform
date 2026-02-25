/** 月度Sheet的转记记录 (2026年02月 等) */
export interface TranscriptionRecord {
  rowIndex: number;
  // A: レコードID
  recordId: string;
  // B: タイムスタンプ
  timestamp: string;
  // C: 更新日時
  updatedAt: string;
  // D: 従業員番号
  staffNumber: string;
  // E: 記録者
  staffName: string;
  // F: あおぞらID
  aozoraId: string;
  // G: 利用者
  patientName: string;
  // H: 日付
  visitDate: string;
  // I: 開始時刻
  startTime: string;
  // J: 終了時刻
  endTime: string;
  // K: 支援区分1 (医療/介護)
  serviceType1: string;
  // L: 支援区分2 (通常/リハビリ等)
  serviceType2: string;
  // M: 完了ステータス
  completionStatus: string;
  // N: 同行チェック
  accompanyCheck: string;
  // O: 緊急時フラグ
  emergencyFlag: string;
  // P: 同行事務員チェック
  accompanyClerkCheck: string;
  // Q: 複数名訪問(二)
  multipleVisit: string;
  // R: 緊急時事務員チェック
  emergencyClerkCheck: string;
  // S: 転記フラグ
  transcriptionFlag: string;
  // T: マスタ修正フラグ
  masterCorrectionFlag: boolean;
  // U: エラー詳細
  errorDetail: string;
  // V: データ取得日時
  dataFetchedAt: string;
  // W: 提供票チェック
  serviceTicketCheck: boolean;
  // X: 備考
  notes: string;
  // Y: 実績ロック
  recordLocked: boolean;
}

/** 削除Sheet的记录 */
export interface DeletionRecord {
  rowIndex: number;
  // 削除Sheet使用与月度Sheet相同的前13列
  recordId: string;       // A: ID
  timestamp: string;      // B: タイムスタンプ
  updatedAt: string;      // C: 更新日時
  staffNumber: string;    // D: 従業員番号
  staffName: string;      // E: 記録者
  aozoraId: string;       // F: あおぞらID
  patientName: string;    // G: 利用者
  visitDate: string;      // H: 日付
  startTime: string;      // I: 開始時刻
  endTime: string;        // J: 終了時刻
  serviceType1: string;   // K: 支援区分1
  serviceType2: string;   // L: 支援区分2
  completionStatus: string; // M: 完了ステータス
}

/** 看護記録修正管理Sheet的记录 */
export interface CorrectionRecord {
  rowIndex: number;
  correctionId: string;   // A: 修正管理ID
  recordId: string;       // B: レコードID
  patientName: string;    // C: 利用者名
  correctedAt: string;    // D: 修正日時
  changeDetail: string;   // E: 変更内容詳細
  status: string;         // F: ステータス
  errorLog: string;       // G: エラーログ
}

/** 同一建物管理记录（独立Sheet） */
export interface BuildingManagementRecord {
  rowIndex: number;
  facilityName: string;
  aozoraId: string;
  userName: string;
  nursingOfficeName: string;
  moveInDate: string;
  moveOutDate?: string;
  isNew: boolean;
  status: string;
  notes?: string;
}

/** 事业所Sheet配置 */
export interface SheetLocation {
  name: string;
  sheetId: string;
}

export interface FacilityMapping {
  source: string[];
  target: string;
}
