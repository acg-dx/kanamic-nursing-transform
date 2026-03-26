/**
 * サービス内容資格検証スクリプト
 *
 * HAM 8-1 CSV の已登录データに対し、SmartHR の資格に基づき
 * サービス内容が正しいか検証する。
 *
 * 検証ルール（医療保険）:
 *   - 准看護師 → サービス内容に「准」を含むこと
 *   - 看護師 → サービス内容に「准」を含まないこと（通常/緊急）
 *   - 医療リハビリ → 理学療法士等のみ（看護師/准看護師はエラー）
 *
 * Usage:
 *   npx tsx src/scripts/verify-service-content.ts --csv=./schedule_4664590280_20260201.csv
 *   npx tsx src/scripts/verify-service-content.ts --csv=./schedule.csv --qualifications=./staff_qualifications.csv
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import iconv from 'iconv-lite';
import { SmartHRService } from '../services/smarthr.service';

dotenv.config();

// ─── 型定義 ───

interface ScheduleRecord {
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
  record: ScheduleRecord;
  expectedQual: string;
  actualQual: string;
  issue: string;
}

// ─── 定数 ───

const TEST_PATIENT_PATTERNS = ['青空', '練習', 'テスト', 'システム'];
const EXCLUDED_SERVICE_TYPES = ['訪看Ⅰ５', '予訪看Ⅰ５'];
const MEDICAL_SERVICE_PATTERNS = ['看護医療', '医療'];

// ─── ユーティリティ ───

function normalize(s: string): string {
  return s.normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '').trim();
}

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

function detectColumns(headers: string[]): Record<string, number> {
  const find = (keywords: string[]): number => {
    for (let i = 0; i < headers.length; i++) {
      if (keywords.some(kw => headers[i].includes(kw))) return i;
    }
    return -1;
  };
  return {
    visitDate: find(['サービス日付', '日付']) >= 0 ? find(['サービス日付', '日付']) : 0,
    startTime: find(['開始時間', '開始']) >= 0 ? find(['開始時間', '開始']) : 2,
    endTime: find(['終了時間', '終了']) >= 0 ? find(['終了時間', '終了']) : 3,
    patientName: find(['利用者名', '利用者']) >= 0 ? find(['利用者名', '利用者']) : 4,
    staffName: find(['スタッフ名', 'スタッフ']) >= 0 ? find(['スタッフ名', 'スタッフ']) : 7,
    employeeNo: find(['従業員番号']) >= 0 ? find(['従業員番号']) : 8,
    serviceType: find(['サービス種類', 'サービス名']) >= 0 ? find(['サービス種類', 'サービス名']) : 11,
    serviceContent: find(['サービス内容']) >= 0 ? find(['サービス内容']) : 12,
  };
}

function parseScheduleCsv(csvPath: string): ScheduleRecord[] {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV が見つかりません: ${csvPath}`);
  }
  const buffer = fs.readFileSync(csvPath);
  const text = iconv.decode(buffer, 'Shift_JIS');
  const lines = text.split(/\r?\n/);

  let headerIdx = 0;
  const knownHeaders = ['利用者', '日付', '開始', 'スタッフ', 'サービス'];
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const cols = parseCsvLine(lines[i]);
    const matchCount = knownHeaders.filter(kh => cols.some(c => c.includes(kh))).length;
    if (matchCount >= 3) {
      headerIdx = i;
      break;
    }
  }

  const headers = parseCsvLine(lines[headerIdx]);
  const colMap = detectColumns(headers);

  const records: ScheduleRecord[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < 5) continue;

    const fields = parseCsvLine(line);
    const patientName = (fields[colMap.patientName] || '').trim();
    const staffName = (fields[colMap.staffName] || '').trim();
    const serviceType = (fields[colMap.serviceType] || '').trim();
    const serviceContent = (fields[colMap.serviceContent] || '').trim();

    if (!patientName) continue;

    records.push({
      csvRow: i + 1,
      visitDate: (fields[colMap.visitDate] || '').trim(),
      startTime: (fields[colMap.startTime] || '').trim(),
      endTime: (fields[colMap.endTime] || '').trim(),
      patientName,
      staffName,
      employeeNo: (fields[colMap.employeeNo] || '').trim(),
      serviceType,
      serviceContent,
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

    if (empIdx >= 0 && cols[empIdx]) {
      map.set(cols[empIdx].trim(), existing);
    }
  }
  return map;
}

// ─── 資格判定 ───

type QualCategory = 'kangoshi' | 'junkangoshi' | 'rigaku' | 'other';

function getQualCategory(qualifications: string[]): QualCategory {
  const hasKangoshi = qualifications.some(q => q === '看護師' || q === '正看護師');
  const hasJun = qualifications.some(q => q === '准看護師');
  const hasRigaku = qualifications.some(q =>
    q.includes('理学療法士') || q.includes('作業療法士') || q.includes('言語聴覚士')
  );

  // 看護師と准看護師の両方を持つ場合は看護師を優先
  if (hasKangoshi) return 'kangoshi';
  if (hasJun) return 'junkangoshi';
  if (hasRigaku) return 'rigaku';
  return 'other';
}

function isMedicalRecord(r: ScheduleRecord): boolean {
  return MEDICAL_SERVICE_PATTERNS.some(p => r.serviceType.includes(p));
}

function isRehabRecord(r: ScheduleRecord): boolean {
  return r.serviceContent.includes('理学療法士等') || r.serviceContent.includes('理学療法士');
}

function shouldExclude(r: ScheduleRecord): boolean {
  if (TEST_PATIENT_PATTERNS.some(p => r.patientName.includes(p))) return true;
  if (r.startTime === '12:00' && r.endTime === '12:00') return true;
  if (EXCLUDED_SERVICE_TYPES.some(s => r.serviceContent.includes(s))) return true;
  return false;
}

// ─── 検証ロジック ───

function verifyRecord(
  record: ScheduleRecord,
  qualCategory: QualCategory
): MismatchRecord | null {
  const hasJunInContent = record.serviceContent.includes('准');
  const isRehab = isRehabRecord(record);

  // 医療リハビリ: 理学療法士等のみ可
  if (isRehab) {
    if (qualCategory === 'kangoshi' || qualCategory === 'junkangoshi') {
      return {
        record,
        expectedQual: '理学療法士等',
        actualQual: qualCategory === 'junkangoshi' ? '准看護師' : '看護師',
        issue: `医療リハビリは理学療法士等のみ対応。${qualCategory === 'junkangoshi' ? '准看護師' : '看護師'}は不可。`,
      };
    }
    return null;
  }

  // 通常/緊急: 准看護師 → サービス内容に「准」必須
  if (qualCategory === 'junkangoshi') {
    if (!hasJunInContent) {
      return {
        record,
        expectedQual: '准看護師',
        actualQual: '看護師等として登録',
        issue: '准看護師のためサービス内容に「准」が必要',
      };
    }
    return null;
  }

  // 通常/緊急: 看護師 → サービス内容に「准」なし
  if (qualCategory === 'kangoshi') {
    if (hasJunInContent) {
      return {
        record,
        expectedQual: '看護師等',
        actualQual: '准として登録',
        issue: '看護師のためサービス内容に「准」を含んではならない',
      };
    }
    return null;
  }

  return null;
}

/** QualificationMismatch 形式（reconciliation 互換） */
export interface VerifyQualificationMismatch {
  patientName: string;
  visitDate: string;
  startTime: string;
  staffName: string;
  sheetsServiceType: string;
  hamServiceType: string;
  issue: string;
}

