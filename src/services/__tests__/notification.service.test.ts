import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../notification.service';
import type { NotificationConfig, DailyReport } from '../../types/notification.types';

// Mock nodemailer
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: 'test-id' }),
    })),
  },
}));

const mockConfig: NotificationConfig = {
  enabled: true,
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    user: 'test@example.com',
    pass: 'test-password',
  },
  from: 'rpa@example.com',
  to: ['admin@example.com'],
};

const mockSuccessReport: DailyReport = {
  date: '2026-02-25',
  reports: [
    {
      workflowName: 'transcription',
      locationName: '谷山',
      success: true,
      totalRecords: 10,
      processedRecords: 10,
      errorRecords: 0,
      errors: [],
      duration: 5000,
      executedAt: '2026-02-25T07:00:00.000Z',
    },
  ],
  overallSuccess: true,
  totalProcessed: 10,
  totalErrors: 0,
};

const mockErrorReport: DailyReport = {
  date: '2026-02-25',
  reports: [
    {
      workflowName: 'transcription',
      locationName: '谷山',
      success: false,
      totalRecords: 10,
      processedRecords: 8,
      errorRecords: 2,
      errors: [
        { recordId: 'REC001', message: 'マスタ不備', category: 'master' },
        { recordId: 'REC002', message: 'システムエラー', category: 'system' },
      ],
      duration: 8000,
      executedAt: '2026-02-25T07:00:00.000Z',
    },
  ],
  overallSuccess: false,
  totalProcessed: 8,
  totalErrors: 2,
};

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new NotificationService(mockConfig);
  });

  it('isEnabled() returns true when config.enabled is true', () => {
    expect(service.isEnabled()).toBe(true);
  });

  it('isEnabled() returns false when config.enabled is false', () => {
    const disabledService = new NotificationService({ ...mockConfig, enabled: false });
    expect(disabledService.isEnabled()).toBe(false);
  });

  it('sendDailyReport sends email with success subject for successful report', async () => {
    const nodemailer = await import('nodemailer');
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test' });
    vi.mocked(nodemailer.default.createTransport).mockReturnValue({ sendMail: mockSendMail } as any);

    await service.sendDailyReport(mockSuccessReport);

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('[カナミックRPA] 転記処理結果'),
      })
    );
  });

  it('sendDailyReport sends email with error subject for failed report', async () => {
    const nodemailer = await import('nodemailer');
    const mockSendMail = vi.fn().mockResolvedValue({ messageId: 'test' });
    vi.mocked(nodemailer.default.createTransport).mockReturnValue({ sendMail: mockSendMail } as any);

    await service.sendDailyReport(mockErrorReport);

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining('⚠️ エラー発生'),
      })
    );
  });

  it('sendDailyReport does not send email when disabled', async () => {
    const nodemailer = await import('nodemailer');
    const disabledService = new NotificationService({ ...mockConfig, enabled: false });

    await disabledService.sendDailyReport(mockSuccessReport);

    expect(nodemailer.default.createTransport).not.toHaveBeenCalled();
  });

  it('sendDailyReport does not send email when no records processed', async () => {
    const nodemailer = await import('nodemailer');
    const emptyReport: DailyReport = {
      ...mockSuccessReport,
      totalProcessed: 0,
      totalErrors: 0,
    };

    await service.sendDailyReport(emptyReport);

    expect(nodemailer.default.createTransport).not.toHaveBeenCalled();
  });

  it('sendDailyReport does not throw when SMTP fails', async () => {
    const nodemailer = await import('nodemailer');
    vi.mocked(nodemailer.default.createTransport).mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(new Error('SMTP connection failed')),
    } as any);

    // Should not throw
    await expect(service.sendDailyReport(mockSuccessReport)).resolves.not.toThrow();
  });
});
