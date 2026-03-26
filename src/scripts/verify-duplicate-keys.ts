/**
 * 重複キーのCSV突合検証
 *
 * find-duplicate-keys で検出された重複グループについて、
 * HAM CSV と照合し、実際にHAMに登録されているか確認する。
 *
 * Usage: npx tsx src/scripts/verify-duplicate-keys.ts [csv-path]
 */
import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';

const CSV_PATH = process.argv[2] || path.resolve('./2026030617.csv');

function norm(s: string): string {
  return (s || '').normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '').trim();
}
function normTime(t: string): string {
  const m = (t || '').match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : (t || '').trim();
}

interface CsvRec {
  line: number;
  visitDate: string;
  startTime: string;
  endTime: string;
  patientName: string;
  staffName: string;
  empCode: string;
  serviceType: string;
  serviceContent: string;
  resultFlag: string;
}

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
    if (['青空太郎', '練習七郎', 'テスト'].some(t => norm(patient).includes(t))) continue;

    const start = (cols[2] || '').trim();
    const end = (cols[3] || '').trim();
    if (start === end) continue;

    const content = (cols[12] || '').trim();
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
      resultFlag: (cols[16] || '').trim(),
    });
  }
  return result;
}

// Known duplicate groups from Sheet
const DUPLICATE_GROUPS = [
  {
    key: '小濵士郎|2026-02-27|14:00',
    sheetRecords: [
      { id: '121911', staff: '准看護師-冨迫広美', st1: '医療', st2: '通常（定期）', end: '14:30' },
      { id: '121908', staff: '理学療法士等-鏑流馬健人', st1: '医療', st2: 'リハビリ', end: '14:40' },
    ]
  },
  {
    key: '前田清子|2026-02-04|13:00',
    sheetRecords: [
      { id: '121125', staff: '看護師-有村愛', st1: '介護', st2: '通常（定期）', end: '13:30' },
      { id: '121140', staff: '准看護師-冨迫広美', st1: '介護', st2: '通常（定期）', end: '13:30' },
    ]
  },
  {
    key: '榮博造|2026-02-01|13:00',
    sheetRecords: [
      { id: '121034', staff: '看護師-木場亜紗実', st1: '介護', st2: '通常（定期）', end: '13:30' },
      { id: '121050', staff: '准看護師-冨迫広美', st1: '介護', st2: '緊急（臨時）', end: '13:30' },
    ]
  },
];

function main() {
  console.log(`=== 重複キー CSV突合検証 ===`);
  console.log(`CSV: ${CSV_PATH}\n`);

  const csvRecs = readCsv();
  console.log(`CSV records: ${csvRecs.length}\n`);

  // Build CSV index by patient+date+startTime
  const csvIdx = new Map<string, CsvRec[]>();
  for (const c of csvRecs) {
    const k = `${norm(c.patientName)}|${c.visitDate}|${normTime(c.startTime)}`;
    if (!csvIdx.has(k)) csvIdx.set(k, []);
    csvIdx.get(k)!.push(c);
  }

  for (const group of DUPLICATE_GROUPS) {
    console.log('═'.repeat(100));
    console.log(`\n[KEY] ${group.key}`);
    console.log('─'.repeat(80));

    console.log('\nSheet records:');
    for (const sr of group.sheetRecords) {
      console.log(`  ID=${sr.id} | ${sr.staff} | ${sr.st1}/${sr.st2} | end=${sr.end}`);
    }

    // Find in CSV - try various date formats
    const parts = group.key.split('|');
    const patientNorm = parts[0];
    const dateStr = parts[1]; // 2026-02-27
    const timeStr = parts[2]; // 14:00

    // Try date in CSV format (YYYY/MM/DD)
    const dateSlash = dateStr.replace(/-/g, '/');
    const k1 = `${patientNorm}|${dateSlash}|${timeStr}`;
    const k2 = `${patientNorm}|${dateStr}|${timeStr}`;

    let csvMatches = csvIdx.get(k1) || csvIdx.get(k2) || [];

    // Also try broader search by patient name
    if (csvMatches.length === 0) {
      csvMatches = csvRecs.filter(c => {
        return norm(c.patientName) === patientNorm &&
          (c.visitDate === dateSlash || c.visitDate === dateStr) &&
          normTime(c.startTime) === timeStr;
      });
    }

    console.log(`\nCSV matches for this key: ${csvMatches.length}`);
    if (csvMatches.length > 0) {
      for (const c of csvMatches) {
        console.log(
          `  Line ${c.line} | ${c.visitDate} ${c.startTime}-${c.endTime} | ` +
          `staff=${c.staffName} (${c.empCode}) | ` +
          `${c.serviceType} / ${c.serviceContent} | result=${c.resultFlag}`
        );
      }
    }

    // Analysis
    console.log('\nAnalysis:');
    const sheetCount = group.sheetRecords.length;
    const csvCount = csvMatches.length;

    if (csvCount >= sheetCount) {
      // Check if each sheet record can be matched to a CSV record
      const matched: string[] = [];
      const unmatched: string[] = [];
      for (const sr of group.sheetRecords) {
        const staffSurname = sr.staff.split('-')[1] || '';
        const found = csvMatches.some(c => c.staffName.includes(staffSurname));
        if (found) {
          matched.push(`${sr.id} (${sr.staff}) ✅ HAM CSV にスタッフ一致あり`);
        } else {
          unmatched.push(`${sr.id} (${sr.staff}) ❌ HAM CSV にスタッフ不一致`);
        }
      }
      for (const m of matched) console.log(`  ${m}`);
      for (const u of unmatched) console.log(`  ${u}`);
    } else {
      console.log(`  ⚠️  Sheet: ${sheetCount}件 vs CSV: ${csvCount}件 — HAM登録漏れの可能性`);
      for (const sr of group.sheetRecords) {
        const staffSurname = sr.staff.split('-')[1] || '';
        const found = csvMatches.some(c => c.staffName.includes(staffSurname));
        console.log(`  ${sr.id} (${sr.staff}): ${found ? '✅ HAM一致' : '❌ HAM未登録'}`);
      }
    }
    console.log('');
  }
}

main();
