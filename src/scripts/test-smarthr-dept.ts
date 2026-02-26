/**
 * SmartHR 部署一覧取得 + 姶良スタッフ取得
 * 実行: npx tsx src/scripts/test-smarthr-dept.ts
 */
import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1';
const TOKEN = process.env.SMARTHR_ACCESS_TOKEN || '';

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

async function main() {
  console.log('=== SmartHR 部署一覧 + 姶良スタッフ ===\n');

  // 1. 部署一覧を取得
  console.log('1. 部署一覧取得中...');
  let page = 1;
  const allDepts: Array<{id: string; name: string; full_name?: string}> = [];
  while (true) {
    const res = await fetch(`${BASE_URL}/departments?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`部署API: ${res.status}`);
    const depts = await res.json() as Array<{id: string; name: string; full_name?: string}>;
    if (depts.length === 0) break;
    allDepts.push(...depts);
    const total = res.headers.get('x-total-count');
    if (total && allDepts.length >= parseInt(total)) break;
    page++;
  }
  console.log(`   → ${allDepts.length} 部署を取得\n`);

  // 姶良関連の部署を表示
  const airaDepts = allDepts.filter(d => 
    (d.name && d.name.includes('姶良')) || 
    (d.full_name && d.full_name.includes('姶良'))
  );
  console.log('2. 姶良関連の部署:');
  for (const d of airaDepts) {
    console.log(`   ID: ${d.id} | 名前: ${d.name} | フルネーム: ${d.full_name || 'N/A'}`);
  }

  // あおぞら関連の部署も
  const aozoraDepts = allDepts.filter(d => 
    (d.name && d.name.includes('あおぞら')) || 
    (d.full_name && d.full_name.includes('あおぞら'))
  );
  console.log('\n3. あおぞら関連の部署:');
  for (const d of aozoraDepts) {
    console.log(`   ID: ${d.id} | 名前: ${d.name} | フルネーム: ${d.full_name || 'N/A'}`);
  }

  // 訪問看護関連
  const houkanDepts = allDepts.filter(d => 
    (d.name && d.name.includes('訪問看護')) || 
    (d.full_name && d.full_name.includes('訪問看護'))
  );
  console.log('\n4. 訪問看護関連の部署:');
  for (const d of houkanDepts) {
    console.log(`   ID: ${d.id} | 名前: ${d.name} | フルネーム: ${d.full_name || 'N/A'}`);
  }

  // 2. 姶良の部署IDでスタッフを検索
  const targetDeptIds = [...airaDepts, ...houkanDepts.filter(d => 
    d.name?.includes('姶良') || d.full_name?.includes('姶良')
  )].map(d => d.id);
  
  if (targetDeptIds.length > 0) {
    console.log(`\n5. 姶良部署のスタッフ取得 (dept_ids: ${targetDeptIds.join(',')})...`);
    for (const deptId of targetDeptIds) {
      const res = await fetch(`${BASE_URL}/crews?per_page=100&page=1&department=${deptId}`, { headers });
      if (!res.ok) { console.log(`   部署 ${deptId}: APIエラー ${res.status}`); continue; }
      const crews = await res.json() as Array<{emp_code: string; last_name: string; first_name: string; last_name_yomi: string; first_name_yomi: string; resigned_at?: string; custom_fields?: Array<{custom_field_template_id: string; value: string | null; template?: {elements?: Array<{physical_name: string; name: string}>}}> }>;
      const total = res.headers.get('x-total-count');
      const dept = allDepts.find(d => d.id === deptId);
      console.log(`\n   [${dept?.name || deptId}] ${total || crews.length}名`);
      const active = crews.filter(c => !c.resigned_at);
      for (const c of active.slice(0, 30)) {
        // 資格抽出
        const quals: string[] = [];
        const qualFieldIds = [
          '21289acb-d3f2-4ed7-84aa-5c42d0096c0d',
          '14fe29ec-d0ef-4895-8121-901bd49b892e',
          '773fbe7d-3457-4dc6-b702-5f0448432632',
          'e8be0014-51a3-4125-8506-80915529f9fa',
          '3fa29e52-367d-4908-88a1-86a68a999a21',
          '1631fb4c-93dd-4453-a74c-fd16d8e2edc3',
          '4bc6b84d-45e1-498e-bc5f-1302b3b3f5d0',
          '356e88dc-5bef-46f0-af3e-7ea34e83ded3',
        ];
        if (c.custom_fields) {
          for (const fid of qualFieldIds) {
            const f = c.custom_fields.find(cf => cf.custom_field_template_id === fid);
            if (f?.value && f.template?.elements) {
              const opt = f.template.elements.find(e => e.physical_name === f.value);
              if (opt) quals.push(opt.name);
            } else if (f?.value) {
              quals.push(f.value);
            }
          }
        }
        console.log(`     [${c.emp_code || '---'}] ${c.last_name}${c.first_name} (${c.last_name_yomi}${c.first_name_yomi}) | 資格: ${quals.join(', ') || 'なし'}`);
      }
    }
  } else {
    // 部署IDが見つからない場合、全スタッフから名前で検索
    console.log('\n5. 部署IDが見つからないため、Sheet記録のスタッフ名で直接検索...');
    const sheetStaffNames = ['冨迫広美', '荒垣久美子', '木場亜紗実'];
    for (const name of sheetStaffNames) {
      // SmartHR APIでは名前検索はlast_name + first_name
      const parts = name.split(/(?<=.)(?=.{1,3}$)/); // rough split
      console.log(`   検索: ${name}`);
    }
  }

  console.log('\n=== 完了 ===');
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
