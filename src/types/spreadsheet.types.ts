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
  // S(18): 加算対象の理由 ← NEW (C1 挿入)
  surchargeReason?: string;
  // T(19): 転記フラグ (旧 S)
  transcriptionFlag: string;
  // U(20): マスタ修正フラグ (旧 T)
  masterCorrectionFlag: boolean;
  // V(21): エラー詳細 (旧 U)
  errorDetail: string;
  // W(22): データ取得日時 (旧 V)
  dataFetchedAt: string;
  // X(23): 提供票チェック (旧 W)
  serviceTicketCheck: boolean;
  // Y(24): 備考 (旧 X)
  notes: string;
  // Z(25): 実績ロック (旧 Y)
  recordLocked: boolean;
  // AA(26): HAM assignId（転記時に保存、削除時に使用）
  hamAssignId?: string;
  // AB(27): 検証タイムスタンプ (ISO format, e.g. "2026-04-06T13:45:00")
  verifiedAt?: string;
  // AC(28): 検証エラー詳細 (e.g. "time:endTime,service:serviceCode" or "missing_in_ham")
  verificationError?: string;
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
  visitDate: string;      // D: 日付
  correctedAt: string;    // E: 修正日時
  changeDetail: string;   // F: 変更内容詳細
  status: string;         // G: ステータス
  errorLog: string;       // H: エラーログ
  processedFlag: string;  // I: 処理済みフラグ ("1" = 処理済み)
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

/** 施設定義（連携シート「施設定義」タブ） */
export interface FacilityDefinition {
  /** A列: 拠点名（有料老人ホーム系） e.g. "有料老人ホームあおぞら南栄" */
  sourceNameA: string;
  /** B列: 拠点名（共同生活援助系） e.g. "共同生活援助あおぞら南栄" */
  sourceNameB: string;
  /** C列: カナミック登録施設名 e.g. "共生ホーム南栄" */
  kanamickName: string;
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
