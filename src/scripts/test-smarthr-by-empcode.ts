/**
 * Sheet内スタッフのSmartHR詳細情報取得
 * 実行: npx tsx src/scripts/test-smarthr-by-empcode.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { SpreadsheetService } from '../services/spreadsheet.service';

const BASE_URL = process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1';
const TOKEN = process.env.SMARTHR_ACCESS_TOKEN || '';
const AIRA_SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

const QUAL_FIELD_IDS = [
  '21289acb-d3f2-4ed7-84aa-5c42d0096c0d', // 資格1
  '14fe29ec-d0ef-4895-8121-901bd49b892e', // 資格2
  '773fbe7d-3457-4dc6-b702-5f0448432632', // 資格3
  'e8be0014-51a3-4125-8506-80915529f9fa', // 資格4
  '3fa29e52-367d-4908-88a1-86a68a999a21', // 資格5
  '1631fb4c-93dd-4453-a74c-fd16d8e2edc3', // 資格6
  '4bc6b84d-45e1-498e-bc5f-1302b3b3f5d0', // 資格7
  '356e88dc-5bef-46f0-af3e-7ea34e83ded3', // 資格8
];

async function main() {
  console.log('=== Sheet内スタッフのSmartHR詳細 ===\n');

  // 1. Sheetからユニークスタッフを抽出
  const sheets = new SpreadsheetService(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json');
  const records = await sheets.getTranscriptionRecords(AIRA_SHEET_ID);

  const staffMap = new Map<string, string>(); // empCode → name
  for (const r of records) {
    if (r.staffNumber && r.staffName) {
      staffMap.set(r.staffNumber, r.staffName);
    }
  }
  console.log(`Sheet内ユニークスタッフ: ${staffMap.size}名`);
  for (const [code, name] of staffMap) {
    console.log(`  [${code}] ${name}`);
  }
  console.log();

  // 2. 各スタッフをSmartHR APIで検索
  console.log('SmartHR API詳細情報:');
  for (const [empCode, sheetName] of staffMap) {
    try {
      const res = await fetch(`${BASE_URL}/crews?emp_code=${empCode}`, { headers });
      if (!res.ok) {
        console.log(`  [${empCode}] ${sheetName}: APIエラー ${res.status}`);
        continue;
      }
      const crews = await res.json() as Array<Record<string, unknown>>;
      if (crews.length === 0) {
        console.log(`  [${empCode}] ${sheetName}: SmartHRに見つからない`);
        continue;
      }
      const crew = crews[0];
      const name = `${crew.last_name || ''} ${crew.first_name || ''}`.trim();
      const yomi = `${crew.last_name_yomi || ''} ${crew.first_name_yomi || ''}`.trim();
      const bizName = crew.business_last_name && crew.business_first_name
        ? `${crew.business_last_name} ${crew.business_first_name}`
        : '';
      const resignedAt = crew.resigned_at as string || '';

      // 資格抽出
      const quals: string[] = [];
      const customFields = crew.custom_fields as Array<{
        custom_field_template_id: string;
        value: string | null;
        template?: { elements?: Array<{ physical_name: string; name: string }> };
      }> || [];

      for (const fid of QUAL_FIELD_IDS) {
        const f = customFields.find(cf => cf.custom_field_template_id === fid);
        if (f?.value) {
          if (f.template?.elements) {
            const opt = f.template.elements.find(e => e.physical_name === f.value);
            quals.push(opt?.name || f.value);
          } else {
            quals.push(f.value);
          }
        }
      }

      // 部署
      const depts = (crew.departments || []) as Array<{name: string | null; full_name?: string}>;
      const deptNames = depts.map(d => d?.name || '(no name)').join(', ');

      console.log(`  [${empCode}] ${name} | ヨミ: ${yomi} | ビジネスネーム: ${bizName || 'なし'}`);
      console.log(`    部署: ${deptNames || 'なし'} | 退職: ${resignedAt || '在職中'}`);
      console.log(`    資格: ${quals.length > 0 ? quals.join(', ') : 'なし'}`);

      // カスタムフィールドの生データ確認（最初のスタッフのみ）
      if (empCode === [...staffMap.keys()][0]) {
        console.log(`    --- カスタムフィールド生データ (${customFields.length}件) ---`);
        for (const cf of customFields.slice(0, 10)) {
          const hasTemplate = cf.template?.elements ? `elements: ${cf.template.elements.length}個` : 'template無し';
          console.log(`      tid: ${cf.custom_field_template_id.substring(0, 8)}... | val: ${cf.value || 'null'} | ${hasTemplate}`);
        }
      }
      console.log();
    } catch (err) {
      console.log(`  [${empCode}] ${sheetName}: エラー ${(err as Error).message}`);
    }
  }

  console.log('=== 完了 ===');
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
