export type WorkflowName = 'transcription' | 'deletion' | 'building';

/**
 * S列（転記フラグ）のステータス値:
 * - 空白: 未転記（転記待ち）
 * - 転記済み: 転記成功
 * - エラー：システム: システムエラー（リトライ対象）
 * - エラー：マスタ不備: マスタ不備（T列のフラグがTRUEなら再転記対象）
 * - 修正あり: 修正管理表を確認後、再転記対象
 */
export type TranscriptionStatus =
  | ''
  | '転記済み'
  | '修正あり'
  | 'エラー：マスタ不備'
  | 'エラー：システム';

export type DeletionStatus =
  | ''
  | '削除済み'
  | '削除不要'
  | 'エラー：システム';

export interface WorkflowContext {
  workflowName: WorkflowName;
  startedAt: Date;
  dryRun: boolean;
  /** 転記/削除: 処理対象の事業所一覧 */
  locations?: import('./config.types').SheetLocation[];
  /** 同一建物管理: 連携スプレッドシートID */
  buildingMgmtSheetId?: string;
  /** 処理対象の月次シートタブ名（例: "2026年02月"）。省略時は当月 */
  tab?: string;
}

export interface WorkflowResult {
  workflowName: WorkflowName;
  success: boolean;
  totalRecords: number;
  processedRecords: number;
  errorRecords: number;
  errors: WorkflowError[];
  duration: number;
  /** 処理対象の事業所名 */
  locationName?: string;
}

export interface WorkflowError {
  recordId: string;
  message: string;
  category: 'selector' | 'master' | 'system' | 'network';
  recoverable: boolean;
  timestamp: string;
}
