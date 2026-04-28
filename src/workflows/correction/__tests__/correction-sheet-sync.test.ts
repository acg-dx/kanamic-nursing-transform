import { describe, expect, it, vi } from 'vitest';
import { CorrectionSheetSync } from '../correction-sheet-sync';
import type { CorrectionRecord, TranscriptionRecord } from '../../../types/spreadsheet.types';

function makeRecord(overrides: Partial<TranscriptionRecord> = {}): TranscriptionRecord {
  return {
    rowIndex: 2,
    recordId: 'REC001',
    timestamp: '',
    updatedAt: '',
    staffNumber: '001',
    staffName: 'テスト太郎',
    aozoraId: 'AZ001',
    patientName: 'テスト患者',
    visitDate: '2026-04-10',
    startTime: '09:00',
    endTime: '10:00',
    serviceType1: '医療',
    serviceType2: '通常',
    completionStatus: '2',
    accompanyCheck: '',
    emergencyFlag: '',
    accompanyClerkCheck: '',
    multipleVisit: '',
    emergencyClerkCheck: '',
    transcriptionFlag: '修正あり',
    masterCorrectionFlag: false,
    errorDetail: '',
    dataFetchedAt: '',
    serviceTicketCheck: false,
    notes: '',
    recordLocked: true,
    hamAssignId: '1234',
    ...overrides,
  };
}

function makeCorrection(overrides: Partial<CorrectionRecord> = {}): CorrectionRecord {
  return {
    rowIndex: 5,
    correctionId: 'CORR001',
    recordId: 'REC001',
    patientName: 'テスト患者',
    visitDate: '2026-04-10',
    correctedAt: '2026-04-11 10:00:00',
    changeDetail: '【日付】2026-04-09→2026-04-10',
    status: '上書きOK',
    errorLog: '',
    overwriteDone: '',
    processedFlag: '',
    ...overrides,
  };
}

describe('CorrectionSheetSync', () => {
  it('unlocks locked records that are already 修正あり and keeps correctionMap for processed marking', async () => {
    const sheets = {
      unlockRecord: vi.fn().mockResolvedValue(undefined),
      updateTranscriptionStatus: vi.fn().mockResolvedValue(undefined),
    };
    const sync = new CorrectionSheetSync(sheets as any);
    const record = makeRecord();

    const correctionMap = await sync.applyCorrectionsToRecords(
      [makeCorrection()],
      [record],
      'sheet-id',
      '2026年04月',
    );

    expect(sheets.unlockRecord).toHaveBeenCalledWith('sheet-id', 2, '2026年04月');
    expect(sheets.updateTranscriptionStatus).not.toHaveBeenCalled();
    expect(record.recordLocked).toBe(false);
    expect(correctionMap.get('REC001')).toEqual([5]);
  });
});
