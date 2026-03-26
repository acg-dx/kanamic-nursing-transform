import fs from 'fs';
import iconv from 'iconv-lite';
import { SmartHRService } from '../services/smarthr.service';
import dotenv from 'dotenv';
dotenv.config();

const smarthr = new SmartHRService({
  baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
  accessToken: process.env.SMARTHR_ACCESS_TOKEN || '',
});

function normalize(s: string): string {
  return s.normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '').trim();
}

const TEST_PATIENTS = ['青空太郎', '練習七郎', 'テスト'];

async function main() {
  const buf = fs.readFileSync('./downloads/schedule_8-1_202602.csv');
  const text = iconv.decode(buf, 'Shift_JIS');
  const lines = text.split('\n');
  
  interface Rec { row: number; date: string; startTime: string; endTime: string; patient: string; staff: string; empCode: string; serviceContent: string; }
  const records: Rec[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols: string[] = []; let cur = '', inQ = false;
    for (const ch of line) { if (ch === '"') { inQ = !inQ; continue; } if (ch === ',' && !inQ) { cols.push(cur); cur = ''; continue; } cur += ch; }
    cols.push(cur);
    if (cols.length < 17) continue;
    const patient = normalize(cols[4] || '');
    const staff = (cols[7] || '').trim();
    if (!staff) continue;
    if (TEST_PATIENTS.some(t => patient.includes(t))) continue;
    if ((cols[2]||'').trim() === '12:00' && (cols[3]||'').trim() === '12:00') continue;
    const sc = (cols[12] || '').trim();
    if (sc.includes('訪看Ⅰ５') || sc.includes('予訪看Ⅰ５')) continue;
    records.push({ row: i+1, date: (cols[0]||'').trim(), startTime: (cols[2]||'').trim(), endTime: (cols[3]||'').trim(), patient: (cols[4]||'').trim(), staff, empCode: (cols[8]||'').trim(), serviceContent: sc });
  }
  
  const staffMap = new Map<string, { name: string; empCode: string; recs: Rec[] }>();
  for (const r of records) {
    const key = normalize(r.staff);
    if (!staffMap.has(key)) staffMap.set(key, { name: r.staff, empCode: r.empCode, recs: [] });
    staffMap.get(key)!.recs.push(r);
  }
  
  console.log(`CSV records (filtered): ${records.length}`);
  console.log(`Unique staff: ${staffMap.size}`);
  
  const allCrews = await smarthr.getAllCrews();
  console.log(`SmartHR crews: ${allCrews.length}\n`);
  
  const smarthrByName = new Map<string, typeof allCrews[0]>();
  for (const c of allCrews) {
    smarthrByName.set(normalize(`${c.last_name}${c.first_name}`), c);
    if (c.business_last_name) smarthrByName.set(normalize(`${c.business_last_name}${c.business_first_name||''}`), c);
  }
  
  let matched = 0; const unmatched: string[] = [];
  console.log('=== 看護師/准看護師 資格チェック ===\n');
  
  const results: { name: string; empCode: string; qual: string; withJun: number; withoutJun: number; mismatches: number; dir: string }[] = [];
  
  for (const [normName, info] of staffMap) {
    const crew = smarthrByName.get(normName);
    if (!crew) { unmatched.push(info.name); continue; }
    matched++;
    const quals = smarthr.getQualifications(crew);
    const hasK = quals.some(q => q === '看護師' || q === '正看護師');
    const hasJ = quals.some(q => q === '准看護師');
    if (!hasK && !hasJ) continue;
    
    const actual = hasJ ? '准看護師' : '看護師';
    const wJ = info.recs.filter(r => r.serviceContent.includes('准')).length;
    const woJ = info.recs.filter(r => !r.serviceContent.includes('准')).length;
    const mis = actual === '准看護師' ? woJ : wJ;
    const dir = mis > 0 ? (actual === '准看護師' ? '看護師→准看護師' : '准看護師→看護師') : '';
    
    results.push({ name: info.name, empCode: crew.emp_code || '', qual: actual, withJun: wJ, withoutJun: woJ, mismatches: mis, dir });
  }
  
  for (const r of results) {
    const s = r.mismatches > 0 ? `★要修正 ${r.dir} ${r.mismatches}件` : '✓OK';
    console.log(`  ${r.empCode.padEnd(6)} | ${r.name.padEnd(12)} | ${r.qual} | 准あり:${String(r.withJun).padStart(3)} | 准なし:${String(r.withoutJun).padStart(3)} | ${s}`);
  }
  
  console.log(`\nSmartHR照合: ${matched}/${staffMap.size} (未照合: ${unmatched.length})`);
  if (unmatched.length > 0) console.log(`  未照合: ${unmatched.join(', ')}`);
  
  const needsFix = results.filter(r => r.mismatches > 0);
  const toJun = needsFix.filter(r => r.dir.includes('→准')).reduce((s, r) => s + r.mismatches, 0);
  const toKan = needsFix.filter(r => r.dir.includes('→看護師')).reduce((s, r) => s + r.mismatches, 0);
  
  console.log(`\n=== サマリ ===`);
  console.log(`修正不要: ${results.length - needsFix.length}名`);
  console.log(`修正必要: ${needsFix.length}名`);
  for (const r of needsFix) console.log(`  ${r.name}: ${r.dir} ${r.mismatches}件`);
  console.log(`合計: 看護師→准看護師 ${toJun}件 + 准看護師→看護師 ${toKan}件 = ${toJun+toKan}件`);
}
main().catch(e => { console.error(e); process.exit(1); });
