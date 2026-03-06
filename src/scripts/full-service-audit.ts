/**
 * 全面サービス内容監査スクリプト
 *
 * Google Sheet 全月タブの転記済みレコードを HAM CSV と突合し、
 * サービス内容の正誤を転記処理詳細.xlsx の全組み合わせ表に基づいて判定する。
 *
 * 検証ロジック（パターンマッチ）:
 *   1. 精神/医療 区別: 精神医療 → CSV に "精神科" を含むべき
 *   2. 資格 searchKbn: 理学療法士等 → CSV に "理学療法士等" or "作業療法士等" を含むべき
 *                       准看護師 → CSV に "・准" or "准看護師" を含むべき
 *   3. 緊急 suffix: 緊急+加算対象 → CSV に "・緊急" を含むべき
 *   4. 介護 種類: 介護+リハビリ → CSV に "Ⅰ５" を含むべき
 *                  介護+通常/緊急 → CSV に "Ⅰ３" or "Ⅰ２" 等を含むべき
 *
 * Usage: npx tsx src/scripts/full-service-audit.ts [csv-path]
 *   default csv: ./20260306.csv
 */
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import { google } from 'googleapis';
import { PatientMasterService } from '../services/patient-master.service';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const CSV_PATH = process.argv[2] || path.resolve('./20260306.csv');
const PATIENT_CSV_PATH = process.argv.find(a => a.startsWith('--patient-csv='))?.split('=')[1]
  || path.resolve('./4664590280_userallfull_202602.csv');
const MONTH_TAB = /^\d{4}年\d{2}月$/;

// ===== Column indices (post-C1 insert) =====
const COL = {
  A: 0, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9,
  K: 10, L: 11, M: 12, N: 13, O: 14, P: 15, Q: 16, R: 17, T: 19
} as const;

// ===== Types =====
interface SheetRec {
  tab: string; row: number; recordId: string;
  staffName: string; qualification: string;
  aozoraId: string; // F: お客様番号 (aozora ID)
  patientName: string; visitDate: string; startTime: string; endTime: string;
  st1: string; st2: string; // K, L columns
  completionStatus: string;
  accompanyCheck: string; emergencyFlag: string;
  pCol: string; qCol: string; rCol: string;
  flag: string; // T: transcription flag
}
interface CsvRec {
  line: number; visitDate: string; startTime: string; endTime: string;
  patientName: string; staffName: string; empCode: string;
  serviceType: string;    // col 11: 訪問看護/看護医療/予防訪問看護
  serviceContent: string; // col 12: actual service name
  serviceCode: string;    // col 13
  resultFlag: string;     // col 16: "1" = registered
}
interface Issue {
  bug: string;
  sheetRec: SheetRec;
  csvRec: CsvRec | null;
  expected: string;
  actual: string;
}

// ===== Helpers =====
function norm(s: string): string {
  return (s || '').normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '').trim();
}
function normDate(d: string): string {
  return (d || '').replace(/\//g, '-').trim();
}
function normTime(t: string): string {
  const m = (t || '').match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : (t || '').trim();
}
function makeKey(patient: string, date: string, start: string): string {
  return `${norm(patient)}|${normDate(date)}|${normTime(start)}`;
}
function extractQual(staffName: string): string {
  const idx = staffName.indexOf('-');
  return idx >= 0 ? staffName.substring(0, idx) : '';
}
function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s !== '' && s !== 'false' && s !== '0' && s !== 'いいえ';
}
/** L列 "緊急（臨時）" → "緊急", "通常（定期）" → "通常" */
function normSt2(st2: string): string {
  if (st2.startsWith('緊急')) return '緊急';
  if (st2.startsWith('通常')) return '通常';
  return st2;
}

