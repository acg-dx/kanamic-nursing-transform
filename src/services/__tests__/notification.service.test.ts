import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../notification.service';
import type { NotificationConfig, DailyReport } from '../../types/notification.types';

// Mock fetch (Apps Script Web App)
const mockFetch = vi.fn().mockResolvedValue({
  json: () => Promise.resolve({ success: true }),
});
vi.stubGlobal('fetch', mockFetch);

const mockConfig: NotificationConfig = {
  webhookUrl: 'https://script.google.com/macros/s/test/exec',
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

  it('isEnabled() returns true when webhookUrl and to are set', () => {
    expect(service.isEnabled()).toBe(true);
  });

  it('isEnabled() returns false when webhookUrl/to are empty', () => {
    const disabledService = new NotificationService({ ...mockConfig, webhookUrl: '', to: [] });
    expect(disabledService.isEnabled()).toBe(false);
  });

  it('sendDailyReport sends via webhook for successful report', async () => {
    await service.sendDailyReport(mockSuccessReport);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      mockConfig.webhookUrl,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.any(String),
      })
    );
    // Verify JSON body contains expected fields
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.to).toBe('admin@example.com');
    expect(body.subject).toContain('転記処理結果');
    expect(body.htmlBody).toContain('✅');
  });

  it('sendDailyReport sends via webhook for failed report', async () => {
    await service.sendDailyReport(mockErrorReport);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.subject).toContain('エラー発生');
    expect(body.htmlBody).toContain('❌');
  });

  it('sendDailyReport does not send when webhookUrl/to empty', async () => {
    const disabledService = new NotificationService({ ...mockConfig, webhookUrl: '', to: [] });

    await disabledService.sendDailyReport(mockSuccessReport);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sendDailyReport does not send when no records processed', async () => {
    const emptyReport: DailyReport = {
      ...mockSuccessReport,
      totalProcessed: 0,
      totalErrors: 0,
    };

    await service.sendDailyReport(emptyReport);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sendDailyReport does not throw when webhook fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    // Should not throw
    await expect(service.sendDailyReport(mockSuccessReport)).resolves.not.toThrow();
  });
});
