/**
 * 分析准看護師记录，找出哪些staff出现在准记录中
 * 以及リハビリ（訪看Ⅰ５）的时间分段模式
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
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) { result.push(current); current = ''; } else { current += ch; }
  }
  result.push(current);
  return result;
}

const rows = lines.slice(1).filter(l => l.trim()).map(l => parseCsvLine(l));

console.log('=== 准看護師 RECORDS (サービス内容 contains 准) ===');
for (const r of rows) {
  if ((r[12] || '').includes('准')) {
    console.log(`  Patient: ${r[4]} | Date: ${r[0]} ${r[2]}-${r[3]} | Staff: ${r[7]} | Content: ${r[12]} | Type: ${r[11]} | Result: ${r[16]}`);
  }
}

// Build set of staff who appear with 准
const junStaff = new Set<string>();
for (const r of rows) {
  if ((r[12] || '').includes('准') && r[7]) {
    junStaff.add(r[7].trim());
  }
}
console.log(`\n准看護師 staff: ${[...junStaff].join(', ')}`);

// Find records where these staff appear WITHOUT 准
console.log('\n=== SAME STAFF in NON-准 medical records ===');
for (const r of rows) {
  const staff = (r[7] || '').trim();
  if (!junStaff.has(staff)) continue;
  if ((r[12] || '').includes('准')) continue;
  if (!(r[11] || '').includes('医療')) continue;
  console.log(`  Patient: ${r[4]} | Date: ${r[0]} ${r[2]}-${r[3]} | Staff: ${staff} | Content: ${r[12]} | Type: ${r[11]}`);
}

// リハビリ analysis: 訪看Ⅰ５ / 予訪看Ⅰ５ records
console.log('\n=== リハビリ (訪看Ⅰ５/予訪看Ⅰ５) SEGMENT ANALYSIS ===');
const rehabRecords = rows.filter(r => {
  const sc = (r[12] || '');
  return sc.includes('訪看Ⅰ５') || sc.includes('予訪看Ⅰ５');
});
console.log(`Total リハビリ segments: ${rehabRecords.length}`);

// Group by patient + date + staff
const rehabGroups = new Map<string, Array<{start: string; end: string; content: string; visitStart: string; visitEnd: string; result: string}>>();
for (const r of rehabRecords) {
  const key = `${(r[4]||'').trim()}|${r[0]}|${(r[7]||'').trim()}`;
  if (!rehabGroups.has(key)) rehabGroups.set(key, []);
  rehabGroups.get(key)!.push({
    start: r[2], end: r[3], content: r[12],
    visitStart: r[9], visitEnd: r[10], result: r[16]
  });
}

console.log(`Grouped into ${rehabGroups.size} patient/date/staff combinations`);
console.log('\nSample groups (first 15):');
let count = 0;
for (const [key, segs] of rehabGroups) {
  if (count >= 15) break;
  const sorted = segs.sort((a, b) => a.start.localeCompare(b.start));
  const [name, date, staff] = key.split('|');
  const totalMin = sorted.length * 20;
  console.log(`  ${name} | ${date} | ${staff} | ${totalMin}min | segments:`);
  for (const s of sorted) {
    console.log(`    ${s.start}-${s.end} (visit: ${s.visitStart}-${s.visitEnd}) [result:${s.result}] ${s.content}`);
  }
  count++;
}

// Show distribution of segment counts per group
const segCountDist = new Map<number, number>();
for (const [, segs] of rehabGroups) {
  const c = segs.length;
  segCountDist.set(c, (segCountDist.get(c) || 0) + 1);
}
console.log('\nSegment count distribution:');
for (const [c, n] of [...segCountDist].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${c} segments (${c*20}min): ${n} groups`);
}