// ===== Read Sheet =====
async function readSheet(): Promise<SheetRec[]> {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sp = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID, fields: 'sheets.properties',
  });
  const tabs = (sp.data.sheets || [])
    .filter(s => MONTH_TAB.test(s.properties?.title || ''))
    .map(s => s.properties!.title!)
    .sort();

  const result: SheetRec[] = [];
  for (const tab of tabs) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `'${tab}'!A2:Z`,
    });
    for (let i = 0; i < (res.data.values || []).length; i++) {
      const r = res.data.values![i];
      const recordId = (r[COL.A] || '').trim();
      if (!recordId) continue;
      result.push({
        tab, row: i + 2, recordId,
        staffName: (r[COL.E] || '').trim(),
        qualification: extractQual((r[COL.E] || '').trim()),
        aozoraId: (r[COL.F] || '').trim(),
        patientName: (r[COL.G] || '').trim(),
        visitDate: (r[COL.H] || '').trim(),
        startTime: (r[COL.I] || '').trim(),
        endTime: (r[COL.J] || '').trim(),
        st1: (r[COL.K] || '').trim(),
        st2: (r[COL.L] || '').trim(),
        completionStatus: (r[COL.M] || '').trim(),
        accompanyCheck: (r[COL.N] || '').trim(),
        emergencyFlag: (r[COL.O] || '').trim(),
        pCol: (r[COL.P] || '').trim(),
        qCol: (r[COL.Q] || '').trim(),
        rCol: (r[COL.R] || '').trim(),
        flag: (r[COL.T] || '').trim(),
      });
    }
  }
  return result;
}

// ===== Read CSV =====
function readCsv(): CsvRec[] {
  const buf = fs.readFileSync(CSV_PATH);
  const text = iconv.decode(buf, 'Shift_JIS');
  const lines = text.split('\n');
  const result: CsvRec[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols: string[] = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cols.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cols.push(cur);
    if (cols.length < 17) continue;

    const patient = (cols[4] || '').trim();
    // Skip test patients
    if (['青空太郎', '練習七郎', 'テスト'].some(t => norm(patient).includes(t))) continue;

    const start = (cols[2] || '').trim();
    const end = (cols[3] || '').trim();
    // Skip start==end (non-visit records: 加算, 管理 etc.)
    if (start === end) continue;

    const content = (cols[12] || '').trim();
    // Skip non-visit service items
    if (content.includes('緊急時訪問看護加算')) continue;
    if (content.includes('特別管理加算')) continue;
    if (content.includes('超減算') || content.includes('月超')) continue;
    if (content.includes('初回加算')) continue;

    result.push({
      line: i + 1,
      visitDate: (cols[0] || '').trim(),
      startTime: start, endTime: end,
      patientName: patient,
      staffName: (cols[7] || '').trim(),
      empCode: (cols[8] || '').trim(),
      serviceType: (cols[11] || '').trim(),
      serviceContent: content,
      serviceCode: (cols[13] || '').trim(),
      resultFlag: (cols[16] || '').trim(),
    });
  }
  return result;
}

