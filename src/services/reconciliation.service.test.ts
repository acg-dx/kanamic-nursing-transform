import { describe, it, expect } from 'vitest';
import {
  checkTimeMismatch,
  checkServiceMismatch,
  checkStaffMismatch,
} from './reconciliation.service';

// ─── checkTimeMismatch ───

describe('checkTimeMismatch', () => {
  it('returns undefined when times match exactly', () => {
    expect(checkTimeMismatch('09:00', '09:00')).toBeUndefined();
  });

  it('returns mismatch object when times differ (D-03: exact, no tolerance)', () => {
    const result = checkTimeMismatch('09:00', '09:01');
    expect(result).toEqual({ sheetsEndTime: '09:00', hamEndTime: '09:01' });
  });

  it('normalizes H:MM to HH:MM before comparison', () => {
    expect(checkTimeMismatch('8:20', '08:20')).toBeUndefined();
  });

  it('returns undefined when sheets time is empty (skip)', () => {
    expect(checkTimeMismatch('', '09:00')).toBeUndefined();
  });

  it('returns undefined when ham time is empty (skip)', () => {
    expect(checkTimeMismatch('09:00', '')).toBeUndefined();
  });

  it('returns undefined when both times are empty', () => {
    expect(checkTimeMismatch('', '')).toBeUndefined();
  });
});

// ─── checkServiceMismatch ───

describe('checkServiceMismatch', () => {
  it('returns undefined for kaigo match (Sheets=介護, HAM=訪看Ⅰ１)', () => {
    const result = checkServiceMismatch(
      { serviceType1: '介護', serviceType2: '訪問看護' },
      { serviceName: '訪問看護', serviceContent: '訪看Ⅰ１' },
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined for medical match (Sheets=医療, HAM=療養費)', () => {
    const result = checkServiceMismatch(
      { serviceType1: '医療', serviceType2: '訪問看護' },
      { serviceName: '訪問看護', serviceContent: '訪問看護基本療養費Ⅰ' },
    );
    expect(result).toBeUndefined();
  });

  it('returns mismatch for cross-type: Sheets=医療 but HAM=訪看Ⅰ３ (kaigo)', () => {
    const result = checkServiceMismatch(
      { serviceType1: '医療', serviceType2: '訪問看護' },
      { serviceName: '訪問看護', serviceContent: '訪看Ⅰ３' },
    );
    expect(result).toBeDefined();
    expect(result!.description).toContain('保険種類不一致');
    expect(result!.description).toContain('介護保険サービス');
  });

  it('returns mismatch for cross-type: Sheets=介護 but HAM=療養費 (medical)', () => {
    const result = checkServiceMismatch(
      { serviceType1: '介護', serviceType2: '訪問看護' },
      { serviceName: '訪問看護', serviceContent: '訪問看護基本療養費Ⅰ' },
    );
    expect(result).toBeDefined();
    expect(result!.description).toContain('保険種類不一致');
    expect(result!.description).toContain('医療保険サービス');
  });

  it('returns undefined for I5 rehab (skip per D-08)', () => {
    const result = checkServiceMismatch(
      { serviceType1: '介護', serviceType2: '訪問リハビリ' },
      { serviceName: '訪問看護', serviceContent: '訪看Ⅰ５' },
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when HAM serviceName and serviceContent are both empty', () => {
    const result = checkServiceMismatch(
      { serviceType1: '介護', serviceType2: '訪問看護' },
      { serviceName: '', serviceContent: '' },
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined for 精神医療 match with 精神科 HAM service', () => {
    const result = checkServiceMismatch(
      { serviceType1: '精神医療', serviceType2: '訪問看護' },
      { serviceName: '精神科訪問看護', serviceContent: '精神科訪問看護基本療養費' },
    );
    expect(result).toBeUndefined();
  });
});

// ─── checkStaffMismatch ───

describe('checkStaffMismatch', () => {
  it('returns undefined when CJK-normalized names match', () => {
    const result = checkStaffMismatch(
      '高山 利愛',
      '高山利愛',
      '訪看Ⅰ３',
      new Map(),
    );
    expect(result).toBeUndefined();
  });

  it('returns mismatch when names differ', () => {
    const result = checkStaffMismatch(
      '田中太郎',
      '山田花子',
      '訪看Ⅰ３',
      new Map(),
    );
    expect(result).toBeDefined();
    expect(result!.sheetsStaffName).toBe('田中太郎');
    expect(result!.hamStaffName).toBe('山田花子');
  });

  it('returns qualification issue when 准看護師 registered without 准 in HAM service', () => {
    const quals = new Map([['田中太郎', '准看護師']]);
    const result = checkStaffMismatch(
      '田中太郎',
      '田中太郎',
      '訪看Ⅰ３',  // no 准
      quals,
    );
    expect(result).toBeDefined();
    expect(result!.qualificationIssue).toContain('准看護師');
  });

  it('returns qualification issue when 看護師 but HAM has 准', () => {
    const quals = new Map([['田中太郎', '看護師']]);
    const result = checkStaffMismatch(
      '田中太郎',
      '田中太郎',
      '訪看Ⅰ３准',
      quals,
    );
    expect(result).toBeDefined();
    expect(result!.qualificationIssue).toBeDefined();
  });

  it('returns undefined when names match and no qualifications map entries', () => {
    const result = checkStaffMismatch(
      '田中太郎',
      '田中太郎',
      '訪看Ⅰ３',
      new Map(),
    );
    expect(result).toBeUndefined();
  });

  it('handles CJK variant normalization (髙→高)', () => {
    const result = checkStaffMismatch(
      '髙山利愛',
      '高山利愛',
      '訪看Ⅰ３',
      new Map(),
    );
    expect(result).toBeUndefined();
  });
});
