import { describe, it, expect } from 'vitest';
import { computeVerificationDateRange } from './schedule-csv-downloader.service';
import type { TranscriptionRecord } from '../types/spreadsheet.types';

/**
 * computeVerificationDateRange のユニットテスト
 *
 * 転記済みレコードの訪問日から CSV ダウンロード用の日付範囲を計算する関数をテスト。
 */

/** テスト用の最小 TranscriptionRecord を生成するヘルパー */
function makeRecord(
  visitDate: string,
  transcriptionFlag: string = '転記済み',
): TranscriptionRecord {
  return {
    rowIndex: 1,
    recordId: 'R001',
    timestamp: '',
    updatedAt: '',
    staffNumber: '',
    staffName: '',
    aozoraId: '',
    patientName: 'テスト太郎',
    visitDate,
    startTime: '09:00',
    endTime: '10:00',
    serviceType1: '医療',
    serviceType2: '通常',
    completionStatus: '',
    accompanyCheck: '',
    emergencyFlag: '',
    accompanyClerkCheck: '',
    multipleVisit: '',
    emergencyClerkCheck: '',
    transcriptionFlag,
    masterCorrectionFlag: false,
    errorDetail: '',
    dataFetchedAt: '',
    serviceTicketCheck: false,
    notes: '',
    recordLocked: false,
  };
}

describe('computeVerificationDateRange', () => {
  it('Test 1: 同一月の複数レコードから min/max day を返す', () => {
    const records = [
      makeRecord('2026/03/05'),
      makeRecord('2026/03/15'),
      makeRecord('2026/03/22'),
    ];

    const result = computeVerificationDateRange(records);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      targetMonth: '202603',
      startDay: '05',
      endDay: '22',
    });
  });

  it('Test 2: 月初から月末のレコードで startDay=01, endDay=31 を返す', () => {
    const records = [
      makeRecord('2026/03/01'),
      makeRecord('2026/03/31'),
    ];

    const result = computeVerificationDateRange(records);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      targetMonth: '202603',
      startDay: '01',
      endDay: '31',
    });
  });

  it('Test 3: 2か月にまたがるレコードは月ごとに分割して返す', () => {
    const records = [
      makeRecord('2026/02/28'),
      makeRecord('2026/03/05'),
    ];

    const result = computeVerificationDateRange(records);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({
      targetMonth: '202602',
      startDay: '28',
      endDay: '28',
    });
    expect(result![1]).toEqual({
      targetMonth: '202603',
      startDay: '05',
      endDay: '05',
    });
  });

  it('Test 4: 空のレコード配列では null を返す', () => {
    const result = computeVerificationDateRange([]);
    expect(result).toBeNull();
  });

  it('Test 5: transcriptionFlag が「転記済み」のレコードのみ処理する', () => {
    const records = [
      makeRecord('2026/03/01', '転記済み'),
      makeRecord('2026/03/10', '未転記'),
      makeRecord('2026/03/20', '転記済み'),
      makeRecord('2026/03/25', 'エラー'),
    ];

    const result = computeVerificationDateRange(records);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      targetMonth: '202603',
      startDay: '01',
      endDay: '20',
    });
  });

  it('Test 6: YYYYMMDD 形式の visitDate を正しくパースする', () => {
    const records = [
      makeRecord('20260315'),
    ];

    const result = computeVerificationDateRange(records);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      targetMonth: '202603',
      startDay: '15',
      endDay: '15',
    });
  });
});
