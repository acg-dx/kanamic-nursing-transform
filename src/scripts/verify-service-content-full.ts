/**
 * サービス内容 総合検証スクリプト
 *
 * Google Sheets（2月データ）+ 転記処理詳細 + SmartHR資格 + 8-1 CSV を突合し、
 * ログイン済みのサービス内容が正しいか検証する。
 *
 * Usage:
 *   npx tsx src/scripts/verify-service-content-full.ts --csv=./schedule_4664590280_20260201.csv
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import iconv from 'iconv-lite';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { SmartHRService } from '../services/smarthr.service';
import type { TranscriptionRecord } from '../types/spreadsheet.types';

dotenv.config();

const AIRA_SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const TAB = '2026年02月';

// ─── 型定義 ───

interface CsvRecord {
  csvRow: number;
  visitDate: string;
  startTime: string;
  endTime: string;
  patientName: string;
  staffName: string;
  employeeNo: string;
  serviceType: string;
  serviceContent: string;
}

interface MismatchRecord {
  sheetRow: number;
  csvRow: number;
  patientName: string;
  visitDate: string;
  startTime: string;
  staffName: string;
  expectedContent: string;
  actualContent: string;
  issue: string;
}

type QualCategory = 'kangoshi' | 'junkangoshi' | 'rigaku' | 'other';

// ─── ユーティリティ ───

function normalize(s: string): string {
  return s.normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '').trim();
}

function normalizeDate(dateStr: string): string {
  if (!dateStr) return '';
  const c = dateStr.trim();
  if (/^\d{8}$/.test(c)) return `${c.slice(0, 4)}/${c.slice(4, 6)}/${c.slice(6, 8)}`;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(c)) return c.replace(/-/g, '/');
  return c;
}

function normalizeTime(timeStr: string): string {
  if (!timeStr) return '';
  const c = timeStr.trim();
  if (/^\d{1,2}:\d{2}$/.test(c)) return c;
  if (/^\d{4}$/.test(c)) return `${c.slice(0, 2)}:${c.slice(2, 4)}`;
  const m = c.match(/(\d{1,2})時(\d{1,2})分/);
  return m ? `${m[1]}:${m[2].padStart(2, '0')}` : c;
}

function parseCsvLine(line: string): string[] {
  const r: string[] = [];
  let cur = '';
  let q = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { q = 1 - q; continue; }
    if (ch === ',' && !q) { r.push(cur); cur = ''; continue; }
    cur += ch;
  }
  r.push(cur);
  return r;
}

function parseCsv(csvPath: string): CsvRecord[] {
  const buf = fs.readFileSync(csvPath);
  const text = iconv.decode(buf, 'Shift_JIS');
  const lines = text.split(/\r?\n/);
  const headers = parseCsvLine(lines[0]);
  const idx = (kw: string[]) => headers.findIndex(h => kw.some(k => h.includes(k)));
  const col = {
    visitDate: idx(['サービス日付', '日付']) >= 0 ? idx(['サービス日付', '日付']) : 0,
    startTime: idx(['開始時間', '開始']) >= 0 ? idx(['開始時間', '開始']) : 2,
    endTime: idx(['終了時間', '終了']) >= 0 ? idx(['終了時間', '終了']) : 3,
    patientName: idx(['利用者名', '利用者']) >= 0 ? idx(['利用者名', '利用者']) : 4,
    staffName: idx(['スタッフ名', 'スタッフ']) >= 0 ? idx(['スタッフ名', 'スタッフ']) : 7,
    employeeNo: idx(['従業員番号']) >= 0 ? idx(['従業員番号']) : 8,
    serviceType: idx(['サービス種類']) >= 0 ? idx(['サービス種類']) : 11,
    serviceContent: idx(['サービス内容']) >= 0 ? idx(['サービス内容']) : 12,
  };

  const records: CsvRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < 5) continue;
    const f = parseCsvLine(line);
    const p = (f[col.patientName] || '').trim();
    if (!p) continue;
    records.push({
      csvRow: i + 1,
      visitDate: normalizeDate(f[col.visitDate] || ''),
      startTime: normalizeTime(f[col.startTime] || ''),
      endTime: normalizeTime(f[col.endTime] || ''),
      patientName: p,
      staffName: (f[col.staffName] || '').trim(),
      employeeNo: (f[col.employeeNo] || '').trim(),
      serviceType: (f[col.serviceType] || '').trim(),
      serviceContent: (f[col.serviceContent] || '').trim(),
    });
  }
  return records;
}

function loadLocalQualifications(qualPath: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!fs.existsSync(qualPath)) return map;
  const text = fs.readFileSync(qualPath, 'utf-8');
  const lines = text.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const nameIdx = header.findIndex(h => h.includes('氏名') || h.includes('名前'));
  const qualIdx = header.findIndex(h => h.includes('資格'));
  const empIdx = header.findIndex(h => h.includes('従業員') || h.includes('番号'));
  if (nameIdx < 0 || qualIdx < 0) {
    console.warn(`資格CSV: 氏名・資格列が見つかりません: ${qualPath}`);
    return map;
  }
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const name = (cols[nameIdx] || '').trim();
    const qual = (cols[qualIdx] || '').trim();
    if (!name || !qual) continue;
    const key = normalize(name);
    const existing = map.get(key) || [];
    if (!existing.includes(qual)) existing.push(qual);
    map.set(key, existing);
    if (empIdx >= 0 && cols[empIdx]) map.set(cols[empIdx].trim(), existing);
  }
  return map;
}

function getQualCategory(quals: string[]): QualCategory {
  const hasK = quals.some(q => q === '看護師' || q === '正看護師');
  const hasJ = quals.some(q => q === '准看護師');
  const hasR = quals.some(q =>
    q.includes('理学療法士') || q.includes('作業療法士') || q.includes('言語聴覚士')
  );
  // 看護師と准看護師の両方を持つ場合は看護師を優先
  if (hasK) return 'kangoshi';
  if (hasJ) return 'junkangoshi';
  if (hasR) return 'rigaku';
  return 'other';
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s !== '' && s !== 'false' && s !== '0' && s !== 'いいえ';
}

// ─── 転記処理詳細 に基づく期待サービス内容 ───

/**
 * 医療保険の期待サービス内容を決定
 * 転記処理詳細ルール表に基づく
 */
