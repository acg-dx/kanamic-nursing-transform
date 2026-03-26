/**
 * 员工资格确认脚本
 * 从SmartHR查询指定员工的資格1~8字段，确认实际资格
 */
import { SmartHRService } from '../services/smarthr.service';
import dotenv from 'dotenv';

dotenv.config();

const TARGET_STAFF = ['冨迫広美', '有村愛', '木場亜紗実'];

async function main() {
  const smarthr = new SmartHRService({
    baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
    accessToken: process.env.SMARTHR_ACCESS_TOKEN || '',
  });

  console.log('=== SmartHR 員工資格確認 ===\n');
  console.log('查询対象:', TARGET_STAFF.join(', '));
  console.log('');

  // 获取所有员工
  const allCrews = await smarthr.getAllCrews();
  console.log(`SmartHR 全員工数: ${allCrews.length}\n`);

  for (const name of TARGET_STAFF) {
    // 按名字搜索（去空格匹配）
    const normalizedTarget = name.replace(/[\s\u3000]+/g, '');
    const crew = allCrews.find(c => {
      const fullName = `${c.last_name}${c.first_name}`.replace(/[\s\u3000]+/g, '');
      const businessName = `${c.business_last_name || ''}${c.business_first_name || ''}`.replace(/[\s\u3000]+/g, '');
      return fullName === normalizedTarget || businessName === normalizedTarget;
    });

    if (!crew) {
      console.log(`❌ ${name}: SmartHRに見つかりません`);
      continue;
    }

    const qualifications = smarthr.getQualifications(crew);
    const shokuShu = smarthr.getCustomOptionFieldValue(crew, '職種');
    const yakushoku = smarthr.getCustomOptionFieldValue(crew, '役職_等級_');

    console.log(`--- ${name} ---`);
    console.log(`  emp_code: ${crew.emp_code}`);
    console.log(`  氏名: ${crew.last_name} ${crew.first_name}`);
    if (crew.business_last_name) {
      console.log(`  ビジネスネーム: ${crew.business_last_name} ${crew.business_first_name}`);
    }
    console.log(`  職種: ${shokuShu || '(未設定)'}`);
    console.log(`  役職: ${yakushoku || '(未設定)'}`);
    console.log(`  資格一覧 (${qualifications.length}件):`);
    if (qualifications.length === 0) {
      console.log(`    (なし)`);
    } else {
      for (let i = 0; i < qualifications.length; i++) {
        const isNurse = qualifications[i].includes('看護');
        console.log(`    資格${i + 1}: ${qualifications[i]}${isNurse ? ' ★' : ''}`);
      }
    }

    // 看護師/准看護師の判定
    const hasKangoshi = qualifications.some(q => q === '看護師' || q === '正看護師');
    const hasJunKangoshi = qualifications.some(q => q === '准看護師');
    if (hasKangoshi) {
      console.log(`  → 判定: 看護師 ✓`);
    } else if (hasJunKangoshi) {
      console.log(`  → 判定: 准看護師 ✓`);
    } else {
      console.log(`  → 判定: 看護資格なし（資格一覧に看護師/准看護師がありません）`);
    }
    console.log('');
  }

  // ボーナス: 全看護職スタッフの資格一覧
  console.log('=== 全「看護職」スタッフの資格概要 ===\n');
  const nurseCrews = allCrews.filter(c => {
    const shokuShu = smarthr.getCustomOptionFieldValue(c, '職種');
    return shokuShu && shokuShu.includes('看護');
  });

  for (const crew of nurseCrews) {
    const name = `${crew.last_name} ${crew.first_name}`;
    const qualifications = smarthr.getQualifications(crew);
    const hasKangoshi = qualifications.some(q => q === '看護師' || q === '正看護師');
    const hasJunKangoshi = qualifications.some(q => q === '准看護師');
    const resigned = crew.resigned_at ? ' [退職済]' : '';
    
    let status = '不明';
    if (hasKangoshi && hasJunKangoshi) status = '看護師+准看護師';
    else if (hasKangoshi) status = '看護師';
    else if (hasJunKangoshi) status = '准看護師';
    else status = `資格なし(${qualifications.join(',') || '空'})`;

    console.log(`  ${crew.emp_code || '---'} | ${name}${resigned} | ${status} | [${qualifications.join(', ')}]`);
  }
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
