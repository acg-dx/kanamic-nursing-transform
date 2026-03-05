import { logger } from '../core/logger';
import type { NotificationConfig, DailyReport, WorkflowReport } from '../types/notification.types';

export class NotificationService {
  private config: NotificationConfig;

  constructor(config: NotificationConfig) {
    this.config = config;
  }

  isEnabled(): boolean {
    // webhookUrl と to が設定されていれば有効
    return !!(this.config.webhookUrl && this.config.to.length > 0);
  }

  async sendDailyReport(report: DailyReport): Promise<void> {
    if (!this.isEnabled()) {
      logger.debug('通知が無効のためスキップ（webhookUrl/to 未設定）');
      return;
    }

    if (report.totalProcessed === 0 && report.totalErrors === 0) {
      logger.debug('処理レコードなし、メール送信スキップ');
      return;
    }

    const subject = report.overallSuccess
      ? `[カナミックRPA] 転記処理結果 ${report.date}`
      : `[カナミックRPA] ⚠️ エラー発生 ${report.date}`;

    const htmlBody = this.buildEmailHtml(report);

    try {
      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: this.config.to.join(','),
          subject,
          htmlBody,
        }),
        redirect: 'follow',
      });

      const result = await response.json() as { success: boolean; error?: string };
      if (result.success) {
        logger.info(`通知メール送信完了: ${subject}`);
      } else {
        logger.error(`通知メール送信失敗: ${result.error || 'unknown error'}`);
      }
    } catch (error) {
      // Webhook 失敗はログのみ、例外は投げない
      logger.error(`通知メール送信失敗: ${(error as Error).message}`);
    }
  }

  private buildEmailHtml(report: DailyReport): string {
    const statusIcon = report.overallSuccess ? '✅' : '❌';
    const rows = report.reports.map(r => this.buildReportRow(r)).join('');

    return `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>カナミックRPA処理結果</title></head>
<body style="font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">
  <h2>${statusIcon} カナミックRPA 処理結果レポート</h2>
  <p><strong>処理日:</strong> ${report.date}</p>
  <p><strong>総合結果:</strong> ${report.overallSuccess ? '✅ 正常完了' : '❌ エラーあり'}</p>
  <p><strong>処理件数:</strong> ${report.totalProcessed}件 / エラー: ${report.totalErrors}件</p>
  
  <h3>詳細</h3>
  <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
    <thead style="background-color: #f0f0f0;">
      <tr>
        <th>ワークフロー</th>
        <th>事業所</th>
        <th>結果</th>
        <th>処理件数</th>
        <th>エラー件数</th>
        <th>処理時間</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  
  ${report.totalErrors > 0 ? this.buildErrorSection(report.reports) : ''}
  
  <hr>
  <p style="color: #666; font-size: 12px;">このメールはカナミックRPAシステムから自動送信されています。</p>
</body>
</html>`;
  }

  private buildReportRow(report: WorkflowReport): string {
    const statusIcon = report.success ? '✅' : '❌';
    const durationSec = (report.duration / 1000).toFixed(1);
    return `
    <tr>
      <td>${report.workflowName}</td>
      <td>${report.locationName || '-'}</td>
      <td>${statusIcon} ${report.success ? '正常' : 'エラー'}</td>
      <td>${report.processedRecords}/${report.totalRecords}</td>
      <td>${report.errorRecords}</td>
      <td>${durationSec}秒</td>
    </tr>`;
  }

  private buildErrorSection(reports: WorkflowReport[]): string {
    const allErrors = reports.flatMap(r =>
      r.errors.map(e => ({ ...e, workflow: r.workflowName, location: r.locationName }))
    );
    if (allErrors.length === 0) return '';

    const errorRows = allErrors.map(e => `
    <tr>
      <td>${e.workflow}</td>
      <td>${e.location || '-'}</td>
      <td>${e.recordId}</td>
      <td>${e.category}</td>
      <td>${e.message}</td>
    </tr>`).join('');

    return `
  <h3>エラー詳細</h3>
  <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%;">
    <thead style="background-color: #ffe0e0;">
      <tr>
        <th>ワークフロー</th>
        <th>事業所</th>
        <th>レコードID</th>
        <th>カテゴリ</th>
        <th>エラー内容</th>
      </tr>
    </thead>
    <tbody>${errorRows}</tbody>
  </table>`;
  }
}
