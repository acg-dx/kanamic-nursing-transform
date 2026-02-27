import { google } from 'googleapis';
import { logger } from '../core/logger';
import type { NotificationConfig, DailyReport, WorkflowReport } from '../types/notification.types';

export class NotificationService {
  private config: NotificationConfig;

  constructor(config: NotificationConfig) {
    this.config = config;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async sendDailyReport(report: DailyReport): Promise<void> {
    if (!this.config.enabled) {
      logger.debug('通知が無効のためスキップ');
      return;
    }

    if (report.totalProcessed === 0 && report.totalErrors === 0) {
      logger.debug('処理レコードなし、メール送信スキップ');
      return;
    }

    const subject = report.overallSuccess
      ? `[カナミックRPA] 転記処理結果 ${report.date}`
      : `[カナミックRPA] ⚠️ エラー発生 ${report.date}`;

    const html = this.buildEmailHtml(report);

    try {
      const auth = new google.auth.GoogleAuth({
        keyFile: this.config.serviceAccountKeyPath,
        scopes: ['https://www.googleapis.com/auth/gmail.send'],
        clientOptions: {
          subject: this.config.from, // ドメイン全体の委任で送信元ユーザーを指定
        },
      });

      const gmail = google.gmail({ version: 'v1', auth });

      const toAddresses = this.config.to.join(', ');
      const rawMessage = this.buildRawEmail(this.config.from, toAddresses, subject, html);

      await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: rawMessage,
        },
      });

      logger.info(`通知メール送信完了: ${subject}`);
    } catch (error) {
      // Gmail API 失敗はログのみ、例外は投げない
      logger.error(`通知メール送信失敗: ${(error as Error).message}`);
    }
  }

  /**
   * RFC 2822 形式のメールを base64url エンコードして返す
   */
  private buildRawEmail(from: string, to: string, subject: string, htmlBody: string): string {
    const boundary = `boundary_${Date.now()}`;
    const lines = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(htmlBody).toString('base64'),
      '',
      `--${boundary}--`,
    ];
    const raw = lines.join('\r\n');
    // Gmail API は base64url エンコードを要求
    return Buffer.from(raw)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
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
