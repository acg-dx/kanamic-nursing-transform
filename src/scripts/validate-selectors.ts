import fs from 'fs';
import path from 'path';
import type { SelectorMap, SelectorConfig } from '../types/selector.types';

const SELECTORS_DIR = path.resolve(__dirname, '../config/selectors');
const REQUIRED_FIELDS: (keyof SelectorConfig)[] = ['id', 'description', 'primary', 'fallbacks', 'context'];

interface ValidationError {
  file: string;
  selectorId: string;
  issue: string;
}

function isValidCSSSelector(selector: string): boolean {
  if (!selector || selector.trim().length === 0) return false;
  if (selector.includes('<') || selector.includes('>') || selector.includes('javascript:')) return false;
  if (selector.length > 500) return false;
  return true;
}

function validateSelectorFile(filePath: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const fileName = path.basename(filePath);

  let map: SelectorMap;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    map = JSON.parse(content) as SelectorMap;
  } catch (e) {
    return [{ file: fileName, selectorId: '*', issue: `JSONパースエラー: ${(e as Error).message}` }];
  }

  if (!map.version || !map.workflow || !map.selectors) {
    errors.push({ file: fileName, selectorId: '*', issue: 'version, workflow, selectors フィールドが必要です' });
    return errors;
  }

  for (const [id, selector] of Object.entries(map.selectors)) {
    // 必須フィールドチェック
    for (const field of REQUIRED_FIELDS) {
      if (selector[field] === undefined || selector[field] === null || selector[field] === '') {
        errors.push({ file: fileName, selectorId: id, issue: `必須フィールド '${field}' が空です` });
      }
    }

    // id一致チェック
    if (selector.id !== id) {
      errors.push({ file: fileName, selectorId: id, issue: `selector.id (${selector.id}) がキー (${id}) と一致しません` });
    }

    // CSSセレクタ検証
    if (selector.primary && !isValidCSSSelector(selector.primary)) {
      errors.push({ file: fileName, selectorId: id, issue: `無効なprimaryセレクタ: ${selector.primary}` });
    }

    if (!Array.isArray(selector.fallbacks)) {
      errors.push({ file: fileName, selectorId: id, issue: 'fallbacks は配列である必要があります' });
    } else {
      for (const fallback of selector.fallbacks) {
        if (!isValidCSSSelector(fallback)) {
          errors.push({ file: fileName, selectorId: id, issue: `無効なfallbackセレクタ: ${fallback}` });
        }
      }
    }
  }

  return errors;
}

function main(): void {
  if (!fs.existsSync(SELECTORS_DIR)) {
    console.error(`セレクタディレクトリが見つかりません: ${SELECTORS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(SELECTORS_DIR).filter(f => f.endsWith('.selectors.json'));

  if (files.length === 0) {
    console.error('セレクタJSONファイルが見つかりません');
    process.exit(1);
  }

  let totalErrors = 0;
  let totalSelectors = 0;

  for (const file of files) {
    const filePath = path.join(SELECTORS_DIR, file);
    const errors = validateSelectorFile(filePath);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const map = JSON.parse(content) as SelectorMap;
      const count = Object.keys(map.selectors || {}).length;
      totalSelectors += count;
      console.log(`✅ ${file}: ${count} selectors`);
    } catch {
      // already handled in validateSelectorFile
    }

    if (errors.length > 0) {
      for (const err of errors) {
        console.error(`  ❌ [${err.selectorId}] ${err.issue}`);
        totalErrors++;
      }
    }
  }

  console.log(`\n合計: ${files.length} ファイル, ${totalSelectors} セレクタ`);

  if (totalErrors > 0) {
    console.error(`\n❌ ${totalErrors} 件のエラーが見つかりました`);
    process.exit(1);
  } else {
    console.log('\n✅ 全セレクタ検証OK');
    process.exit(0);
  }
}

main();