// ===== Expected Service Pattern =====
function getExpectedPattern(rec: SheetRec, patientMaster?: PatientMasterService): {
  csvServiceType: string;  // CSV col 11 期待値
  mustContain: string[];   // サービス内容に含むべきパターン
  mustNotContain: string[]; // サービス内容に含むべきでないパターン
  description: string;
} {
  const st2 = normSt2(rec.st2);
  const q = rec.qualification;

  if (rec.st1 === '介護') {
    // 介護度判定: 要支援1-2 → 予防訪問看護, 要介護1-5 → 訪問看護
    let isYobo = false;
    if (patientMaster && rec.aozoraId) {
      const patient = patientMaster.findByAozoraId(rec.aozoraId);
      if (patient) {
        const careType = PatientMasterService.determineCareType(patient.careLevel);
        if (careType === '予防') isYobo = true;
      }
    }
    const expectedServiceType = isYobo ? '予防訪問看護' : '訪問看護';
    const prefix = isYobo ? '予防' : '介護';

    if (st2 === 'リハビリ' || rec.st2 === 'リハビリ') {
      return { csvServiceType: expectedServiceType, mustContain: ['Ⅰ５'], mustNotContain: [],
               description: `${prefix}リハビリ → ${isYobo ? '予' : ''}訪看Ⅰ５` };
    }
    // 介護通常/緊急
    const must: string[] = [];
    if (q === '准看護師') must.push('准');
    return { csvServiceType: expectedServiceType, mustContain: must, mustNotContain: [],
             description: `${prefix}通常/緊急 → ${isYobo ? '予' : ''}訪看Ⅰ（${q || '看護師'}）` };
  }

  if (rec.st1 === '医療') {
    const must: string[] = ['訪問看護基本療養費', '（Ⅰ・Ⅱ）'];
    const mustNot: string[] = ['精神科'];

    if (q === '理学療法士等') must.push('理学療法士等');
    else if (q === '准看護師') must.push('准');

    if (st2.startsWith('緊急') && rec.rCol.trim() === '加算対象') {
      must.push('緊急');
      return { csvServiceType: '看護医療', mustContain: must, mustNotContain: mustNot,
               description: `医療+緊急+加算対象 → （Ⅰ・Ⅱ）・緊急（${q || '看護師'}）` };
    }
    if (st2 === 'リハビリ') {
      must.push('理学療法士等');
      return { csvServiceType: '看護医療', mustContain: must, mustNotContain: mustNot,
               description: '医療+リハビリ → （Ⅰ・Ⅱ）（理学療法士等）' };
    }
    return { csvServiceType: '看護医療', mustContain: must, mustNotContain: mustNot,
             description: `医療+通常 → （Ⅰ・Ⅱ）（${q || '看護師'}）` };
  }

  if (rec.st1 === '精神医療') {
    // ROW 51 特例: 精神+緊急+加算対象外 → 医療サービス
    if (st2.startsWith('緊急') && rec.rCol.trim() !== '加算対象') {
      const must = ['訪問看護基本療養費', '（Ⅰ・Ⅱ）'];
      if (q === '理学療法士等') must.push('理学療法士等');
      else if (q === '准看護師') must.push('准');
      return { csvServiceType: '看護医療', mustContain: must, mustNotContain: [],
               description: `精神+緊急+加算対象外 → 医療（Ⅰ・Ⅱ）（${q || '看護師'}）★ROW51特例★` };
    }

    const must: string[] = ['精神科訪問看護基本療養費', '（Ⅰ・Ⅲ）'];
    // 精神+理学 → HAM uses "作業療法士等" (not 理学)
    if (q === '理学療法士等') must.push('作業療法士等');
    else if (q === '准看護師') must.push('准');

    if (st2.startsWith('緊急') && rec.rCol.trim() === '加算対象') {
      must.push('緊急');
      return { csvServiceType: '看護医療', mustContain: must, mustNotContain: [],
               description: `精神+緊急+加算対象 → 精神科（Ⅰ・Ⅲ）・緊急（${q || '看護師'}）` };
    }
    return { csvServiceType: '看護医療', mustContain: must, mustNotContain: [],
             description: `精神+${st2} → 精神科（Ⅰ・Ⅲ）（${q || '看護師'}）` };
  }

  return { csvServiceType: '', mustContain: [], mustNotContain: [], description: '不明' };
}

// ===== Classify mismatches =====
function classifyIssue(rec: SheetRec, csv: CsvRec, expected: ReturnType<typeof getExpectedPattern>): string[] {
  const issues: string[] = [];
  const content = csv.serviceContent;
  const normContent = norm(content);
  const st2 = normSt2(rec.st2);

  // Check mustContain
  for (const pat of expected.mustContain) {
    if (!content.includes(pat) && !normContent.includes(norm(pat))) {
      // Classify by which pattern is missing
      if (pat === '精神科訪問看護基本療養費' || pat === '（Ⅰ・Ⅲ）') {
        issues.push('B-精神→医療(textPattern)');
      } else if (pat === '理学療法士等' || pat === '作業療法士等') {
        issues.push('A-searchKbn(理学)');
      } else if (pat.includes('准')) {
        issues.push('F-searchKbn(准看)');
      } else if (pat === '緊急') {
        issues.push('C-緊急suffix欠落');
      } else if (pat === '（Ⅰ・Ⅱ）') {
        issues.push('G-textPattern不一致');
      } else if (pat === 'Ⅰ５') {
        issues.push('H-介護リハビリ種類');
      } else {
        issues.push(`X-pattern欠落(${pat})`);
      }
    }
  }

  // Check mustNotContain
  for (const pat of expected.mustNotContain) {
    if (content.includes(pat)) {
      issues.push(`D-禁止pattern含有(${pat})`);
    }
  }

  // serviceType check
  if (expected.csvServiceType && csv.serviceType !== expected.csvServiceType) {
    issues.push(`E-serviceType不一致(expected=${expected.csvServiceType},got=${csv.serviceType})`);
  }

  return issues;
}

