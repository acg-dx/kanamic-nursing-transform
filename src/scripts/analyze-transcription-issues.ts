/**
 * 転記済みレコードの問題分析スクリプト
 *
 * 姶良の全月次タブを走査し、看護医療（医療/精神医療）の転記済みレコードを
 * 修正後のロジックと比較して、誤転記の可能性があるレコードを特定する。
 *
 * 検出カテゴリ:
 *   A) searchKbn 誤り — 理学療法士等が看護師searchKbnで転記された
 *   B) 精神医療が医療として転記された（textPattern 区別なし問題）
 *   C) urgentflags 誤設定 — R列=加算対象外 なのに urgentflags が ON だった可能性
 *   D) checkbox 未設定 — pluralnurseflag1/2, flag2 が設定されていなかった
 *   E) isTranscriptionTarget 漏れ — 本来転記すべきだったが skipされた（未転記で残っている）
 *
 * Usage: npx tsx src/scripts/analyze-transcription-issues.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const AIRA = { name: '姶良', sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M' };

// C1 挿入後の列レイアウト (A-Z, 26列)
const COL = {
  A: 0,   // レコードID
  B: 1,   // タイムスタンプ
  C: 2,   // 更新日時
  D: 3,   // 従業員番号
  E: 4,   // 記録者 (資格-姓名)
  F: 5,   // あおぞらID
  G: 6,   // 利用者
  H: 7,   // 日付
  I: 8,   // 開始時刻
  J: 9,   // 終了時刻
  K: 10,  // 支援区分1
  L: 11,  // 支援区分2
  M: 12,  // 完了ステータス
  N: 13,  // 同行チェック
  O: 14,  // 緊急フラグ
  P: 15,  // 同行事務員チェック
  Q: 16,  // 複数名訪問(二)
  R: 17,  // 緊急時事務員チェック
  S: 18,  // 加算対象の理由
  T: 19,  // 転記フラグ
  U: 20,  // マスタ修正フラグ
  V: 21,  // エラー詳細
  W: 22,  // データ取得日時
} as const;

const MONTH_TAB_PATTERN = /^\d{4}年\d{2}月$/;

function isTruthy(val: string | undefined | null): boolean {
  if (!val) return false;
  const v = val.trim().toLowerCase();
  return v !== '' && v !== 'false' && v !== '0' && v !== 'いいえ';
}

/** E列から資格を抽出 (e.g. "理学療法士等-山田太郎" → "理学療法士等") */
function extractQualification(staffName: string): string {
  const idx = staffName.indexOf('-');
  return idx >= 0 ? staffName.substring(0, idx) : '';
}

interface RecordRow {
  row: number;
  recordId: string;
  staff: string;
  qualification: string;
  patient: string;
  date: string;
  startTime: string;
  endTime: string;
  st1: string;       // K: 支援区分1
  st2: string;       // L: 支援区分2
  completionStatus: string;  // M
  accompanyCheck: string;    // N
  emergencyFlag: string;     // O
  pCol: string;       // P: 同行事務員チェック
  qCol: string;       // Q: 複数名訪問(二)
  rCol: string;       // R: 緊急時事務員チェック
  flag: string;       // T: 転記フラグ
}

interface Issue {
  category: string;
  description: string;
  record: RecordRow;
  tab: string;
}

/**
 * 修正後ロジックで isTranscriptionTarget を判定（転記フラグは無視）
 * 転記対象外 (= スキップすべき) → false
 */
function shouldBeTranscribed(r: RecordRow): boolean {
  // 完了ステータスチェック
  if (r.completionStatus === '' || r.completionStatus === '1') return false;

  // N列「重複」かつ P列が空欄
  if (r.accompanyCheck.includes('重複') && !r.pCol.trim()) return false;
  // O列「緊急支援あり」かつ R列が空欄
  if (r.emergencyFlag.includes('緊急支援あり') && !r.rCol.trim()) return false;

  const pCol = r.pCol.trim();
  const qTruthy = isTruthy(r.qCol);

  // P列「同行者」→ 全スキップ
  if (pCol === '同行者') return false;

  // 医療+通常+複数人(副)+Q=true → スキップ
  if (r.st1 === '医療' && r.st2 === '通常' && pCol === '複数人(副)' && qTruthy) return false;

  // 医療+リハビリ+P≠空欄 → 全スキップ
  if (r.st1 === '医療' && r.st2 === 'リハビリ' && pCol !== '') return false;

  // 精神医療+リハビリ+複数人系+Q=false → スキップ
  if (r.st1 === '精神医療' && r.st2 === 'リハビリ') {
    if (['複数人(主)', '複数人(副)', '複数人(看護+介護)'].includes(pCol) && !qTruthy) return false;
  }

  return true;
}

