export interface NotificationConfig {
  enabled: boolean;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  from: string;
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