function getExpectedServiceContent(
  record: TranscriptionRecord,
  qualCategory: QualCategory
): { expected: string; skip: boolean; reason?: string } {
  const st1 = (record.serviceType1 || '').trim();
  const st2 = (record.serviceType2 || '').trim();
  const accomp = (record.accompanyCheck || '').trim();
  const mult = isTruthy(record.multipleVisit);
  const emergClerk = isTruthy(record.emergencyClerkCheck);

  // 介護保険: 訪看Ⅰ３系
  if (st1 === '介護') {
    if (st2 === 'リハビリ') {
      return { expected: '訪看Ⅰ５ or 予訪看Ⅰ５', skip: false };
    }
    // 通常/緊急: 看護師→訪看Ⅰ３, 准看護師→訪看Ⅰ３・准
    if (qualCategory === 'junkangoshi') {
      return { expected: '訪看Ⅰ３・准 (or 訪看Ⅰ２・准 etc)', skip: false };
    }
    return { expected: '訪看Ⅰ３ (or 訪看Ⅰ２ etc)', skip: false };
  }

  // 医療保険
  if (st1 === '医療') {
    // 同行者 → 転記なし
    if (accomp.includes('同行者')) {
      return { expected: '(転記なし)', skip: true, reason: '同行者は転記対象外' };
    }
    // 複数人(副) + 複数名(二) → 転記なし
    if (accomp.includes('複数人(副)') && mult) {
      return { expected: '(転記なし)', skip: true, reason: '複数人(副)+複数名(二)は転記対象外' };
    }

    // リハビリ: 理学療法士等のみ
    if (st2.includes('リハビリ')) {
      if (qualCategory === 'kangoshi' || qualCategory === 'junkangoshi') {
        return { expected: '(エラー)', skip: false, reason: '医療リハビリは理学療法士等のみ' };
      }
      return { expected: '訪問看護基本療養費（Ⅰ・Ⅱ）（理学療法士等）', skip: false };
    }

    // 緊急（臨時）
    if (st2.includes('緊急')) {
      const suffix = emergClerk ? '・緊急' : '';
      if (qualCategory === 'junkangoshi') {
        return { expected: `訪問看護基本療養費（Ⅰ・Ⅱ）・准${suffix}`, skip: false };
      }
      if (qualCategory === 'rigaku') {
        return { expected: `訪問看護基本療養費（Ⅰ・Ⅱ）（理学療法士等）${suffix}`, skip: false };
      }
      return { expected: `訪問看護基本療養費（Ⅰ・Ⅱ）${suffix}`, skip: false };
    }

    // 通常（定期）
    const base = '訪問看護基本療養費（Ⅰ・Ⅱ）';
    if (qualCategory === 'junkangoshi') {
      if (accomp.includes('複数人(主)') && mult) return { expected: '訪問看護基本療養費（Ⅰ・Ⅱ）・複数名（他）ニ', skip: false };
      if (accomp.includes('複数人(主)')) return { expected: '訪問看護基本療養費（Ⅰ・Ⅱ）・複数名（准）', skip: false };
      if (accomp.includes('支援者') && mult) return { expected: '訪問看護基本療養費（Ⅰ・Ⅱ）・准・複数名（他）ニ', skip: false };
      if (accomp.includes('複数人(看護+介護)')) return { expected: mult ? '訪問看護基本療養費（Ⅰ・Ⅱ）・複数名（他）ニ' : '訪問看護基本療養費（Ⅰ・Ⅱ）・複数名（他）', skip: false };
      return { expected: '訪問看護基本療養費（Ⅰ・Ⅱ）・准', skip: false };
    }
    if (qualCategory === 'rigaku') {
      if (accomp.includes('複数人(主)') && mult) return { expected: '訪問看護基本療養費（Ⅰ・Ⅱ）・複数名（他）ニ', skip: false };
      if (accomp.includes('複数人(主)')) return { expected: '訪問看護基本療養費（Ⅰ・Ⅱ）・複数名（理学療法士等）', skip: false };
      if (accomp.includes('支援者') && mult) return { expected: '訪問看護基本療養費（Ⅰ・Ⅱ）（理学療法士等）', skip: false };
      return { expected: '訪問看護基本療養費（Ⅰ・Ⅱ）（理学療法士等）', skip: false };
    }
    if (qualCategory === 'kangoshi') {
      if (accomp.includes('複数人(主)') && mult) return { expected: '訪問看護基本療養費（Ⅰ・Ⅱ）・複数名（他）ニ', skip: false };
      if (accomp.includes('複数人(主)')) return { expected: '訪問看護基本療養費（Ⅰ・Ⅱ）・複数名', skip: false };
      if (accomp.includes('支援者') && mult) return { expected: '訪問看護基本療養費（Ⅰ・Ⅱ）・複数名（他）ニ', skip: false };
      return { expected: base, skip: false };
    }
    // other (介護士等)
    if (accomp.includes('複数人(主)') || accomp.includes('複数人(副)')) {
      return { expected: mult ? '訪問看護基本療養費（Ⅰ・Ⅱ）・複数名（他）ニ' : '訪問看護基本療養費（Ⅰ・Ⅱ）・複数名（他）', skip: false };
    }
    return { expected: base, skip: false };
  }

  // 精神医療
  if (st1 === '精神医療') {
    if (qualCategory === 'junkangoshi') {
      return { expected: '精神科訪問看護基本療養費（Ⅰ・Ⅲ）・准', skip: false };
    }
    return { expected: '精神科訪問看護基本療養費（Ⅰ・Ⅲ）', skip: false };
  }

  return { expected: '(未定義)', skip: false };
}

