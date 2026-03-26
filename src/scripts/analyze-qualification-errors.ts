import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';

interface StaffRecord {
  date: string;
  startTime: string;
  endTime: string;
  patientName: string;
  staffName: string;
  serviceType: string;
  serviceContent: string;
  resultFlag: string;
}

interface StaffAnalysis {
  empCode: number;
  name: string;
  actualQualification: string;
  totalRecords: number;
  recordsWithJun: number;
  recordsWithoutJun: number;
  misregisteredRecords: StaffRecord[];
  uniqueServiceContents: Set<string>;
}

// Target staff members
const targetStaff = [
  { name: '冨迫広美', empCode: 1614, actualQualification: '准看護師' },
  { name: '有村愛', empCode: 1009, actualQualification: '看護師' },
  { name: '木場亜紗実', empCode: 2117, actualQualification: '看護師' },
];

// Excluded test patients
const excludedPatients = ['青空太郎', '練習七郎', 'テスト'];

// Excluded service types (リハビリ segments)
const excludedServiceTypes = ['訪看Ⅰ５', '予訪看Ⅰ５'];

function normalizeStaffName(name: string): string {
  return name.replace(/\s+/g, '');
}

function isExcludedRecord(record: StaffRecord): boolean {
  // Exclude test patients
  if (excludedPatients.some(patient => record.patientName.includes(patient))) {
    return true;
  }

  // Exclude リハビリ segments
  if (excludedServiceTypes.includes(record.serviceType)) {
    return true;
  }

  // Exclude 12:00-12:00 monthly surcharge records
  if (record.startTime === '12:00' && record.endTime === '12:00') {
    return true;
  }

  return false;
}

function parseCSVLine(line: string): string[] {
  const cols: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cols.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }

  cols.push(current.trim().replace(/^"|"$/g, ''));
  return cols;
}

function analyzeQualificationErrors() {
  const csvPath = path.join(process.cwd(), 'downloads', 'schedule_8-1_202602.csv');

  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  // Read and decode Shift-JIS CSV
  const buffer = fs.readFileSync(csvPath);
  const csvContent = iconv.decode(buffer, 'Shift_JIS');
  const lines = csvContent.split('\n');

  // Initialize analysis objects
  const analysisMap = new Map<string, StaffAnalysis>();
  targetStaff.forEach(staff => {
    analysisMap.set(normalizeStaffName(staff.name), {
      empCode: staff.empCode,
      name: staff.name,
      actualQualification: staff.actualQualification,
      totalRecords: 0,
      recordsWithJun: 0,
      recordsWithoutJun: 0,
      misregisteredRecords: [],
      uniqueServiceContents: new Set(),
    });
  });

  // Parse CSV and analyze
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVLine(line);
    if (cols.length < 17) continue;

    const record: StaffRecord = {
      date: cols[0]?.trim() || '',
      startTime: cols[2]?.trim() || '',
      endTime: cols[3]?.trim() || '',
      patientName: cols[4]?.trim() || '',
      staffName: cols[7]?.trim() || '',
      serviceType: cols[11]?.trim() || '',
      serviceContent: cols[12]?.trim() || '',
      resultFlag: cols[16]?.trim() || '',
    };

    // Check if this is one of our target staff members
    const normalizedStaffName = normalizeStaffName(record.staffName);
    const analysis = analysisMap.get(normalizedStaffName);

    if (!analysis) continue;

    // Skip excluded records
    if (isExcludedRecord(record)) continue;

    // Count total records
    analysis.totalRecords++;

    // Track unique service contents
    analysis.uniqueServiceContents.add(record.serviceContent);

    // Check if service content contains '准'
    const hasJun = record.serviceContent.includes('准');

    if (hasJun) {
      analysis.recordsWithJun++;
    } else {
      analysis.recordsWithoutJun++;
    }

    // Determine if this is a misregistration
    let isMisregistered = false;

    if (analysis.actualQualification === '准看護師') {
      // 冨迫広美: Should be 准看護師, so records WITHOUT '准' are misregistered
      isMisregistered = !hasJun;
    } else if (analysis.actualQualification === '看護師') {
      // 有村愛 and 木場亜紗実: Should be 看護師, so records WITH '准' are misregistered
      isMisregistered = hasJun;
    }

    if (isMisregistered) {
      analysis.misregisteredRecords.push(record);
    }
  }

  // Generate report
  console.log('\n========================================');
  console.log('QUALIFICATION ERROR ANALYSIS REPORT');
  console.log('========================================\n');

  let totalCorrectionsNeeded = 0;
  let correctionsKangoToJun = 0;
  let correctionsJunToKango = 0;

  // Per-staff breakdown
  console.log('PER-STAFF BREAKDOWN:');
  console.log('----------------------------------------\n');

  analysisMap.forEach((analysis) => {
    console.log(`Staff: ${analysis.name} (emp_code: ${analysis.empCode})`);
    console.log(`Actual Qualification: ${analysis.actualQualification}`);
    console.log(`Total Records: ${analysis.totalRecords}`);
    console.log(`Records with '准': ${analysis.recordsWithJun}`);
    console.log(`Records without '准': ${analysis.recordsWithoutJun}`);
    console.log(`Misregistered Records: ${analysis.misregisteredRecords.length}`);

    if (analysis.actualQualification === '准看護師') {
      console.log(`Correction Direction: 看護師 → 准看護師 (${analysis.misregisteredRecords.length} records)`);
      correctionsKangoToJun += analysis.misregisteredRecords.length;
    } else {
      console.log(`Correction Direction: 准看護師 → 看護師 (${analysis.misregisteredRecords.length} records)`);
      correctionsJunToKango += analysis.misregisteredRecords.length;
    }

    totalCorrectionsNeeded += analysis.misregisteredRecords.length;
    console.log('');
  });

  // Summary
  console.log('CORRECTION SUMMARY:');
  console.log('----------------------------------------');
  console.log(`Total Corrections Needed: ${totalCorrectionsNeeded}`);
  console.log(`看護師 → 准看護師: ${correctionsKangoToJun}`);
  console.log(`准看護師 → 看護師: ${correctionsJunToKango}`);
  console.log('');

  // Detailed misregistered records
  console.log('MISREGISTERED RECORDS DETAIL:');
  console.log('----------------------------------------\n');

  analysisMap.forEach((analysis) => {
    if (analysis.misregisteredRecords.length === 0) {
      console.log(`${analysis.name}: No misregistered records\n`);
      return;
    }

    console.log(`${analysis.name} (${analysis.misregisteredRecords.length} misregistered):`);
    analysis.misregisteredRecords.forEach((record, idx) => {
      console.log(`  ${idx + 1}. Date: ${record.date}, Time: ${record.startTime}-${record.endTime}`);
      console.log(`     Patient: ${record.patientName}`);
      console.log(`     Service Content: ${record.serviceContent}`);
    });
    console.log('');
  });

  // Service content patterns
  console.log('SERVICE CONTENT PATTERNS:');
  console.log('----------------------------------------\n');

  analysisMap.forEach((analysis) => {
    console.log(`${analysis.name}:`);
    const sortedContents = Array.from(analysis.uniqueServiceContents).sort();
    sortedContents.forEach(content => {
      const count = analysis.misregisteredRecords.filter(r => r.serviceContent === content).length;
      if (count > 0) {
        console.log(`  [MISREGISTERED] ${content} (${count} records)`);
      } else {
        console.log(`  [OK] ${content}`);
      }
    });
    console.log('');
  });

  console.log('========================================');
  console.log('END OF REPORT');
  console.log('========================================\n');
}

analyzeQualificationErrors();
