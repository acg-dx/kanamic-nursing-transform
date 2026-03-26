import { describe, it, expect } from 'vitest';
import { normalizeCjkName, extractPlainName } from '../cjk-normalize';

describe('normalizeCjkName', () => {
  it('ひらがな→カタカナ統一: 水口とも子 → 水口トモ子', () => {
    expect(normalizeCjkName('水口とも子')).toBe('水口トモ子');
  });

  it('ひらがな→カタカナ統一: 水口トモ子 → 水口トモ子 (カタカナはそのまま)', () => {
    expect(normalizeCjkName('水口トモ子')).toBe('水口トモ子');
  });

  it('表記揺れ統一: 水口とも子 と 水口トモ子 は同一キーになる', () => {
    expect(normalizeCjkName('水口とも子')).toBe(normalizeCjkName('水口トモ子'));
  });

  it('旧字体→新字体: 白澤英幸 → 白沢英幸', () => {
    expect(normalizeCjkName('白澤英幸')).toBe('白沢英幸');
  });

  it('旧字体+ひらがな複合: 髙橋ゆきこ → 高橋ユキコ', () => {
    expect(normalizeCjkName('髙橋ゆきこ')).toBe('高橋ユキコ');
  });

  it('空白除去', () => {
    expect(normalizeCjkName('山田　太郎')).toBe('山田太郎');
  });

  it('カタカナのみの名前はそのまま', () => {
    expect(normalizeCjkName('ヤマダタロウ')).toBe('ヤマダタロウ');
  });

  it('ひらがなのみの名前はカタカナに変換', () => {
    expect(normalizeCjkName('やまだたろう')).toBe('ヤマダタロウ');
  });
});

describe('extractPlainName + normalizeCjkName (staffSurname extraction)', () => {
  it('看護師-白澤英幸 → normalizeCjkName → 白沢英幸 → substring(0,3) → 白沢英', () => {
    const plain = extractPlainName('看護師-白澤英幸');
    const normalized = normalizeCjkName(plain);
    expect(normalized).toBe('白沢英幸');
    expect(normalized.substring(0, 3)).toBe('白沢英');
  });

  it('看護師-水口とも子 → normalizeCjkName → 水口トモ子 → substring(0,3) → 水口ト', () => {
    const plain = extractPlainName('看護師-水口とも子');
    const normalized = normalizeCjkName(plain);
    expect(normalized).toBe('水口トモ子');
    expect(normalized.substring(0, 3)).toBe('水口ト');
  });
});