/**
 * SmartHR 資格に基づき資格不一致を取得（verify-service-content 準拠）
 * reconciliation-fix で使用
 */
export async function getQualificationMismatchesFromVerify(
  csvPath: string,
  options?: { qualPath?: string }
): Promise<VerifyQualificationMismatch[]> {
  let staffQualMap = new Map<string, string[]>();
  if (options?.qualPath) {
    staffQualMap = loadLocalQualifications(options.qualPath);
  } else {
    const token = process.env.SMARTHR_ACCESS_TOKEN;
    if (token) {
      const smarthr = new SmartHRService({
        baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
        accessToken: token,
      });
      const allCrews = await smarthr.getAllCrews();
      const activeCrews = smarthr.filterActive(allCrews);
      for (const crew of activeCrews) {
        const entry = smarthr.toStaffMasterEntry(crew);
        if (entry.staffName && entry.qualifications.length > 0) {
          staffQualMap.set(normalize(entry.staffName), entry.qualifications);
          if (entry.staffNumber) staffQualMap.set(entry.staffNumber, entry.qualifications);
        }
      }
    }
  }

  const allRecords = parseScheduleCsv(csvPath);
  const medicalRecords = allRecords.filter(r => isMedicalRecord(r) && !shouldExclude(r) && r.staffName);
  const result: VerifyQualificationMismatch[] = [];

  for (const record of medicalRecords) {
    const quals = staffQualMap.get(normalize(record.staffName)) || staffQualMap.get(record.employeeNo) || [];
    if (quals.length === 0) continue;

    const category = getQualCategory(quals);
    const mismatch = verifyRecord(record, category);
    if (mismatch) {
      const sheetsType = record.serviceContent.includes('精神科') ? '精神医療/通常' : '医療/通常（定期）';
      result.push({
        patientName: record.patientName,
        visitDate: record.visitDate.replace(/\//g, '-'),
        startTime: record.startTime,
        staffName: record.staffName,
        sheetsServiceType: sheetsType,
        hamServiceType: record.serviceContent,
        issue: mismatch.issue,
      });
    }
  }
  return result;
}

// ─── メイン ───

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const csvArg = args.find(a => a.startsWith('--csv='));
  const qualArg = args.find(a => a.startsWith('--qualifications='));

  const csvPath = csvArg ? csvArg.split('=')[1] : './schedule_4664590280_20260201.csv';
  const qualPath = qualArg ? qualArg.split('=')[1] : undefined;

  console.log('=== サービス内容資格検証 ===\n');
  console.log(`CSV: ${csvPath}`);

  const allRecords = parseScheduleCsv(csvPath);
  console.log(`総レコード数: ${allRecords.length}`);

  const medicalRecords = allRecords.filter(r => isMedicalRecord(r) && !shouldExclude(r) && r.staffName);
  console.log(`医療レコード（検証対象）: ${medicalRecords.length}`);

  if (medicalRecords.length === 0) {
    console.log('\n検証対象レコードがありません。');
    return;
  }

  // 資格マップ取得
  let staffQualMap = new Map<string, string[]>();

  if (qualPath) {
    staffQualMap = loadLocalQualifications(qualPath);
    console.log(`ローカル資格: ${staffQualMap.size} 件読み込み`);
  } else {
    const token = process.env.SMARTHR_ACCESS_TOKEN;
    if (token) {
      const smarthr = new SmartHRService({
        baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
        accessToken: token,
      });
      const allCrews = await smarthr.getAllCrews();
      const activeCrews = smarthr.filterActive(allCrews);

      for (const crew of activeCrews) {
        const entry = smarthr.toStaffMasterEntry(crew);
        if (entry.staffName && entry.qualifications.length > 0) {
          staffQualMap.set(normalize(entry.staffName), entry.qualifications);
          if (entry.staffNumber) {
            staffQualMap.set(entry.staffNumber, entry.qualifications);
          }
        }
      }
      console.log(`SmartHR 資格: ${staffQualMap.size} 名`);
    } else {
      console.warn('SMARTHR_ACCESS_TOKEN 未設定かつ --qualifications= 未指定。資格検証をスキップします。');
    }
  }

  const mismatches: MismatchRecord[] = [];
  const noQualCount = { count: 0, staff: new Set<string>() };

  for (const record of medicalRecords) {
    const key = normalize(record.staffName) || record.employeeNo;
    const quals = staffQualMap.get(normalize(record.staffName)) || staffQualMap.get(record.employeeNo) || [];

    if (quals.length === 0) {
      noQualCount.count++;
      noQualCount.staff.add(record.staffName || '(空)');
      continue;
    }

    const category = getQualCategory(quals);
    const mismatch = verifyRecord(record, category);
    if (mismatch) mismatches.push(mismatch);
  }

  // 結果出力
  console.log('\n--- 検証結果 ---');
  console.log(`不一致: ${mismatches.length} 件`);
  console.log(`資格不明（スキップ）: ${noQualCount.count} 件`);

  if (noQualCount.staff.size > 0) {
    console.log(`  対象スタッフ: ${[...noQualCount.staff].join(', ')}`);
  }

  if (mismatches.length > 0) {
    console.log('\n--- 不一致詳細 ---');
    for (const m of mismatches) {
      console.log(`  [${m.record.csvRow}] ${m.record.visitDate} ${m.record.startTime} | ${m.record.patientName} | ${m.record.staffName}`);
      console.log(`    サービス内容: ${m.record.serviceContent}`);
      console.log(`    問題: ${m.issue}`);
    }

    // レポートファイル出力
    const reportPath = path.join(
      process.cwd(),
      `service-content-verification-${new Date().toISOString().slice(0, 10)}.txt`
    );
    const lines: string[] = [
      `サービス内容資格検証レポート ${new Date().toISOString()}`,
      `CSV: ${csvPath}`,
      `不一致: ${mismatches.length} 件`,
      '',
      '--- 不一致一覧 ---',
      ...mismatches.map(m =>
        [
          `[${m.record.csvRow}] ${m.record.visitDate} ${m.record.startTime}-${m.record.endTime}`,
          `  患者: ${m.record.patientName} | スタッフ: ${m.record.staffName}`,
          `  サービス内容: ${m.record.serviceContent}`,
          `  問題: ${m.issue}`,
        ].join('\n')
      ),
    ];
    fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
    console.log(`\nレポート保存: ${reportPath}`);
  } else {
    console.log('\n✓ 資格不一致はありません。');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