/**
 * 旧ロジックで isTranscriptionTarget を判定（修正前の動作をシミュレート）
 * Bug: 複数人(副)+Q=true のスキップが serviceType1/2 関係なく全適用されていた
 */
function wasTranscribedByOldLogic(r: RecordRow): boolean {
  if (r.completionStatus === '' || r.completionStatus === '1') return false;
  if (r.accompanyCheck.includes('重複') && !r.pCol.trim()) return false;
  if (r.emergencyFlag.includes('緊急支援あり') && !r.rCol.trim()) return false;

  const pCol = r.pCol.trim();
  const qTruthy = isTruthy(r.qCol);

  if (pCol === '同行者') return false;

  // 旧ロジック: serviceType を問わず全体でスキップ（これが bug）
  if (pCol === '複数人(副)' && qTruthy) return false;

  // 旧ロジック: 医療リハビリの P≠空欄 skip なし（これが GAP-A2）
  // 旧ロジック: 精神リハビリの 複数人+Q=false skip なし（これが GAP-A3）

  return true;
}

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
    .map(s => s.properties!.title!)
    .sort();

  console.log(`事業所: ${AIRA.name}`);
  console.log(`月次タブ: ${monthTabs.join(', ')}\n`);

  const allIssues: Issue[] = [];
  let totalMedical = 0;
  let totalTranscribed = 0;

  for (const tab of monthTabs) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: AIRA.sheetId,
      range: `'${tab}'!A2:Z`,
    });
    const rows = res.data.values || [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const st1 = (raw[COL.K] || '').trim();

      // 介護はスキップ（修正対象外）
      if (st1 === '介護') continue;
      // 医療/精神医療のみ対象
      if (st1 !== '医療' && st1 !== '精神医療') continue;

      totalMedical++;

      const rec: RecordRow = {
        row: i + 2,
        recordId: raw[COL.A] || '',
        staff: raw[COL.E] || '',
        qualification: extractQualification(raw[COL.E] || ''),
        patient: raw[COL.G] || '',
        date: raw[COL.H] || '',
        startTime: raw[COL.I] || '',
        endTime: raw[COL.J] || '',
        st1,
        st2: (raw[COL.L] || '').trim(),
        completionStatus: (raw[COL.M] || '').trim(),
        accompanyCheck: raw[COL.N] || '',
        emergencyFlag: raw[COL.O] || '',
        pCol: raw[COL.P] || '',
        qCol: raw[COL.Q] || '',
        rCol: raw[COL.R] || '',
        flag: (raw[COL.T] || '').trim(),
      };

      const isTranscribed = rec.flag === '転記済み';
      if (isTranscribed) totalTranscribed++;

      // ===== 分析 =====

      // --- カテゴリ A: searchKbn 誤り ---
      // 理学療法士等 + 医療/精神 + 転記済み → 以前は searchKbn=1(看護師) で転記された
      if (isTranscribed && rec.qualification === '理学療法士等') {
        allIssues.push({
          category: 'A-searchKbn',
          description: 'searchKbn=看護師 で転記（正: 理学療法士等）',
          record: rec,
          tab,
        });
      }

      // --- カテゴリ B: 精神医療が医療として転記された ---
      // 精神医療 + 転記済み → textPattern が区別されず医療のサービスが選択された可能性
      if (isTranscribed && rec.st1 === '精神医療') {
        allIssues.push({
          category: 'B-seishin-as-iryo',
          description: '精神医療 → textPattern 区別なし（医療サービスが選択された可能性）',
          record: rec,
          tab,
        });
      }

      // --- カテゴリ C: urgentflags 誤設定 ---
      // 緊急 + R列=加算対象外 or 空欄 + 転記済み → urgentflags が不正に ON だった
      if (isTranscribed && rec.st2 === '緊急') {
        const rVal = (rec.rCol || '').trim();
        if (rVal !== '加算対象') {
          allIssues.push({
            category: 'C-urgentflags',
            description: `R列="${rVal || '空欄'}" で urgentflags 不正 ON（正: OFF）`,
            record: rec,
            tab,
          });
        }
      }

      // --- カテゴリ D: checkbox 未設定 ---
      if (isTranscribed) {
        const pCol = rec.pCol.trim();
        const qTruthy = isTruthy(rec.qCol);

        // flag2 (緊急) — 精神+緊急+加算対象 のみ必要
        if (rec.st1 === '精神医療' && rec.st2 === '緊急' && rec.rCol.trim() === '加算対象') {
          allIssues.push({
            category: 'D-flag2-missing',
            description: '精神+緊急+加算対象 → flag2(緊急) 未設定だった',
            record: rec,
            tab,
          });
        }

        // pluralnurseflag1 (複数名訪問) — 通常+複数人系+Q=false
        if (rec.st2 === '通常' && ['複数人(主)', '複数人(副)', '複数人(看護+介護)'].includes(pCol) && !qTruthy) {
          allIssues.push({
            category: 'D-pluralnurseflag1-missing',
            description: '通常+複数人+Q=false → pluralnurseflag1 未設定だった',
            record: rec,
            tab,
          });
        }

        // pluralnurseflag2 (複数名訪問(二)) — (支援者/複数人(主)/看護+介護)+Q=true
        if (['支援者', '複数人(主)', '複数人(看護+介護)'].includes(pCol) && qTruthy) {
          allIssues.push({
            category: 'D-pluralnurseflag2-missing',
            description: `${pCol}+Q=true → pluralnurseflag2 未設定だった`,
            record: rec,
            tab,
          });
        }
      }

      // --- カテゴリ E: isTranscriptionTarget 漏れ ---
      // 修正後ロジックでは転記対象だが、旧ロジックではスキップされていた
      if (!isTranscribed && rec.flag !== 'エラー：システム' && rec.flag !== 'エラー：マスタ不備') {
        const shouldBe = shouldBeTranscribed(rec);
        const wasBefore = wasTranscribedByOldLogic(rec);

        if (shouldBe && !wasBefore) {
          allIssues.push({
            category: 'E-skipped-by-old-logic',
            description: '旧ロジックでスキップされたが、新ロジックでは転記対象',
            record: rec,
            tab,
          });
        }
      }
    }
  }

  // ===== レポート出力 =====
  console.log('='.repeat(80));
  console.log('転記問題分析レポート');
  console.log('='.repeat(80));
  console.log(`医療/精神医療 全レコード: ${totalMedical}`);
  console.log(`うち転記済み: ${totalTranscribed}`);
  console.log(`検出された問題: ${allIssues.length}`);
  console.log();

  // カテゴリ別サマリ
  const categories = [...new Set(allIssues.map(i => i.category))].sort();
  for (const cat of categories) {
    const items = allIssues.filter(i => i.category === cat);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[${cat}] ${items.length}件`);
    console.log(`${'─'.repeat(60)}`);

    // タブ別集計
    const tabCounts = new Map<string, number>();
    for (const it of items) {
      tabCounts.set(it.tab, (tabCounts.get(it.tab) || 0) + 1);
    }
    for (const [t, c] of tabCounts) {
      console.log(`  ${t}: ${c}件`);
    }

    // 詳細（最大20件表示）
    const showItems = items.slice(0, 20);
    for (const it of showItems) {
      const r = it.record;
      console.log(`  Row ${r.row} [${it.tab}] | ID=${r.recordId} | ${r.date} ${r.startTime}-${r.endTime} | ${r.patient} | ${r.qualification}-${r.staff.split('-')[1] || ''} | ${r.st1}/${r.st2} | P=${r.pCol || '空欄'} Q=${r.qCol || '空欄'} R=${r.rCol || '空欄'} | ${it.description}`);
    }
    if (items.length > 20) {
      console.log(`  ... 他 ${items.length - 20}件`);
    }
  }

  // ===== 要修正レコード（重複排除） =====
  // 同一レコードに複数カテゴリの問題がある場合、1回修正で済む
  const uniqueRecords = new Map<string, { record: RecordRow; tab: string; categories: string[] }>();
  for (const issue of allIssues) {
    const key = `${issue.tab}:${issue.record.row}`;
    const existing = uniqueRecords.get(key);
    if (existing) {
      existing.categories.push(issue.category);
    } else {
      uniqueRecords.set(key, { record: issue.record, tab: issue.tab, categories: [issue.category] });
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`要修正レコード（重複排除）: ${uniqueRecords.size}件`);
  console.log(`${'='.repeat(80)}`);

  // タブ別集計
  const tabSummary = new Map<string, number>();
  for (const [, v] of uniqueRecords) {
    tabSummary.set(v.tab, (tabSummary.get(v.tab) || 0) + 1);
  }
  for (const [t, c] of [...tabSummary].sort()) {
    console.log(`  ${t}: ${c}件`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