// ===== Main =====
async function main() {
  console.log(`=== 全面サービス内容監査 ===`);
  console.log(`CSV: ${CSV_PATH}`);

  // Load patient master for 介護度判定 (要支援→予防)
  const patientMaster = new PatientMasterService();
  const patientCsvPath = path.resolve(PATIENT_CSV_PATH);
  if (fs.existsSync(patientCsvPath)) {
    await patientMaster.loadFromCsv(patientCsvPath);
    console.log(`Patient master: ${patientMaster.count} entries loaded (${patientCsvPath})`);
  } else {
    console.warn(`Patient master CSV not found: ${patientCsvPath} — 介護度判定 disabled`);
  }
  console.log('');

  const sheetRecs = await readSheet();
  console.log(`Sheet records: ${sheetRecs.length}`);
  const csvRecs = readCsv();
  console.log(`CSV records (after filtering): ${csvRecs.length}\n`);

  // Build CSV index by key
  const csvIdx = new Map<string, CsvRec[]>();
  for (const c of csvRecs) {
    const k = makeKey(c.patientName, c.visitDate, c.startTime);
    if (!csvIdx.has(k)) csvIdx.set(k, []);
    csvIdx.get(k)!.push(c);
  }

  // Analyze each transcribed record
  const issues: Issue[] = [];
  let transcribedCount = 0;
  let matchedCount = 0;
  let noMatchCount = 0;
  let correctCount = 0;
  const noResultFlag: SheetRec[] = [];

  for (const rec of sheetRecs) {
    if (rec.flag !== '転記済み') continue;
    transcribedCount++;

    const key = makeKey(rec.patientName, rec.visitDate, rec.startTime);
    const csvMatches = csvIdx.get(key) || [];

    if (csvMatches.length === 0) {
      noMatchCount++;
      continue;
    }

    // Find the best matching CSV row (prefer resultFlag=1, then matching serviceType)
    let bestCsv = csvMatches[0];
    for (const c of csvMatches) {
      if (c.resultFlag === '1' && bestCsv.resultFlag !== '1') bestCsv = c;
    }

    matchedCount++;

    // Check resultFlag
    if (bestCsv.resultFlag !== '1') {
      noResultFlag.push(rec);
    }

    // Get expected pattern (with 介護度判定)
    const expected = getExpectedPattern(rec, patientMaster);
    if (!expected.csvServiceType) continue; // unknown combination

    // Check for mismatches
    const bugList = classifyIssue(rec, bestCsv, expected);
    if (bugList.length > 0) {
      issues.push({
        bug: bugList.join(' + '),
        sheetRec: rec,
        csvRec: bestCsv,
        expected: expected.description,
        actual: `${bestCsv.serviceType}/${bestCsv.serviceContent}`,
      });
    } else {
      correctCount++;
    }
  }

  // ===== Report =====
  console.log('='.repeat(90));
  console.log('監査結果サマリ');
  console.log('='.repeat(90));
  console.log(`転記済みレコード: ${transcribedCount}`);
  console.log(`CSV突合成功: ${matchedCount}`);
  console.log(`CSV未発見: ${noMatchCount}（3月分の可能性、またはCSVカバー外）`);
  console.log(`正常（問題なし）: ${correctCount}`);
  console.log(`問題あり: ${issues.length}`);
  console.log(`実績フラグなし: ${noResultFlag.length}`);

  // Group by bug category
  const bugGroups = new Map<string, Issue[]>();
  for (const iss of issues) {
    // Use primary bug (first one)
    const primary = iss.bug.split(' + ')[0];
    if (!bugGroups.has(primary)) bugGroups.set(primary, []);
    bugGroups.get(primary)!.push(iss);
  }

  for (const [bug, items] of [...bugGroups].sort()) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`[${bug}] ${items.length}件`);
    console.log(`${'─'.repeat(70)}`);

    // Tab summary
    const tabCounts = new Map<string, number>();
    for (const it of items) tabCounts.set(it.sheetRec.tab, (tabCounts.get(it.sheetRec.tab) || 0) + 1);
    for (const [t, c] of tabCounts) console.log(`  ${t}: ${c}件`);

    // Details (max 15)
    const show = items.slice(0, 15);
    for (const it of show) {
      const r = it.sheetRec;
      console.log(`  Row ${r.row} [${r.tab}] ID=${r.recordId} | ${r.visitDate} ${r.startTime} | ${r.patientName} | ${r.qualification} | ${r.st1}/${r.st2} P=${r.pCol||'空'} R=${r.rCol||'空'}`);
      console.log(`    期待: ${it.expected}`);
      console.log(`    実際: ${it.actual}`);
    }
    if (items.length > 15) console.log(`  ... 他 ${items.length - 15}件`);
  }

  // Unique record summary
  const uniqueRecs = new Map<string, { rec: SheetRec; bugs: string[] }>();
  for (const iss of issues) {
    const k = `${iss.sheetRec.tab}:${iss.sheetRec.row}`;
    const ex = uniqueRecs.get(k);
    if (ex) { ex.bugs.push(iss.bug); } else { uniqueRecs.set(k, { rec: iss.sheetRec, bugs: [iss.bug] }); }
  }

  console.log(`\n${'='.repeat(90)}`);
  console.log(`要修正レコード（重複排除）: ${uniqueRecs.size}件`);
  console.log(`${'='.repeat(90)}`);
  const tabSum = new Map<string, { total: number; kaigo: number; iryo: number; seishin: number }>();
  for (const [, v] of uniqueRecs) {
    const t = v.rec.tab;
    if (!tabSum.has(t)) tabSum.set(t, { total: 0, kaigo: 0, iryo: 0, seishin: 0 });
    const s = tabSum.get(t)!;
    s.total++;
    if (v.rec.st1 === '介護') s.kaigo++;
    else if (v.rec.st1 === '医療') s.iryo++;
    else if (v.rec.st1 === '精神医療') s.seishin++;
  }
  for (const [t, s] of [...tabSum].sort()) {
    console.log(`  ${t}: ${s.total}件 (介護:${s.kaigo} 医療:${s.iryo} 精神:${s.seishin})`);
  }

  // Bug category totals
  console.log(`\nBug分類別集計:`);
  for (const [bug, items] of [...bugGroups].sort()) {
    console.log(`  ${bug}: ${items.length}件`);
  }

  // Write machine-readable corrections list (for prepare-correction script)
  const corrections = issues.map(iss => ({
    tab: iss.sheetRec.tab,
    row: iss.sheetRec.row,
    recordId: iss.sheetRec.recordId,
    bugs: iss.bug.split(' + '),
    patientName: iss.sheetRec.patientName,
    visitDate: iss.sheetRec.visitDate,
    startTime: iss.sheetRec.startTime,
    st1: iss.sheetRec.st1,
    st2: iss.sheetRec.st2,
    qualification: iss.sheetRec.qualification,
  }));
  const jsonPath = path.resolve('./audit-corrections.json');
  fs.writeFileSync(jsonPath, JSON.stringify(corrections, null, 2));
  console.log(`\n修正リスト出力: ${jsonPath} (${corrections.length}件)`);
}

main().catch(err => { console.error(err); process.exit(1); });
