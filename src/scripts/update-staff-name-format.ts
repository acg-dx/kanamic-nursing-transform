/**
 * C2: E列を「資格-姓名」形式にバッチ更新
 *
 * SmartHR の資格データを使い、各スタッフ名に資格プレフィックスを付与する。
 * 冪等性あり: 既にプレフィックス付きの場合はスキップ。
 *
 * 使用方法:
 *   npx tsx src/scripts/update-staff-name-format.ts --dry-run              # 全事業所 dry-run
 *   npx tsx src/scripts/update-staff-name-format.ts                        # 全事業所 実行
 *   npx tsx src/scripts/update-staff-name-format.ts --location=姶良        # 指定事業所のみ
 *   npx tsx src/scripts/update-staff-name-format.ts --tab=2026年02月       # 指定タブのみ
 */

import dotenv from 'dotenv';
dotenv.config();

import { google, sheets_v4 } from 'googleapis';
import { SmartHRService } from '../services/smarthr.service';
import { extractPlainName } from '../core/cjk-normalize';

/** 全事業所のSheet ID */
const ALL_LOCATIONS = [
  { name: '谷山', sheetId: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8' },
  { name: '荒田', sheetId: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4' },
  { name: '博多', sheetId: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg' },
  { name: '姶良', sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M' },
];

const MONTH_TAB_PATTERN = /^\d{4}年\d{2}月$/;

// Column indices (0-based)
const COL_D = 3; // staffNumber (emp_code)
const COL_E = 4; // staffName

/**
 * 資格の優先度に基づいてプレフィックスを決定
 * 看護師 > 准看護師 > 理学療法士等（理学/作業/言語）
 */
function resolveQualificationPrefix(qualifications: string[]): string {
  if (qualifications.some(q => q === '看護師')) return '看護師-';
  if (qualifications.some(q => q === '准看護師')) return '准看護師-';
  if (qualifications.some(q => q.includes('理学療法士'))) return '理学療法士等-';
  if (qualifications.some(q => q.includes('作業療法士'))) return '理学療法士等-';
  if (qualifications.some(q => q.includes('言語聴覚士'))) return '理学療法士等-';
  return ''; // 資格不明 → プレフィックスなし
}

async function processLocation(
  sheets: sheets_v4.Sheets,
  smarthr: SmartHRService,
  locationName: string,
  spreadsheetId: string,
  tabArg: string | undefined,
  dryRun: boolean,
) {
  console.log(`\n========== ${locationName} (${spreadsheetId.slice(0, 8)}...) ==========`);

  // 対象タブの取得
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });
  const allSheets = spreadsheet.data.sheets || [];
  const monthTabs = allSheets
    .filter(s => s.properties?.title && MONTH_TAB_PATTERN.test(s.properties.title))
    .map(s => s.properties!.title!);

  const targetTabs = tabArg ? [tabArg] : monthTabs;
  console.log(`対象タブ: ${targetTabs.join(', ')}`);

  for (const tab of targetTabs) {
    console.log(`\n--- ${tab} ---`);

    // Sheet データ読み込み (D列=emp_code, E列=staffName)
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tab}'!A2:Z`,
    });
    const rows = res.data.values || [];
    console.log(`データ行: ${rows.length}`);

    if (rows.length === 0) {
      console.log('[SKIP] データなし');
      continue;
    }

    // ユニークな emp_code を収集
    const empCodes = [...new Set(
      rows.map(r => r[COL_D] || '').filter(Boolean)
    )];
    console.log(`ユニークスタッフ: ${empCodes.length}名`);

    // SmartHR から資格取得
    const crewMap = await smarthr.getCrewsByEmpCodes(empCodes);
    console.log(`SmartHR マッチ: ${crewMap.size}/${empCodes.length}名`);

    // emp_code → qualification prefix マップ構築
    const qualPrefixMap = new Map<string, string>();
    for (const [empCode, crew] of crewMap) {
      const entry = smarthr.toStaffMasterEntry(crew);
      const prefix = resolveQualificationPrefix(entry.qualifications);
      if (prefix) {
        qualPrefixMap.set(empCode, prefix);
        console.log(`  ${empCode} ${entry.staffName}: ${entry.qualifications.join(',')} → ${prefix}`);
      } else {
        console.log(`  ${empCode} ${entry.staffName}: 資格なし → スキップ`);
      }
    }

    // 更新データの構築
    const updateData: Array<{ range: string; values: string[][] }> = [];
    let skippedAlready = 0;
    let skippedNoQual = 0;
    let skippedNoEmpCode = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const empCode = row[COL_D] || '';
      const currentName = row[COL_E] || '';
      const rowIndex = i + 2; // 1-indexed, row 1 is header

      if (!empCode) {
        skippedNoEmpCode++;
        continue;
      }

      // 既にプレフィックス付きならスキップ (冪等性)
      if (currentName !== extractPlainName(currentName)) {
        skippedAlready++;
        continue;
      }

      const prefix = qualPrefixMap.get(empCode);
      if (!prefix) {
        skippedNoQual++;
        continue;
      }

      const newName = `${prefix}${currentName}`;
      updateData.push({
        range: `'${tab}'!E${rowIndex}`,
        values: [[newName]],
      });
    }

    console.log(`\n更新対象: ${updateData.length}行`);
    console.log(`スキップ（既にフォーマット済み）: ${skippedAlready}行`);
    console.log(`スキップ（資格なし）: ${skippedNoQual}行`);
    console.log(`スキップ（emp_codeなし）: ${skippedNoEmpCode}行`);

    // プレビュー (最初の10件)
    if (updateData.length > 0) {
      console.log('\nプレビュー:');
      for (const item of updateData.slice(0, 10)) {
        console.log(`  ${item.range}: → ${item.values[0][0]}`);
      }
      if (updateData.length > 10) {
        console.log(`  ... 他 ${updateData.length - 10} 件`);
      }
    }

    if (dryRun) {
      console.log('\n[DRY-RUN] 実際の更新はスキップされました');
      continue;
    }

    if (updateData.length === 0) {
      console.log('[SKIP] 更新対象なし');
      continue;
    }

    // バッチ更新 (Google Sheets API の batchUpdate は最大100,000セル)
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updateData,
      },
    });

    console.log(`[DONE] ${updateData.length}行のE列を更新しました`);
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const tabArg = process.argv.find(a => a.startsWith('--tab='))?.split('=')[1];
  const locationArg = process.argv.find(a => a.startsWith('--location='))?.split('=')[1];

  // === SmartHR 初期化 ===
  const smarthrToken = process.env.SMARTHR_ACCESS_TOKEN;
  if (!smarthrToken) {
    console.error('SMARTHR_ACCESS_TOKEN が必要です');
    process.exit(1);
  }

  const smarthr = new SmartHRService({
    baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
    accessToken: smarthrToken,
  });

  // === Google Sheets 初期化 ===
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH!,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const targets = locationArg
    ? ALL_LOCATIONS.filter(l => l.name === locationArg)
    : ALL_LOCATIONS;

  if (targets.length === 0) {
    console.error(`事業所 "${locationArg}" が見つかりません。選択肢: ${ALL_LOCATIONS.map(l => l.name).join(', ')}`);
    process.exit(1);
  }

  console.log(`対象事業所: ${targets.map(l => l.name).join(', ')}`);

  for (const loc of targets) {
    await processLocation(sheets, smarthr, loc.name, loc.sheetId, tabArg, dryRun);
  }

  console.log('\n完了。');
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
