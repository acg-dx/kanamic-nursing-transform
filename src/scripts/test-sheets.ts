/**
 * Google Sheets API 接続テスト（姶良シート）
 * 実行: npx tsx src/scripts/test-sheets.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { SpreadsheetService } from '../services/spreadsheet.service';

const AIRA_SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M';

async function main() {
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json';
  console.log(`=== Google Sheets API 接続テスト ===`);
  console.log(`Service Account Key: ${keyPath}`);
  console.log(`Sheet ID: ${AIRA_SHEET_ID}\n`);

  const sheets = new SpreadsheetService(keyPath);

  // 1. 転記レコードを取得
  console.log('1. 転記レコード取得中...');
  try {
    const records = await sheets.getTranscriptionRecords(AIRA_SHEET_ID);
    console.log(`   → 取得完了: ${records.length}件\n`);

    if (records.length === 0) {
      console.log('   レコードが0件です。タブ名を確認してください。');
      console.log('   現在のタブ名: ' + getCurrentMonthTab());
      return;
    }

    // 2. ステータス別の集計
    const statusMap = new Map<string, number>();
    for (const r of records) {
      const flag = r.transcriptionFlag || '（空白）';
      statusMap.set(flag, (statusMap.get(flag) || 0) + 1);
    }
    console.log('2. 転記フラグ別集計:');
    for (const [status, count] of [...statusMap.entries()].sort()) {
      console.log(`   - ${status}: ${count}件`);
    }
    console.log();

    // 3. 未転記（転記対象）のサンプル表示
    const targets = records.filter(r => {
      if (r.recordLocked) return false;
      if (r.transcriptionFlag === '転記済み') return false;
      if (r.transcriptionFlag === '') return true;
      if (r.transcriptionFlag === 'エラー：システム') return true;
      return false;
    });
    console.log(`3. 転記対象レコード: ${targets.length}件`);
    for (const r of targets.slice(0, 10)) {
      console.log(`   [Row ${r.rowIndex}] ID:${r.recordId} | ${r.patientName} | ${r.visitDate} ${r.startTime}-${r.endTime} | ${r.serviceType1}/${r.serviceType2} | スタッフ:${r.staffName} | 緊急:${r.emergencyFlag} | 同行:${r.accompanyCheck} | 複数名:${r.multipleVisit}`);
    }
    if (targets.length > 10) console.log(`   ... 他${targets.length - 10}件`);
    console.log();

    // 4. 全レコードの最初5件の詳細表示
    console.log('4. 全レコード最初5件の詳細:');
    for (const r of records.slice(0, 5)) {
      console.log(`   --- Row ${r.rowIndex} ---`);
      console.log(`   A:レコードID      = ${r.recordId}`);
      console.log(`   B:タイムスタンプ    = ${r.timestamp}`);
      console.log(`   C:更新日時         = ${r.updatedAt}`);
      console.log(`   D:従業員番号       = ${r.staffNumber}`);
      console.log(`   E:記録者           = ${r.staffName}`);
      console.log(`   F:あおぞらID       = ${r.aozoraId}`);
      console.log(`   G:利用者           = ${r.patientName}`);
      console.log(`   H:日付             = ${r.visitDate}`);
      console.log(`   I:開始時刻         = ${r.startTime}`);
      console.log(`   J:終了時刻         = ${r.endTime}`);
      console.log(`   K:支援区分1        = ${r.serviceType1}`);
      console.log(`   L:支援区分2        = ${r.serviceType2}`);
      console.log(`   M:完了ステータス    = ${r.completionStatus}`);
      console.log(`   N:同行チェック      = ${r.accompanyCheck}`);
      console.log(`   O:緊急時フラグ      = ${r.emergencyFlag}`);
      console.log(`   P:同行事務員        = ${r.accompanyClerkCheck}`);
      console.log(`   Q:複数名訪問(二)    = ${r.multipleVisit}`);
      console.log(`   R:緊急時事務員      = ${r.emergencyClerkCheck}`);
      console.log(`   S:転記フラグ        = ${r.transcriptionFlag}`);
      console.log(`   T:マスタ修正フラグ   = ${r.masterCorrectionFlag}`);
      console.log(`   U:エラー詳細        = ${r.errorDetail}`);
      console.log(`   V:データ取得日時     = ${r.dataFetchedAt}`);
      console.log(`   W:提供票チェック     = ${r.serviceTicketCheck}`);
      console.log(`   X:備考              = ${r.notes}`);
      console.log(`   Y:実績ロック         = ${r.recordLocked}`);
      console.log();
    }

    // 5. サービス種類の集計
    const serviceTypes = new Map<string, number>();
    for (const r of records) {
      const key = `${r.serviceType1}/${r.serviceType2}`;
      serviceTypes.set(key, (serviceTypes.get(key) || 0) + 1);
    }
    console.log('5. サービス種類別集計:');
    for (const [type, count] of [...serviceTypes.entries()].sort()) {
      console.log(`   - ${type}: ${count}件`);
    }

  } catch (err) {
    console.error('エラー:', err);
    process.exit(1);
  }

  console.log('\n=== テスト完了 ===');
}

function getCurrentMonthTab(): string {
  const now = new Date();
  return `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月`;
}

main().catch(err => {
  console.error('Sheets テストエラー:', err);
  process.exit(1);
});
