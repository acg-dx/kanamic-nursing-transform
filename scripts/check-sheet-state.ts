import { google } from 'googleapis';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

const SHEET_ID = '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M'; // 姶良
const CURRENT_MONTH_TAB = '2026年02月';
const DELETION_TAB = '削除';

// Column indices (0-based) AFTER C1 insertion
const COL_A = 0;
const COL_M = 12;
const COL_T = 19; // 転記フラグ (after C1 insertion)

async function main() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    console.log('📊 Checking sheet state for 姶良...\n');

    // ===== 1. Check 2026年02月 tab =====
    console.log(`📋 Fetching ${CURRENT_MONTH_TAB} tab...`);
    const transcriptionResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${CURRENT_MONTH_TAB}!A2:Z`,
    });

    const transcriptionRows = transcriptionResponse.data.values || [];
    console.log(`   Total rows: ${transcriptionRows.length}`);

    // Count pending transcription records
    // Pending = 転記フラグ (T=19) is empty, 'エラー：システム', 'エラー：マスタ不備', or '修正あり'
    const pendingTranscriptionRecords = transcriptionRows.filter((row) => {
      const transcriptionFlag = row[COL_T] || '';
      const isPending =
        transcriptionFlag === '' ||
        transcriptionFlag === 'エラー：システム' ||
        transcriptionFlag === 'エラー：マスタ不備' ||
        transcriptionFlag === '修正あり';
      return isPending;
    });

    console.log(`   ✓ Pending transcription records: ${pendingTranscriptionRecords.length}`);

    // Show breakdown
    const emptyCount = transcriptionRows.filter((row) => (row[COL_T] || '') === '').length;
    const systemErrorCount = transcriptionRows.filter((row) => (row[COL_T] || '') === 'エラー：システム').length;
    const masterErrorCount = transcriptionRows.filter((row) => (row[COL_T] || '') === 'エラー：マスタ不備').length;
    const correctionCount = transcriptionRows.filter((row) => (row[COL_T] || '') === '修正あり').length;

    console.log(`     - Empty: ${emptyCount}`);
    console.log(`     - エラー：システム: ${systemErrorCount}`);
    console.log(`     - エラー：マスタ不備: ${masterErrorCount}`);
    console.log(`     - 修正あり: ${correctionCount}`);

    // ===== 2. Check 削除 tab =====
    console.log(`\n📋 Fetching ${DELETION_TAB} tab...`);
    const deletionResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${DELETION_TAB}!A2:M`,
    });

    const deletionRows = deletionResponse.data.values || [];
    console.log(`   Total rows: ${deletionRows.length}`);

    // Count pending deletion records
    // Pending = M列 (12) is NOT '削除済み' and NOT '削除不要'
    const pendingDeletionRecords = deletionRows.filter((row) => {
      const status = row[COL_M] || '';
      const isPending = status !== '削除済み' && status !== '削除不要';
      return isPending;
    });

    console.log(`   ✓ Pending deletion records: ${pendingDeletionRecords.length}`);

    // Show breakdown
    const deletedCount = deletionRows.filter((row) => (row[COL_M] || '') === '削除済み').length;
    const notNeededCount = deletionRows.filter((row) => (row[COL_M] || '') === '削除不要').length;
    const pendingCount = pendingDeletionRecords.length;

    console.log(`     - 削除済み: ${deletedCount}`);
    console.log(`     - 削除不要: ${notNeededCount}`);
    console.log(`     - Pending (other): ${pendingCount}`);

    // ===== 3. Save evidence =====
    const evidenceDir = '.sisyphus/evidence';
    if (!fs.existsSync(evidenceDir)) {
      fs.mkdirSync(evidenceDir, { recursive: true });
    }

    const evidence = `
=== Sheet State Check for 姶良 ===
Date: ${new Date().toISOString()}

## 2026年02月 Tab
Total rows: ${transcriptionRows.length}
Pending transcription records: ${pendingTranscriptionRecords.length}
  - Empty: ${emptyCount}
  - エラー：システム: ${systemErrorCount}
  - エラー：マスタ不備: ${masterErrorCount}
  - 修正あり: ${correctionCount}

## 削除 Tab
Total rows: ${deletionRows.length}
Pending deletion records: ${pendingDeletionRecords.length}
  - 削除済み: ${deletedCount}
  - 削除不要: ${notNeededCount}
  - Pending (other): ${pendingCount}

## Summary
- Pending transcription: ${pendingTranscriptionRecords.length}
- Pending deletion: ${pendingDeletionRecords.length}
- Total pending: ${pendingTranscriptionRecords.length + pendingDeletionRecords.length}
`;

    fs.writeFileSync(path.join(evidenceDir, 'B0-status.txt'), evidence.trim());
    console.log(`\n✅ Evidence saved to .sisyphus/evidence/B0-status.txt`);

    // ===== 4. Summary =====
    console.log(`\n📊 SUMMARY`);
    console.log(`   Pending transcription: ${pendingTranscriptionRecords.length}`);
    console.log(`   Pending deletion: ${pendingDeletionRecords.length}`);
    console.log(`   Total pending: ${pendingTranscriptionRecords.length + pendingDeletionRecords.length}`);
  } catch (error) {
    console.error('❌ Error:', (error as Error).message);
    process.exit(1);
  }
}

main();