/**
 * 期待サービス内容と実際のサービス内容が一致するか判定
 * 資格ベースの必須チェック + 種別の整合性
 */
function isServiceContentMatch(expected: string, actual: string, qualCategory: QualCategory): boolean {
  if (expected.includes('(転記なし)') || expected.includes('(エラー)')) return false;

  const mustHaveJun = qualCategory === 'junkangoshi';
  const mustNotHaveJun = qualCategory === 'kangoshi';
  const hasJunInActual = actual.includes('准');

  // 資格チェック: 准看護師は必ず「准」、看護師は「准」なし
  if (mustHaveJun && !hasJunInActual) return false;
  if (mustNotHaveJun && hasJunInActual) return false;

  // 介護: 訪看Ⅰ系
  if (expected.includes('訪看Ⅰ')) {
    if (actual.includes('訪看Ⅰ５') || actual.includes('予訪看Ⅰ５')) return true;
    if (actual.includes('訪看Ⅰ')) return true;
    return false;
  }

  // 医療: 訪問看護基本療養費 / 精神科
  if (expected.includes('精神科')) {
    return actual.includes('精神科訪問看護基本療養費');
  }
  if (expected.includes('訪問看護基本療養費')) {
    return actual.includes('訪問看護基本療養費');
  }

  return true;
}

