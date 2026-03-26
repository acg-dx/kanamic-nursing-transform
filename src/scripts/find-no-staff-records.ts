/**
 * CSV上でスタッフ未配置のレコードをGoogleシートと突合し、
 * 転記済みなのにstaff未配置の問題レコードを特定する
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { google } from 'googleapis';
import fs from 'fs';
import iconv from 'iconv-lite';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';

function norm(s: string) { return s.normalize('NFKC').replace(/[\s\u3000]+/g, ''); }
function normDate(d: string) { return d.replace(/\//g, '-').trim(); }
function normTime(t: string) {
  const m = t.match(/(\d{1,2}):(\d{2})/);
  return m ? m[1].padStart(2, '0') + ':' + m[2] : t.trim();
}

interface NoStaffCsv {
  date: string; start: string; end: string;
  patient: string; content: string; csvFile: string;
}

function findNoStaffInCsv(csvFile: string): NoStaffCsv[] {
  const buf = fs.readFileSync(csvFile);
  const text = iconv.decode(buf, 'Shift_JIS');
  const lines = text.split('\n');
  const results: NoStaffCsv[] = [];

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
    if (['青空', '練習', 'テスト'].some(t => patient.includes(t))) continue;
    const start = (cols[2] || '').trim();
    const end = (cols[3] || '').trim();
    if (start === end) continue;
    const content = (cols[12] || '').trim();
    if (['緊急時訪問看護加算', '特別管理加算', '超減算', '月超', '初回加算'].some(k => content.includes(k))) continue;

    const staff = (cols[7] || '').trim();
    const empCode = (cols[8] || '').trim();

    if (!staff || !empCode) {
      results.push({
        date: (cols[0] || '').trim(),
        start, end,
        patient: patient.replace(/[\s\u3000]+/g, ''),
        content, csvFile,
      });
    }
  }
  return results;
}

async function main() {
  // Find no-staff records in both CSVs
  const noStaffAll = [
    ...findNoStaffInCsv('zuixin.csv'),
    ...findNoStaffInCsv('03.csv'),
  ];

  console.log(`CSV上スタッフ未配置レコード（実患者）: ${noStaffAll.length}件\n`);

  // Read sheet and cross-reference
  const auth = new google.auth.GoogleAuth({ keyFile: KEY_PATH, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const api = google.sheets({ version: 'v4', auth });

  const tabs = ['2026年02月', '2026年03月'];
  const results: string[] = [];

  for (const tab of tabs) {
    const res = await api.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${tab}'!A2:V` });
    const rows = res.data.values || [];

    for (const nsr of noStaffAll) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const rid = (r[0] || '').trim();
        if (!rid) continue;
        const pt = norm((r[6] || ''));
        const dt = normDate((r[7] || ''));
        const st = normTime((r[8] || ''));
        const flag = (r[19] || '').trim();

        if (pt.includes(norm(nsr.patient)) && dt === normDate(nsr.date) && st === normTime(nsr.start)) {
          const staff = (r[4] || '').trim();
          const s1 = (r[10] || '').trim();
          const s2 = (r[11] || '').trim();
          const errCol = (r[21] || '').trim();
          const line = `${tab} Row${i + 2} | ID=${rid} | ${nsr.date} ${nsr.start} | ${nsr.patient} | ${staff} | ${s1}/${s2} | flag=${flag || '(empty)'}${errCol ? ' | err=' + errCol : ''} | CSV=${nsr.content}`;
          results.push(line);
        }
      }
    }
  }

  console.log(`=== Sheet突合結果: ${results.length}件 ===`);
  if (results.length === 0) {
    console.log('シートに該当レコードなし（転記対象外の可能性）');
  } else {
    for (const line of results) {
      console.log(line);
    }
  }

  // Summary: how many are 転記済み
  const tenkiZumi = results.filter(r => r.includes('flag=転記済み'));
  console.log(`\nうち転記済み: ${tenkiZumi.length}件 ← これらが問題レコード`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
