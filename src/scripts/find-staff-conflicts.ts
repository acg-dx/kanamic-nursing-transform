/**
 * 指定スタッフの指定日付の全レコードを Google Sheet から取得し、
 * 時間帯の重複を分析する
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { google } from 'googleapis';

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
const TAB = '2026年02月';

const targets = [
  { staff: '井上由美', date: '2026-02-19', time: '16:00', patient: '亀田孝', id: '121625' },
  { staff: '粟田敬子', date: '2026-02-22', time: '13:00', patient: '山岸雄二', id: '121723' },
];

function normDate(d: string) { return d.replace(/\//g, '-').trim(); }

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A2:V`,
  });
  const rows = res.data.values || [];

  for (const t of targets) {
    console.log(`\n=== ${t.staff} @ ${t.date} (target: ${t.patient} ${t.time}, ID=${t.id}) ===`);

    // Find ALL records for this staff on this date
    console.log(`\n[同一スタッフ ${t.staff} の ${t.date} 全レコード]`);
    let staffFound = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const staffName = (r[4] || '').trim();
      const date = normDate((r[7] || '').trim());
      if (date !== t.date) continue;
      if (!staffName.includes(t.staff.substring(0, 3))) continue;
      staffFound++;
      const rid = (r[0] || '').trim();
      const patient = (r[6] || '').trim();
      const start = (r[8] || '').trim();
      const end = (r[9] || '').trim();
      const st1 = (r[10] || '').trim();
      const st2 = (r[11] || '').trim();
      const flag = (r[19] || '').trim();
      const err = (r[21] || '').trim();
      console.log(`  Row${i + 2} ID=${rid} | ${start}-${end} | ${patient} | ${staffName} | ${st1}/${st2} | flag=${flag || '(empty)'}${err ? ' | err=' + err : ''}`);
    }
    if (staffFound === 0) console.log('  (no records)');

    // Find ALL records for target patient on this date (any staff)
    console.log(`\n[同一患者 ${t.patient} の ${t.date} 全レコード]`);
    let patientFound = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const patient = (r[6] || '').replace(/[\s\u3000]+/g, '').trim();
      const date = normDate((r[7] || '').trim());
      if (date !== t.date) continue;
      if (!patient.includes(t.patient.substring(0, 2))) continue;
      patientFound++;
      const rid = (r[0] || '').trim();
      const staffName = (r[4] || '').trim();
      const start = (r[8] || '').trim();
      const end = (r[9] || '').trim();
      const st1 = (r[10] || '').trim();
      const st2 = (r[11] || '').trim();
      const flag = (r[19] || '').trim();
      console.log(`  Row${i + 2} ID=${rid} | ${start}-${end} | ${patient} | ${staffName} | ${st1}/${st2} | flag=${flag || '(empty)'}`);
    }
    if (patientFound === 0) console.log('  (no records)');

    // Check: what overlapping time window could have caused conflict
    // Find ALL staff records on this date whose time overlaps with t.time
    const targetHour = parseInt(t.time.split(':')[0]);
    const targetMin = parseInt(t.time.split(':')[1]);
    console.log(`\n[${t.date} ${t.time} 時間帯に重複する全レコード (同スタッフ)]`);
    let overlapFound = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const staffName = (r[4] || '').trim();
      const date = normDate((r[7] || '').trim());
      if (date !== t.date) continue;
      if (!staffName.includes(t.staff.substring(0, 3))) continue;

      const start = (r[8] || '').trim();
      const end = (r[9] || '').trim();
      const sMatch = start.match(/(\d{1,2}):(\d{2})/);
      const eMatch = end.match(/(\d{1,2}):(\d{2})/);
      if (!sMatch || !eMatch) continue;
      const sMin = parseInt(sMatch[1]) * 60 + parseInt(sMatch[2]);
      const eMin = parseInt(eMatch[1]) * 60 + parseInt(eMatch[2]);
      const tMin = targetHour * 60 + targetMin;

      // Overlap: target start falls within [sMin, eMin) or record starts within target's hour
      if ((tMin >= sMin && tMin < eMin) || (sMin >= tMin && sMin < tMin + 60)) {
        overlapFound++;
        const rid = (r[0] || '').trim();
        const patient = (r[6] || '').trim();
        const flag = (r[19] || '').trim();
        console.log(`  ★ Row${i + 2} ID=${rid} | ${start}-${end} | ${patient} | ${staffName} | flag=${flag || '(empty)'}`);
      }
    }
    if (overlapFound === 0) console.log('  (no overlapping records found in sheet)');
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