// ─── メイン ───

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const csvPath = args.find(a => a.startsWith('--csv='))?.split('=')[1] || './schedule_4664590280_20260201.csv';
  const qualPath = args.find(a => a.startsWith('--qualifications='))?.split('=')[1];

  console.log('=== サービス内容 総合検証（Sheets + 転記処理詳細 + SmartHR/資格 + CSV）===\n');
  console.log(`CSV: ${csvPath}`);
  console.log(`Sheets: 姶良 ${TAB}`);

  // 1. Google Sheets 取得
  const sheets = new SpreadsheetService(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json');
  let sheetRecords: TranscriptionRecord[] = [];
  try {
    sheetRecords = await sheets.getTranscriptionRecords(AIRA_SHEET_ID, TAB);
    const transcribed = sheetRecords.filter(r => r.transcriptionFlag === '転記済み');
    console.log(`Sheets 転記済み: ${transcribed.length} / ${sheetRecords.length}`);
    sheetRecords = transcribed;
  } catch (e) {
    console.error('Sheets 取得失敗:', (e as Error).message);
    process.exit(1);
  }

  // 2. CSV 取得
  const csvRecords = parseCsv(csvPath);
  console.log(`CSV: ${csvRecords.length} 件`);

  // 3. 資格取得（SmartHR または ローカルCSV）
  const staffQualMap = new Map<string, string[]>();
  const token = process.env.SMARTHR_ACCESS_TOKEN;
  if (token) {
    const smarthr = new SmartHRService({
      baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
      accessToken: token,
    });
    const allCrews = await smarthr.getAllCrews();
    const active = smarthr.filterActive(allCrews);
    for (const crew of active) {
      const entry = smarthr.toStaffMasterEntry(crew);
      if (entry.staffName && entry.qualifications.length > 0) {
        staffQualMap.set(normalize(entry.staffName), entry.qualifications);
        if (entry.staffNumber) staffQualMap.set(entry.staffNumber, entry.qualifications);
      }
    }
    console.log(`SmartHR 資格: ${staffQualMap.size} 名`);
  } else if (qualPath) {
    const localQuals = loadLocalQualifications(qualPath);
    for (const [k, v] of localQuals) staffQualMap.set(k, v);
    console.log(`ローカル資格: ${staffQualMap.size} 件`);
  } else {
    console.warn('SMARTHR_ACCESS_TOKEN 未設定かつ --qualifications= 未指定。資格検証はスキップされます。');
  }

  // 4. マッチキー: 患者|日付|開始時刻
  const csvByKey = new Map<string, CsvRecord[]>();
  for (const c of csvRecords) {
    const key = `${normalize(c.patientName)}|${normalizeDate(c.visitDate)}|${normalizeTime(c.startTime)}`;
    if (!csvByKey.has(key)) csvByKey.set(key, []);
    csvByKey.get(key)!.push(c);
  }

  const mismatches: MismatchRecord[] = [];
  let matched = 0;
  let noQual = 0;
  let skipNoCsv = 0;

  for (const sheet of sheetRecords) {
    const key = `${normalize(sheet.patientName)}|${normalizeDate(sheet.visitDate)}|${normalizeTime(sheet.startTime)}`;
    const csvList = csvByKey.get(key) || [];

    if (csvList.length === 0) {
      skipNoCsv++;
      continue;
    }

    const quals = staffQualMap.get(normalize(sheet.staffName)) || staffQualMap.get(sheet.staffNumber) || [];
    const qualCategory = quals.length > 0 ? getQualCategory(quals) : 'other';

    if (quals.length === 0) noQual++;

    const { expected, skip } = getExpectedServiceContent(sheet, qualCategory);
    if (skip) continue;

    // 同一キーで複数CSV行がある場合、スタッフ名でマッチ
    const csvMatch = csvList.find(c => normalize(c.staffName) === normalize(sheet.staffName))
      || csvList[0];

    if (!isServiceContentMatch(expected, csvMatch.serviceContent, qualCategory)) {
      const qualNote = qualCategory === 'junkangoshi' ? '准看護師→准必須' : qualCategory === 'kangoshi' ? '看護師→准不可' : '';
      mismatches.push({
        sheetRow: sheet.rowIndex,
        csvRow: csvMatch.csvRow,
        patientName: sheet.patientName,
        visitDate: sheet.visitDate,
        startTime: sheet.startTime,
        staffName: sheet.staffName,
        expectedContent: expected,
        actualContent: csvMatch.serviceContent,
        issue: qualNote || `期待: ${expected}`,
      });
    } else {
      matched++;
    }
  }

  // 結果
  console.log('\n--- 検証結果 ---');
  console.log(`マッチ且つ一致: ${matched} 件`);
  console.log(`不一致: ${mismatches.length} 件`);
  console.log(`資格不明: ${noQual} 件`);
  console.log(`CSVにない(Sheetsのみ): ${skipNoCsv} 件`);

  if (mismatches.length > 0) {
    console.log('\n--- 不一致一覧 ---');
    for (const m of mismatches.slice(0, 50)) {
      console.log(`  [Sheet${m.sheetRow}/CSV${m.csvRow}] ${m.visitDate} ${m.startTime} | ${m.patientName} | ${m.staffName}`);
      console.log(`    期待: ${m.expectedContent}`);
      console.log(`    実際: ${m.actualContent}`);
    }
    if (mismatches.length > 50) {
      console.log(`  ... 他 ${mismatches.length - 50} 件`);
    }

    const reportPath = path.join(process.cwd(), `service-content-full-verification-${new Date().toISOString().slice(0, 10)}.txt`);
    const lines = [
      `サービス内容 総合検証レポート ${new Date().toISOString()}`,
      `不一致: ${mismatches.length} 件`,
      '',
      ...mismatches.map(m =>
        `[Sheet${m.sheetRow}/CSV${m.csvRow}] ${m.visitDate} ${m.startTime} | ${m.patientName} | ${m.staffName}\n  期待: ${m.expectedContent}\n  実際: ${m.actualContent}`
      ),
    ];
    fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
    console.log(`\nレポート: ${reportPath}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
