/**
 * 理学療法士等の転記済みレコードを検出するスクリプト
 *
 * E列が「理学療法士等-」で始まるスタッフのレコードを検索し、
 * 医療+通常/緊急 の転記済みレコード（searchKbn誤りの可能性あり）を特定する。
 *
 * Usage: npx tsx src/scripts/check-rigaku-records.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const AIRA = { name: '姶良', sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M' };

// C1 挿入後の列レイアウト (A-Z, 26列)
// E(4)=記録者, K(10)=支援区分1, L(11)=支援区分2, T(19)=転記フラグ
const COL_A = 0;   // レコードID
const COL_E = 4;   // 記録者 (資格-姓名)
const COL_G = 6;   // 利用者
const COL_H = 7;   // 日付
const COL_I = 8;   // 開始時刻
const COL_J = 9;   // 終了時刻
const COL_K = 10;  // 支援区分1
const COL_L = 11;  // 支援区分2
const COL_P = 15;  // 同行事務員チェック
const COL_T = 19;  // 転記フラグ

const MONTH_TAB_PATTERN = /^\d{4}年\d{2}月$/;

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH!,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Get all month tabs
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: AIRA.sheetId,
    fields: 'sheets.properties',
  });
  const allSheets = spreadsheet.data.sheets || [];
  const monthTabs = allSheets
    .filter(s => s.properties?.title && MONTH_TAB_PATTERN.test(s.properties.title))
    .map(s => s.properties!.title!);

  console.log(`事業所: ${AIRA.name}`);
  console.log(`月次タブ: ${monthTabs.join(', ')}`);

  let totalRigaku = 0;
  let totalWrong = 0;

  for (const tab of monthTabs) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: AIRA.sheetId,
      range: `'${tab}'!A2:Z`,
    });
    const rows = res.data.values || [];

    // Find 理学療法士等 records
    const rigakuRows: Array<{
      row: number;
      recordId: string;
      staff: string;
      patient: string;
      date: string;
      startTime: string;
      endTime: string;
      svcType1: string;
      svcType2: string;
      pCol: string;
      flag: string;
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const staffName = r[COL_E] || '';
      if (!staffName.startsWith('理学療法士等-')) continue;

      rigakuRows.push({
        row: i + 2,
        recordId: r[COL_A] || '',
        staff: staffName,
        patient: r[COL_G] || '',
        date: r[COL_H] || '',
        startTime: r[COL_I] || '',
        endTime: r[COL_J] || '',
        svcType1: r[COL_K] || '',
        svcType2: r[COL_L] || '',
        pCol: r[COL_P] || '',
        flag: r[COL_T] || '',
      });
    }

    if (rigakuRows.length === 0) continue;

    console.log(`\n========== ${tab} (${rigakuRows.length} 理学療法士等 records) ==========`);
    totalRigaku += rigakuRows.length;

    // Group: ALL 医療+転記済み are potentially wrong (searchKbn should have been 3)
    const wrongIryo: typeof rigakuRows = [];
    const notTranscribed: typeof rigakuRows = [];
    const kaigo: typeof rigakuRows = [];

    for (const rec of rigakuRows) {
      if (rec.svcType1 !== '医療') {
        kaigo.push(rec);
        continue;
      }

      if (rec.flag !== '転記済み') {
        notTranscribed.push(rec);
        continue;
      }

      // 全ての医療+転記済み → HAM に（Ⅰ・Ⅱ）で登録されているが、正しくは（理学療法士等）
      wrongIryo.push(rec);
    }

    if (wrongIryo.length > 0) {
      console.log(`\n  ❌ 医療+転記済み（searchKbn 誤り）: ${wrongIryo.length}件`);
      console.log(`     → HAM: 訪問看護基本療養費（Ⅰ・Ⅱ）で登録 → 正: （Ⅰ・Ⅱ）（理学療法士等）`);
      for (const w of wrongIryo) {
        console.log(`     Row ${w.row} | ID=${w.recordId} | ${w.date} ${w.startTime}-${w.endTime} | ${w.patient} | ${w.staff.replace('理学療法士等-', '')} | ${w.svcType2} | P=${w.pCol}`);
      }
      totalWrong += wrongIryo.length;
    }

    if (notTranscribed.length > 0) {
      console.log(`\n  ⏳ 医療+未転記: ${notTranscribed.length}件`);
    }

    if (kaigo.length > 0) {
      console.log(`\n  ℹ️  介護レコード（別フロー）: ${kaigo.length}件`);
    }
  }

  console.log(`\n========== SUMMARY ==========`);
  console.log(`理学療法士等 全レコード: ${totalRigaku}`);
  console.log(`❌ 医療+転記済み（要修正）: ${totalWrong}`);
  console.log(`（HAM に searchKbn=1 で登録 → 正しくは searchKbn=3（理学療法士等）で再登録が必要）`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
