export interface NotificationConfig {
  /** Google Apps Script Web App URL */
  webhookUrl: string;
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
