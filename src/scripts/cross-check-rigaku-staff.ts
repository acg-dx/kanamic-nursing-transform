/**
 * 理学療法士等スタッフの交差検証スクリプト
 *
 * - E列のプレフィックスから理学療法士等スタッフを検出
 * - SmartHRから全理学療法士/作業療法士/言語聴覚士の資格保有者を取得
 * - 両者を交差比較し、漏れや不一致を検出
 *
 * Usage: npx tsx src/scripts/cross-check-rigaku-staff.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';
import { SmartHRService } from '../services/smarthr.service';

const AIRA_SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';

async function main() {
  // === 1. Google Sheet E列分析 ===
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH!,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  for (const tab of ['2026年02月', '2026年03月']) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${tab}`);
    console.log('='.repeat(60));

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: AIRA_SHEET_ID,
      range: `'${tab}'!A2:Z`,
    });
    const rows = res.data.values || [];

    // E列 prefix → unique staff names
    const staffByPrefix = new Map<string, Set<string>>();
    for (const r of rows) {
      const e = (r[4] || '').trim();
      if (!e) continue;
      const dashIdx = e.indexOf('-');
      let prefix = '(no prefix)';
      let name = e;
      if (dashIdx > 0) {
        prefix = e.substring(0, dashIdx);
        name = e.substring(dashIdx + 1);
      }
      if (!staffByPrefix.has(prefix)) staffByPrefix.set(prefix, new Set());
      staffByPrefix.get(prefix)!.add(name);
    }

    console.log('\n--- E列 prefix distribution ---');
    for (const [prefix, names] of [...staffByPrefix.entries()].sort()) {
      console.log(`  ${prefix}: ${names.size}名 → ${[...names].sort().join(', ')}`);
    }
  }

  // === 2. SmartHR: 全理学療法士等 ===
  const smarthrToken = process.env.SMARTHR_ACCESS_TOKEN;
  if (!smarthrToken) {
    console.log('\n⚠️ SMARTHR_ACCESS_TOKEN not set — skipping SmartHR check');
    return;
  }

  const smarthr = new SmartHRService({
    baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
    accessToken: smarthrToken,
  });

  const allCrews = await smarthr.getAllCrews();
  const activeCrews = smarthr.filterActive(allCrews);
  console.log(`\nSmartHR active staff total: ${activeCrews.length}`);

  const rigakuFromSmartHR: Array<{ name: string; quals: string[]; empCode: string; dept: string }> = [];
  for (const crew of activeCrews) {
    const quals = smarthr.getQualifications(crew);
    const hasRigaku = quals.some(q =>
      q.includes('理学療法士') || q.includes('作業療法士') || q.includes('言語聴覚士')
    );
    if (hasRigaku) {
      const bname = crew.business_last_name && crew.business_first_name
        ? `${crew.business_last_name}${crew.business_first_name}`
        : `${crew.last_name}${crew.first_name}`;
      rigakuFromSmartHR.push({
        name: bname,
        quals,
        empCode: crew.emp_code || '?',
        dept: smarthr.getDepartmentName(crew),
      });
    }
  }

  console.log(`\n--- SmartHR 全理学療法士等 staff (${rigakuFromSmartHR.length}名) ---`);
  for (const s of rigakuFromSmartHR.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${s.name} (${s.empCode}) [${s.quals.join(', ')}] dept=${s.dept}`);
  }

  // === 3. Check: also have kangoshi/junkangoshi? ===
  console.log('\n--- 理学療法士等 + 看護師/准看護師 兼有者 ---');
  for (const s of rigakuFromSmartHR) {
    const hasKango = s.quals.some(q => q === '看護師' || q === '正看護師');
    const hasJunKango = s.quals.some(q => q === '准看護師');
    if (hasKango || hasJunKango) {
      const note = hasKango ? '→ 看護師優先 (searchKbn=1)' : '→ 准看護師優先 (searchKbn=2)';
      console.log(`  ⚠️ ${s.name}: [${s.quals.join(', ')}] ${note}`);
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
