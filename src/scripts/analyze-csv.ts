/**
 * 分析 8-1 CSV 数据，为突合改进提供依据
 * - 测试患者名
 * - 12:00-12:00 空记录
 * - サービスコード/サービス内容 中准看護師的编码规则
 * - リハビリ分段模式
 */
import fs from 'fs';

const csvPath = './downloads/schedule_8-1_202602.csv';
const buffer = fs.readFileSync(csvPath);
const decoder = new TextDecoder('shift-jis');
const text = decoder.decode(buffer);
const lines = text.split(/\r?\n/);

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

const headers = parseCsvLine(lines[0]);
console.log('=== HEADERS ===');
headers.forEach((h, i) => console.log(`  ${i}: ${h}`));

// Parse all data rows
const rows: string[][] = [];
for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;
  rows.push(parseCsvLine(line));
}
console.log(`\nTotal data rows: ${rows.length}`);

// Column indices based on known structure
const COL = {
  serviceDate: 0,    // サービス日付
  dayOfWeek: 1,      // 曜日
  startTime: 2,      // 開始時間
  endTime: 3,        // 終了時間
  patientName: 4,    // 利用者名
  patientKana: 5,    // フリガナ
  insuredNo: 6,      // 被保険者番号
  staffName: 7,      // スタッフ名
  employeeNo: 8,     // 従業員番号
  visitStart: 9,     // 訪問開始時間
  visitEnd: 10,      // 訪問終了時間
  serviceType: 11,   // サービス種類
  serviceContent: 12, // サービス内容
  serviceCode: 13,   // サービスコード
  units: 14,         // 単位
  amount: 15,        // 金額
  serviceResult: 16, // サービス実績
};

// 1. Find test patients
console.log('\n=== TEST PATIENTS ===');
const testPatterns = ['青空', '練習', 'システム', 'テスト', 'カンリシャ'];
const testPatients = new Set<string>();
for (const row of rows) {
  const name = row[COL.patientName] || '';
  if (testPatterns.some(p => name.includes(p))) {
    testPatients.add(name);
  }
}
console.log('Test patient names found:', [...testPatients]);

// 2. Count 12:00-12:00 records
const emptyTimeRecords = rows.filter(r =>
  r[COL.startTime] === '12:00' && r[COL.endTime] === '12:00'
);
console.log(`\n=== 12:00-12:00 EMPTY RECORDS: ${emptyTimeRecords.length} ===`);
// Show unique serviceContent values for these
const emptyServiceContents = new Map<string, number>();
for (const r of emptyTimeRecords) {
  const sc = r[COL.serviceContent] || '(empty)';
  emptyServiceContents.set(sc, (emptyServiceContents.get(sc) || 0) + 1);
}
console.log('Service contents in 12:00-12:00 records:');
for (const [k, v] of [...emptyServiceContents].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
}

// 3. Analyze サービスコード and サービス内容 for 准看護師 detection
console.log('\n=== SERVICE CODE / CONTENT ANALYSIS (for 准看護師 detection) ===');
const medicalRecords = rows.filter(r => {
  const st = r[COL.serviceType] || '';
  return st.includes('看護医療') || st.includes('医療');
});
console.log(`Medical (看護医療/医療) records: ${medicalRecords.length}`);

// Unique サービス内容 values for medical records
const medServiceContents = new Map<string, number>();
for (const r of medicalRecords) {
  const sc = r[COL.serviceContent] || '(empty)';
  medServiceContents.set(sc, (medServiceContents.get(sc) || 0) + 1);
}
console.log('\nMedical サービス内容 (col 12):');
for (const [k, v] of [...medServiceContents].sort((a, b) => b[1] - a[1])) {
  console.log(`  "${k}": ${v}`);
}

// Unique サービスコード values for medical records
const medServiceCodes = new Map<string, number>();
for (const r of medicalRecords) {
  const sc = r[COL.serviceCode] || '(empty)';
  medServiceCodes.set(sc, (medServiceCodes.get(sc) || 0) + 1);
}
console.log('\nMedical サービスコード (col 13):');
for (const [k, v] of [...medServiceCodes].sort((a, b) => b[1] - a[1])) {
  console.log(`  "${k}": ${v}`);
}

// Check for 准 in サービス内容
console.log('\n=== Records with 准 in サービス内容 ===');
const junRecords = rows.filter(r => (r[COL.serviceContent] || '').includes('准'));
console.log(`Total records with 准 in content: ${junRecords.length}`);
const junContents = new Map<string, number>();
for (const r of junRecords) {
  const sc = r[COL.serviceContent] || '';
  junContents.set(sc, (junContents.get(sc) || 0) + 1);
}
for (const [k, v] of [...junContents].sort((a, b) => b[1] - a[1])) {
  console.log(`  "${k}": ${v}`);
}

// Check for 准 in サービスコード
const junCodeRecords = rows.filter(r => (r[COL.serviceCode] || '').includes('准'));
console.log(`\nRecords with 准 in サービスコード: ${junCodeRecords.length}`);

// 4. Analyze リハビリ patterns
console.log('\n=== REHAB (リハビリ) PATTERNS ===');
const rehabRecords = rows.filter(r => {
  const sc = r[COL.serviceContent] || '';
  const st = r[COL.serviceType] || '';
  return sc.includes('リハ') || st.includes('リハ');
});
console.log(`Total リハビリ records: ${rehabRecords.length}`);

// Show unique serviceContent for rehab
const rehabContents = new Map<string, number>();
for (const r of rehabRecords) {
  const sc = r[COL.serviceContent] || '';
  rehabContents.set(sc, (rehabContents.get(sc) || 0) + 1);
}
console.log('Rehab サービス内容:');
for (const [k, v] of [...rehabContents].sort((a, b) => b[1] - a[1])) {
  console.log(`  "${k}": ${v}`);
}

// Show sample rehab records with times
console.log('\nSample rehab records (first 20):');
for (const r of rehabRecords.slice(0, 20)) {
  console.log(`  ${r[COL.patientName]} | ${r[COL.serviceDate]} ${r[COL.startTime]}-${r[COL.endTime]} | visit: ${r[COL.visitStart]}-${r[COL.visitEnd]} | ${r[COL.serviceContent]} | code: ${r[COL.serviceCode]} | staff: ${r[COL.staffName]} | result: ${r[COL.serviceResult]}`);
}

// 5. Show all unique サービス種類 (col 11) values
console.log('\n=== ALL サービス種類 (col 11) VALUES ===');
const allServiceTypes = new Map<string, number>();
for (const row of rows) {
  const st = row[COL.serviceType] || '(empty)';
  allServiceTypes.set(st, (allServiceTypes.get(st) || 0) + 1);
}
for (const [k, v] of [...allServiceTypes].sort((a, b) => b[1] - a[1])) {
  console.log(`  "${k}": ${v}`);
}

// 6. Show all unique サービス内容 (col 12) values
console.log('\n=== ALL サービス内容 (col 12) VALUES ===');
const allServiceContents = new Map<string, number>();
for (const row of rows) {
  const sc = row[COL.serviceContent] || '(empty)';
  allServiceContents.set(sc, (allServiceContents.get(sc) || 0) + 1);
}
for (const [k, v] of [...allServiceContents].sort((a, b) => b[1] - a[1])) {
  console.log(`  "${k}": ${v}`);
}
