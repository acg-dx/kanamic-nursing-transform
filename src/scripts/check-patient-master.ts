/**
 * 患者マスタに特定患者が存在するか確認
 */
import dotenv from 'dotenv';
dotenv.config();

import { PatientMasterService } from '../services/patient-master.service';

const NAMES = ['西之園喜美子', '谷本久子', '横山宜子', '上枝眞由美', '八汐征男', '鎌田良弘', '小濱泉', '宇都ノブ子', '藤﨑公強', '田中穂純', '八木陽子'];

async function main() {
  const master = new PatientMasterService();
  await master.loadFromCsv('./4664590280_userallfull_202602.csv');
  console.log(`患者マスタ: ${master.count}名`);

  for (const name of NAMES) {
    const found = master.findByName(name);
    if (found.length > 0) {
      console.log(`✅ ${name}: ${JSON.stringify(found.map(p => ({ name: p.name, aozoraId: p.aozoraId, careLevel: p.careLevel })))}`);
    } else {
      console.log(`❌ ${name}: NOT FOUND in patient master`);
    }
  }

  // List all patients
  console.log('\n=== 全患者一覧 ===');
  const all = (master as any).entries as any[];
  for (const p of all) {
    console.log(`  ${p.name} | aozoraId=${p.aozoraId} | careLevel=${p.careLevel}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
