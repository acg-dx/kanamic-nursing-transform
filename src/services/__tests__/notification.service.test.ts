import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../notification.service';
import type { NotificationConfig, DailyReport } from '../../types/notification.types';

// Mock googleapis
const mockSend = vi.fn().mockResolvedValue({ data: { id: 'test-id' } });
vi.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: vi.fn().mockImplementation(function () { return {}; }),
    },
    gmail: vi.fn(() => ({
      users: {
        messages: {
          send: mockSend,
        },
      },
    })),
  },
}));

const mockConfig: NotificationConfig = {
  enabled: true,
  serviceAccountKeyPath: './kangotenki.json',
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

  it('sendDailyReport sends email via Gmail API for successful report', async () => {
    await service.sendDailyReport(mockSuccessReport);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'me',
        requestBody: expect.objectContaining({
          raw: expect.any(String),
        }),
      })
    );
  });

  it('sendDailyReport sends email via Gmail API for failed report', async () => {
    await service.sendDailyReport(mockErrorReport);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'me',
        requestBody: expect.objectContaining({
          raw: expect.any(String),
        }),
      })
    );
  });

  it('sendDailyReport does not send email when disabled', async () => {
    const disabledService = new NotificationService({ ...mockConfig, enabled: false });

    await disabledService.sendDailyReport(mockSuccessReport);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sendDailyReport does not send email when no records processed', async () => {
    const emptyReport: DailyReport = {
      ...mockSuccessReport,
      totalProcessed: 0,
      totalErrors: 0,
    };

    await service.sendDailyReport(emptyReport);

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sendDailyReport does not throw when Gmail API fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('Gmail API connection failed'));

    // Should not throw
    await expect(service.sendDailyReport(mockSuccessReport)).resolves.not.toThrow();
  });
});
