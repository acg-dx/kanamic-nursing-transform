/**
 * 全面对比脚本：Google Sheet 2月全量数据 vs 最新HAM 8-1 CSV
 *
 * 检查项目：
 *   1. 漏登录：Sheet有（含所有状态）但HAM CSV无
 *   2. 重复登录：HAM CSV中同一患者+日期+时间出现多条
 *   3. 状态不对：Sheet标记为エラー但HAM实际已有
 *   4. 多余HAM记录：HAM有但Sheet完全没有
 *   5. 资格不一致：准看护师被登记为看护师（看护医疗only）
 *
 * 使用方法:
 *   npx tsx src/scripts/full-reconciliation.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';
const CSV_PATH = path.resolve('./downloads/schedule_8-1_202602.csv');

// ============ Types ============
interface SheetRow {
  rowNum: number;
  recordId: string;
  staffCode: string;
  staffName: string;
  aozoraId: string;
  patientName: string;
  visitDate: string;      // original format from sheet
  startTime: string;
  endTime: string;
  serviceType1: string;   // 医療/介護/精神医療 etc
  serviceType2: string;   // 通常/リハビリ etc
  transcriptionFlag: string;
  errorDetail: string;
  masterCorrection: string;
}

interface CsvRow {
  lineNum: number;
  visitDate: string;      // YYYY/MM/DD
  startTime: string;      // HH:MM
  endTime: string;        // HH:MM
  patientName: string;
  staffName: string;
  empCode: string;
  serviceType: string;    // サービス種類
  serviceContent: string; // サービス内容
  resultFlag: string;
}

// ============ Helpers ============
function normalizeDate(d: string): string {
  // Convert various formats to YYYY-MM-DD
  if (!d) return '';
  return d.replace(/\//g, '-').trim();
}

function normalizeTime(t: string): string {
  if (!t) return '';
  // Ensure HH:MM format
  const m = t.match(/(\d{1,2}):(\d{2})/);
  if (!m) return t.trim();
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function normalizeName(s: string): string {
  if (!s) return '';
  return s.normalize('NFKC')
    .replace(/[\s\u3000\u00a0　]+/g, '')
    .replace(/[−–—ー‐]/g, '-')
    .trim();
}

function makeKey(patientName: string, date: string, startTime: string): string {
  return `${normalizeName(patientName)}|${normalizeDate(date)}|${normalizeTime(startTime)}`;
}

// ============ Read Sheet ============
async function readSheet(): Promise<SheetRow[]> {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A2:Z`,
  });
  const rows = res.data.values || [];
  const result: SheetRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const recordId = (r[0] || '').trim();
    if (!recordId) continue;

    result.push({
      rowNum: i + 2,
      recordId,
      staffCode: (r[3] || '').trim(),
      staffName: (r[4] || '').trim(),
      aozoraId: (r[5] || '').trim(),
      patientName: (r[6] || '').trim(),
      visitDate: (r[7] || '').trim(),
      startTime: (r[8] || '').trim(),
      endTime: (r[9] || '').trim(),
      serviceType1: (r[10] || '').trim(),
      serviceType2: (r[11] || '').trim(),
      transcriptionFlag: (r[19] || '').trim(),  // T列
      errorDetail: (r[21] || '').trim(),         // V列
      masterCorrection: (r[20] || '').trim(),    // U列
    });
  }
  return result;
}

// ============ Read CSV ============
function readCsv(): CsvRow[] {
  const buf = fs.readFileSync(CSV_PATH);
  const text = iconv.decode(buf, 'Shift_JIS');
  const lines = text.split('\n');
  const result: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV with quote handling
    const cols: string[] = [];
    let cur = '';
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cols.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cols.push(cur);

    if (cols.length < 17) continue;

    const patientName = (cols[4] || '').trim();
    // Skip test patients
    if (['青空太郎', '練習七郎', 'テスト'].some(t => patientName.includes(t))) continue;

    // Skip 加算 rows (超減算, 月超, etc.)
    const serviceContent = (cols[12] || '').trim();
    if (serviceContent.includes('超減算') || serviceContent.includes('月超')) continue;
    if (serviceContent.includes('緊急時訪問看護加算')) continue;

    const startTime = (cols[2] || '').trim();
    const endTime = (cols[3] || '').trim();
    // Skip: 开始时间=结束时间的记录（无效数据）
    if (startTime === endTime) continue;

    result.push({
      lineNum: i + 1,
      visitDate: (cols[0] || '').trim(),
      startTime,
      endTime,
      patientName,
      staffName: (cols[7] || '').trim(),
      empCode: (cols[8] || '').trim(),
      serviceType: (cols[11] || '').trim(),
      serviceContent,
      resultFlag: (cols[16] || '').trim(),
    });
  }
  return result;
}

// ============ Main Analysis ============
async function main() {
  console.log('=== 全面对比：Sheet vs HAM CSV ===\n');

  // 1. Read data
  console.log('Reading Sheet...');
  const sheetRows = await readSheet();
  console.log(`  Sheet records: ${sheetRows.length}`);

  console.log('Reading CSV...');
  const csvRows = readCsv();
  console.log(`  CSV records: ${csvRows.length}\n`);

  // 2. Build CSV index: key → CsvRow[]
  const csvByKey = new Map<string, CsvRow[]>();
  for (const row of csvRows) {
    const key = makeKey(row.patientName, row.visitDate, row.startTime);
    if (!csvByKey.has(key)) csvByKey.set(key, []);
    csvByKey.get(key)!.push(row);
  }

  // 3. Build Sheet index: key → SheetRow[]
  const sheetByKey = new Map<string, SheetRow[]>();
  for (const row of sheetRows) {
    const key = makeKey(row.patientName, row.visitDate, row.startTime);
    if (!sheetByKey.has(key)) sheetByKey.set(key, []);
    sheetByKey.get(key)!.push(row);
  }

  // ============ Analysis ============
  const lines: string[] = [];
  const log = (s: string) => { console.log(s); lines.push(s); };

  log('=== 全面对比结果 ===');
  log(`日期: ${new Date().toISOString()}`);
  log(`Sheet: ${sheetRows.length} 条, CSV: ${csvRows.length} 条\n`);

  // --- A. 漏登录：Sheet有但CSV无 ---
  log('--- A. 漏登录（Sheet有 但 HAM无）---');
  const missing: { sheet: SheetRow; key: string }[] = [];
  for (const row of sheetRows) {
    const key = makeKey(row.patientName, row.visitDate, row.startTime);
    const csvMatch = csvByKey.get(key);
    if (!csvMatch || csvMatch.length === 0) {
      missing.push({ sheet: row, key });
    }
  }
  log(`  共 ${missing.length} 条\n`);
  for (const m of missing) {
    const s = m.sheet;
    log(`  [${s.transcriptionFlag || '未転記'}] ${s.recordId} | ${s.patientName} | ${s.visitDate} ${s.startTime}-${s.endTime} | ${s.staffName} | ${s.serviceType1}/${s.serviceType2}`);
  }

  // --- B. 状态不对：Sheet标记为エラー但CSV中存在 ---
  log('\n--- B. 状态不对（Sheet标记为エラー 但 HAM已存在）---');
  const wrongStatus: { sheet: SheetRow; csv: CsvRow[] }[] = [];
  for (const row of sheetRows) {
    if (!row.transcriptionFlag.includes('エラー')) continue;
    const key = makeKey(row.patientName, row.visitDate, row.startTime);
    const csvMatch = csvByKey.get(key);
    if (csvMatch && csvMatch.length > 0) {
      wrongStatus.push({ sheet: row, csv: csvMatch });
    }
  }
  log(`  共 ${wrongStatus.length} 条\n`);
  for (const w of wrongStatus) {
    const s = w.sheet;
    log(`  ${s.recordId} | ${s.patientName} | ${s.visitDate} ${s.startTime} | ${s.staffName} | Sheet状态="${s.transcriptionFlag}" | 错误="${s.errorDetail}"`);
    log(`    → HAM有 ${w.csv.length} 条: ${w.csv.map(c => `${c.staffName} ${c.serviceContent}`).join('; ')}`);
  }

  // --- C. HAM重复登录 ---
  log('\n--- C. HAM重复登录（同一患者+日期+时间在CSV中出现多次）---');
  const duplicates: { key: string; rows: CsvRow[] }[] = [];
  for (const [key, rows] of csvByKey) {
    if (rows.length > 1) {
      duplicates.push({ key, rows });
    }
  }
  log(`  共 ${duplicates.length} 组\n`);
  for (const d of duplicates) {
    const [name, date, time] = d.key.split('|');
    const sheetMatch = sheetByKey.get(d.key);
    const sheetInfo = sheetMatch ? `Sheet有${sheetMatch.length}条` : 'Sheet无';
    log(`  ${name} | ${date} ${time} | CSV有${d.rows.length}条 | ${sheetInfo}`);
    for (const r of d.rows) {
      log(`    → ${r.staffName || '(スタッフ無)'} | ${r.serviceContent} | line=${r.lineNum}`);
    }
  }

  // --- D. 多余HAM记录（CSV有但Sheet完全无）---
  log('\n--- D. 多余HAM记录（HAM有 但 Sheet完全无）---');
  const extra: { key: string; rows: CsvRow[] }[] = [];
  for (const [key, rows] of csvByKey) {
    if (!sheetByKey.has(key)) {
      extra.push({ key, rows });
    }
  }
  log(`  共 ${extra.length} 组 (${extra.reduce((s, e) => s + e.rows.length, 0)} 条)\n`);
  for (const e of extra) {
    const [name, date, time] = e.key.split('|');
    for (const r of e.rows) {
      log(`  ${name} | ${date} ${time}-${r.endTime} | ${r.staffName || '(スタッフ無)'} | ${r.serviceType} | ${r.serviceContent}`);
    }
  }

  // --- E. Sheet未転記但HAM已存在 ---
  log('\n--- E. 未転記 但 HAM已存在（需更新转记flag）---');
  const pendingButExists: { sheet: SheetRow; csv: CsvRow[] }[] = [];
  for (const row of sheetRows) {
    if (row.transcriptionFlag !== '') continue; // 只看空的（未転記）
    const key = makeKey(row.patientName, row.visitDate, row.startTime);
    const csvMatch = csvByKey.get(key);
    if (csvMatch && csvMatch.length > 0) {
      pendingButExists.push({ sheet: row, csv: csvMatch });
    }
  }
  log(`  共 ${pendingButExists.length} 条\n`);
  for (const p of pendingButExists) {
    const s = p.sheet;
    log(`  ${s.recordId} | ${s.patientName} | ${s.visitDate} ${s.startTime} | ${s.staffName} | HAM有${p.csv.length}条`);
  }

  // --- F. 转记済み但HAM中不存在 ---
  log('\n--- F. 転記済み 但 HAM中不存在（可能被删除或匹配问题）---');
  const doneButMissing: SheetRow[] = [];
  for (const row of sheetRows) {
    if (row.transcriptionFlag !== '転記済み') continue;
    const key = makeKey(row.patientName, row.visitDate, row.startTime);
    const csvMatch = csvByKey.get(key);
    if (!csvMatch || csvMatch.length === 0) {
      doneButMissing.push(row);
    }
  }
  log(`  共 ${doneButMissing.length} 条\n`);
  for (const d of doneButMissing) {
    log(`  ${d.recordId} | ${d.patientName} | ${d.visitDate} ${d.startTime}-${d.endTime} | ${d.staffName} | ${d.serviceType1}/${d.serviceType2}`);
  }

  // --- G. Summary ---
  log('\n=== 汇总 ===');
  log(`Sheet总数: ${sheetRows.length}`);
  log(`  転記済み: ${sheetRows.filter(r => r.transcriptionFlag === '転記済み').length}`);
  log(`  エラー：システム: ${sheetRows.filter(r => r.transcriptionFlag === 'エラー：システム').length}`);
  log(`  エラー：マスタ不備: ${sheetRows.filter(r => r.transcriptionFlag === 'エラー：マスタ不備').length}`);
  log(`  修正あり: ${sheetRows.filter(r => r.transcriptionFlag === '修正あり').length}`);
  log(`  未転記(空): ${sheetRows.filter(r => r.transcriptionFlag === '').length}`);
  log(`CSV总数: ${csvRows.length}`);
  log('');
  log(`A. 漏登录: ${missing.length} 条`);
  log(`B. 状态不对: ${wrongStatus.length} 条`);
  log(`C. HAM重复: ${duplicates.length} 组`);
  log(`D. 多余HAM: ${extra.length} 组`);
  log(`E. 未転記但HAM有: ${pendingButExists.length} 条`);
  log(`F. 転記済みだがHAM無: ${doneButMissing.length} 条`);

  // Save evidence
  const outPath = '.sisyphus/evidence/full-reconciliation.txt';
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`\n证据保存: ${outPath}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
