export interface NotificationConfig {
  enabled: boolean;
  /** Google Service Account キーファイルパス */
  serviceAccountKeyPath: string;
  /** 送信元メールアドレス（Service Account に委任されたユーザー） */
  from: string;
  /** 送信先メールアドレス */
  to: string[];
}

export interface WorkflowReport {
  workflowName: string;
  locationName?: string;
  success: boolean;
  totalRecords: number;
  processedRecords: number;
  errorRecords: number;
  errors: Array<{
    recordId: string;
    message: string;
    category: string;
  }>;
  duration: number;
  executedAt: string;
}

export interface DailyReport {
  date: string;
  reports: WorkflowReport[];
  overallSuccess: boolean;
  totalProcessed: number;
  totalErrors: number;
}
