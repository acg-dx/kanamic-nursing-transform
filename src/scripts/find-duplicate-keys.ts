/**
 * 重複キー検出スクリプト
 *
 * Google Sheet の「2026年02月」タブから全レコードを読み取り、
 * 同一 (患者名+日付+開始時刻) で複数レコードが存在するケースを検出する。
 *
 * このような重複キーは、突合・転記・削除ロジックで衝突を起こす可能性がある。
 *
 * Usage: npx tsx src/scripts/find-duplicate-keys.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = process.argv[2] || '2026年02月';

// Column indices (post-C1 insert)
const COL = {
  A: 0, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9,
  K: 10, L: 11, M: 12, T: 19
} as const;

function norm(s: string): string {
  return (s || '').normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '').trim();
}
function normTime(t: string): string {
  const m = (t || '').match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : (t || '').trim();
}

interface Rec {
  row: number;
  recordId: string;
  staffName: string;
  patientName: string;
  visitDate: string;
  startTime: string;
  endTime: string;
  st1: string;
  st2: string;
  flag: string;
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log(`=== 重複キー検出: ${TAB} ===\n`);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A2:Z`,
  });

  const rows = res.data.values || [];
  const records: Rec[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const recordId = (r[COL.A] || '').trim();
    if (!recordId) continue;

    const startTime = (r[COL.I] || '').trim();
    const endTime = (r[COL.J] || '').trim();
    // Skip start==end records (加算 etc.)
    if (startTime && endTime && normTime(startTime) === normTime(endTime)) continue;

    records.push({
      row: i + 2,
      recordId,
      staffName: (r[COL.E] || '').trim(),
      patientName: (r[COL.G] || '').trim(),
      visitDate: (r[COL.H] || '').trim(),
      startTime,
      endTime,
      st1: (r[COL.K] || '').trim(),
      st2: (r[COL.L] || '').trim(),
      flag: (r[COL.T] || '').trim(),
    });
  }

  console.log(`Total records (excluding start==end): ${records.length}\n`);

  // Group by (patient + date + startTime)
  const groups = new Map<string, Rec[]>();
  for (const rec of records) {
    const key = `${norm(rec.patientName)}|${rec.visitDate}|${normTime(rec.startTime)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(rec);
  }

  // Find duplicates
  const duplicates = [...groups.entries()]
    .filter(([, recs]) => recs.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));

  console.log(`Duplicate key groups: ${duplicates.length}\n`);

  if (duplicates.length === 0) {
    console.log('No duplicate keys found. All (patient+date+startTime) combinations are unique.');
    return;
  }

  console.log('='.repeat(120));
  for (const [key, recs] of duplicates) {
    console.log(`\n[KEY] ${key} — ${recs.length} records`);
    console.log('─'.repeat(100));
    for (const r of recs) {
      console.log(
        `  Row ${String(r.row).padStart(4)} | ID=${r.recordId.padEnd(7)} | ` +
        `${r.visitDate} ${r.startTime}-${r.endTime} | ` +
        `${r.patientName.padEnd(10)} | ${r.staffName.padEnd(20)} | ` +
        `${r.st1}/${r.st2} | flag="${r.flag}"`
      );
    }

    // Analyze impact
    const allTranscribed = recs.every(r => r.flag === '転記済み');
    const someTranscribed = recs.some(r => r.flag === '転記済み');
    const differentStaff = new Set(recs.map(r => r.staffName)).size > 1;
    const differentSt1 = new Set(recs.map(r => r.st1)).size > 1;

    const warnings: string[] = [];
    if (differentStaff) warnings.push('異なるスタッフ');
    if (differentSt1) warnings.push('異なる支援区分1');
    if (allTranscribed) warnings.push('全て転記済み→突合時にどちらか1件しか確認できない');
    if (someTranscribed && !allTranscribed) warnings.push('一部のみ転記済み→転記漏れの可能性');

    if (warnings.length > 0) {
      console.log(`  ⚠️  Impact: ${warnings.join(' | ')}`);
    }
  }

  console.log('\n' + '='.repeat(120));
  console.log(`\nSummary:`);
  console.log(`  Total duplicate groups: ${duplicates.length}`);
  console.log(`  Total affected records: ${duplicates.reduce((sum, [, r]) => sum + r.length, 0)}`);

  const highRisk = duplicates.filter(([, recs]) => {
    const staffs = new Set(recs.map(r => r.staffName));
    return staffs.size > 1 && recs.some(r => r.flag === '転記済み');
  });
  console.log(`  High risk (different staff + 転記済み): ${highRisk.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
