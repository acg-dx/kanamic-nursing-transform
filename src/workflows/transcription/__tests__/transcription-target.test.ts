import { describe, it, expect } from 'vitest';
import { TranscriptionWorkflow } from '../transcription.workflow';
import type { TranscriptionRecord } from '../../../types/spreadsheet.types';

function makeRecord(overrides: Partial<TranscriptionRecord> = {}): TranscriptionRecord {
  return {
    rowIndex: 2,
    recordId: 'test-001',
    timestamp: '',
    updatedAt: '',
    staffNumber: '001',
    staffName: 'テスト太郎',
    aozoraId: 'AZ001',
    patientName: 'テスト患者',
    visitDate: '2026-02-27',
    startTime: '09:00',
    endTime: '10:00',
    serviceType1: '医療',
    serviceType2: '通常',
    completionStatus: '2',    // デフォルト: 転記対象
    accompanyCheck: '',
    emergencyFlag: '',
    accompanyClerkCheck: '',
    multipleVisit: '',
    emergencyClerkCheck: '',
    transcriptionFlag: '',    // デフォルト: 未転記
    masterCorrectionFlag: false,
    errorDetail: '',
    dataFetchedAt: '',
    serviceTicketCheck: false,
    notes: '',
    recordLocked: false,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const workflow = new TranscriptionWorkflow(null as any, null as any, null as any, null as any);

describe('isTranscriptionTarget', () => {
  // ===== completionStatus フィルタ（会議決定: "1"と空白は転記対象外） =====

  it('completionStatus が空白のレコードは転記対象外', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({ completionStatus: '' }))).toBe(false);
  });

  it('completionStatus が "1"（日々チェック保留）のレコードは転記対象外', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({ completionStatus: '1' }))).toBe(false);
  });

  it('completionStatus が "2" のレコードは転記対象', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({ completionStatus: '2', transcriptionFlag: '' }))).toBe(true);
  });

  it('completionStatus が "3" のレコードは転記対象', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({ completionStatus: '3', transcriptionFlag: '' }))).toBe(true);
  });

  it('completionStatus が "4" のレコードは転記対象', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({ completionStatus: '4', transcriptionFlag: '' }))).toBe(true);
  });

  // ===== 重複・緊急支援スキップ =====

  it('N列「重複」かつ P列が空欄のレコードは転記対象外', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({
      accompanyCheck: '重複',
      accompanyClerkCheck: '',
      completionStatus: '2',
    }))).toBe(false);
  });

  it('N列「重複」でも P列に値があれば転記対象', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({
      accompanyCheck: '重複',
      accompanyClerkCheck: '山田太郎',
      completionStatus: '2',
      transcriptionFlag: '',
    }))).toBe(true);
  });

  it('O列「緊急支援あり」かつ R列が空欄のレコードは転記対象外', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({
      emergencyFlag: '緊急支援あり',
      emergencyClerkCheck: '',
      completionStatus: '2',
    }))).toBe(false);
  });

  it('O列「緊急支援あり」でも R列に値があれば転記対象', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({
      emergencyFlag: '緊急支援あり',
      emergencyClerkCheck: '佐藤花子',
      completionStatus: '2',
      transcriptionFlag: '',
    }))).toBe(true);
  });

  // ===== 既存ロジック（回帰テスト） =====

  it('recordLocked が true のレコードは転記対象外（completionStatus="2" でも）', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({ recordLocked: true, completionStatus: '2' }))).toBe(false);
  });

  it('transcriptionFlag が "転記済み" のレコードは転記対象外', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({ transcriptionFlag: '転記済み', completionStatus: '2' }))).toBe(false);
  });

  it('transcriptionFlag が空白のレコードは転記対象（completionStatus="2"）', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({ transcriptionFlag: '', completionStatus: '2' }))).toBe(true);
  });

  it('transcriptionFlag が "エラー：システム" のレコードは転記対象', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({ transcriptionFlag: 'エラー：システム', completionStatus: '2' }))).toBe(true);
  });

  it('transcriptionFlag が "エラー：マスタ不備" かつ masterCorrectionFlag=true のレコードは転記対象', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({
      transcriptionFlag: 'エラー：マスタ不備',
      masterCorrectionFlag: true,
      completionStatus: '2',
    }))).toBe(true);
  });

  it('transcriptionFlag が "修正あり" のレコードは転記対象', () => {
    expect(workflow.isTranscriptionTarget(makeRecord({ transcriptionFlag: '修正あり', completionStatus: '2' }))).toBe(true);
  });
});
