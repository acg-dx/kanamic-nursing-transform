/**
 * SmartHR API 接続テスト
 * 実行: npx tsx src/scripts/test-smarthr.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { SmartHRService } from '../services/smarthr.service';

async function main() {
  const service = new SmartHRService({
    baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
    accessToken: process.env.SMARTHR_ACCESS_TOKEN || '',
  });

  console.log('=== SmartHR API 接続テスト ===\n');

  // 1. 全従業員を取得
  console.log('1. 全従業員を取得中...');
  const allCrews = await service.getAllCrews();
  console.log(`   → 取得完了: ${allCrews.length}名\n`);

  // 2. 在職者のみフィルタ
  const activeCrews = service.filterActive(allCrews);
  console.log(`2. 在職者: ${activeCrews.length}名 / 退職者: ${allCrews.length - activeCrews.length}名\n`);

  // 3. 部署情報のサンプル表示
  console.log('3. 部署一覧（在職者の所属部署）:');
  const deptSet = new Set<string>();
  for (const crew of activeCrews) {
    const dept = service.getDepartmentName(crew);
    if (dept) deptSet.add(dept);
  }
  for (const dept of [...deptSet].sort()) {
    const count = activeCrews.filter(c => service.getDepartmentName(c) === dept).length;
    console.log(`   - ${dept}: ${count}名`);
  }
  console.log();

  // 4. 姶良関連のスタッフを検索
  console.log('4. 「姶良」に所属するスタッフ:');
  const airaCrews = service.filterByDepartment(activeCrews, '姶良');
  if (airaCrews.length === 0) {
    // 部署名に「姶良」がない場合、「あおぞら」で再検索
    console.log('   → 「姶良」で見つからないため「あおぞら」で検索...');
    const aozoraCrews = service.filterByDepartment(activeCrews, 'あおぞら');
    for (const crew of aozoraCrews.slice(0, 20)) {
      const entry = service.toStaffMasterEntry(crew);
      const deptPath = service.getDepartmentFullPath(crew);
      console.log(`   [${entry.staffNumber}] ${entry.staffName} (${entry.staffNameYomi}) | 部署: ${deptPath.join(' > ')} | 資格: ${entry.qualifications.join(', ') || 'なし'}`);
    }
    if (aozoraCrews.length > 20) console.log(`   ... 他${aozoraCrews.length - 20}名`);
  } else {
    for (const crew of airaCrews) {
      const entry = service.toStaffMasterEntry(crew);
      const deptPath = service.getDepartmentFullPath(crew);
      console.log(`   [${entry.staffNumber}] ${entry.staffName} (${entry.staffNameYomi}) | 部署: ${deptPath.join(' > ')} | 資格: ${entry.qualifications.join(', ') || 'なし'}`);
    }
  }
  console.log();

  // 5. 最初の5名の詳細を表示（カスタムフィールド確認）
  console.log('5. 最初5名の詳細（カスタムフィールド確認）:');
  for (const crew of activeCrews.slice(0, 5)) {
    const entry = service.toStaffMasterEntry(crew);
    console.log(`   [${entry.staffNumber}] ${entry.staffName}`);
    console.log(`     法的氏名: ${entry.staffNameLegal}`);
    console.log(`     フリガナ: ${entry.staffNameYomi}`);
    console.log(`     部署: ${entry.departmentName}`);
    console.log(`     入社日: ${entry.enteredAt || 'なし'}`);
    console.log(`     資格: ${entry.qualifications.length > 0 ? entry.qualifications.join(', ') : 'なし'}`);
    // raw custom_fields のサンプル表示
    if (crew.custom_fields && crew.custom_fields.length > 0) {
      console.log(`     カスタムフィールド数: ${crew.custom_fields.length}`);
      // 資格フィールドの生データ確認
      const qualFields = crew.custom_fields.filter(cf =>
        cf.template?.id && cf.value
      ).slice(0, 3);
      for (const f of qualFields) {
        console.log(`       - template_id: ${f.template.id}, value: ${f.value}`);
      }
    }
    console.log();
  }

  console.log('=== テスト完了 ===');
}

main().catch(err => {
  console.error('SmartHR テストエラー:', err);
  process.exit(1);
});
