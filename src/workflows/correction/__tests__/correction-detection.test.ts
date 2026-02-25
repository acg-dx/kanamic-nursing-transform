import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CorrectionDetector } from '../correction-detection';
import type { TranscriptionRecord } from '../../../types/spreadsheet.types';

// Mock SpreadsheetService
const mockSheets = {
  appendCorrectionRecord: vi.fn().mockResolvedValue(undefined),
  updateTranscriptionStatus: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../services/spreadsheet.service', () => ({
  SpreadsheetService: vi.fn().mockImplementation(() => mockSheets),
}));

function makeRecord(overrides: Partial<TranscriptionRecord> = {}): TranscriptionRecord {
  return {
    rowIndex: 2,
    recordId: 'REC001',
    timestamp: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-25T10:00:00.000Z',
    staffNumber: 'EMP001',
    staffName: '山田太郎',
    aozoraId: 'AZ001',
    patientName: '田中花子',
    visitDate: '2026-02-25',
    startTime: '09:00',
    endTime: '10:00',
    serviceType1: '介護',
    serviceType2: '通常',
    completionStatus: '完了',
    accompanyCheck: '',
    emergencyFlag: '',
    accompanyClerkCheck: '',
    multipleVisit: '',
    emergencyClerkCheck: '',
    transcriptionFlag: '転記済み',
    masterCorrectionFlag: false,
    errorDetail: '',
    dataFetchedAt: '2026-02-24T07:00:00.000Z', // fetched BEFORE updatedAt
    serviceTicketCheck: false,
    notes: '',
    recordLocked: false,
    ...overrides,
  };
}

describe('CorrectionDetector', () => {
  let detector: CorrectionDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new CorrectionDetector(mockSheets as any);
  });

  describe('detectCorrections', () => {
    it('detects correction when updatedAt > dataFetchedAt', () => {
      const record = makeRecord({
        transcriptionFlag: '転記済み',
        updatedAt: '2026-02-25T10:00:00.000Z',
        dataFetchedAt: '2026-02-24T07:00:00.000Z',
      });

      const corrections = detector.detectCorrections([record]);
      expect(corrections).toHaveLength(1);
      expect(corrections[0].recordId).toBe('REC001');
    });

    it('ignores records where updatedAt <= dataFetchedAt', () => {
      const record = makeRecord({
        transcriptionFlag: '転記済み',
        updatedAt: '2026-02-24T06:00:00.000Z',
        dataFetchedAt: '2026-02-24T07:00:00.000Z', // fetched AFTER update
      });

      const corrections = detector.detectCorrections([record]);
      expect(corrections).toHaveLength(0);
    });

    it('ignores records that are not 転記済み', () => {
      const record = makeRecord({
        transcriptionFlag: '',
        updatedAt: '2026-02-25T10:00:00.000Z',
        dataFetchedAt: '2026-02-24T07:00:00.000Z',
      });

      const corrections = detector.detectCorrections([record]);
      expect(corrections).toHaveLength(0);
    });

    it('ignores records with missing timestamps', () => {
      const record = makeRecord({
        transcriptionFlag: '転記済み',
        updatedAt: '',
        dataFetchedAt: '',
      });

      const corrections = detector.detectCorrections([record]);
      expect(corrections).toHaveLength(0);
    });
  });

  describe('writeCorrectionRecord', () => {
    it('calls appendCorrectionRecord and updateTranscriptionStatus', async () => {
      const record = makeRecord();

      await detector.writeCorrectionRecord('sheet-id', record, 'テスト変更');

      expect(mockSheets.appendCorrectionRecord).toHaveBeenCalledWith(
        'sheet-id',
        expect.objectContaining({
          recordId: 'REC001',
          patientName: '田中花子',
          changeDetail: 'テスト変更',
          status: '未処理',
        })
      );
      expect(mockSheets.updateTranscriptionStatus).toHaveBeenCalledWith(
        'sheet-id',
        2,
        '修正あり'
      );
    });
  });

  describe('processCorrections', () => {
    it('returns 0 when no corrections detected', async () => {
      const record = makeRecord({
        transcriptionFlag: '転記済み',
        updatedAt: '2026-02-24T06:00:00.000Z',
        dataFetchedAt: '2026-02-24T07:00:00.000Z',
      });

      const count = await detector.processCorrections('sheet-id', [record]);
      expect(count).toBe(0);
    });

    it('processes all detected corrections', async () => {
      const records = [
        makeRecord({ recordId: 'REC001', updatedAt: '2026-02-25T10:00:00.000Z', dataFetchedAt: '2026-02-24T07:00:00.000Z' }),
        makeRecord({ recordId: 'REC002', rowIndex: 3, updatedAt: '2026-02-25T11:00:00.000Z', dataFetchedAt: '2026-02-24T07:00:00.000Z' }),
      ];

      const count = await detector.processCorrections('sheet-id', records);
      expect(count).toBe(2);
      expect(mockSheets.appendCorrectionRecord).toHaveBeenCalledTimes(2);
    });
  });
});
