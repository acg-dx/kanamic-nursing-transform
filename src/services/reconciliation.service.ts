/**
 * 予実突合サービス
 *
 * HAM の 8-1 スケジュールデータ出力 CSV と Google Sheets の転記レコードを突合し、
 * 差異を検出する。
 *
 * 突合対象:
 *   1. Sheets で「転記済み」なのに HAM にない → 転記漏れ
 *   2. HAM にあるが Sheets にない → 手動追加 or 二重登録
 *   3. 資格不一致（准看護師が看護師として登録されている）
 *
 * フィルタリング:
 *   - テスト患者（青空太郎、練習七郎等）を除外
 *   - 12:00-12:00 の月次加算レコードを除外
 *   - リハビリ（訪看Ⅰ５/予訪看Ⅰ５）の 20 分セグメントを結合
 *
 * 准看護師検出:
 *   - サービス内容（col 12）に「准」を含むレコードからスタッフを自動識別
 *   - 識別された准看護師スタッフが「准」なしで登録されている場合にフラグ
 *
 * 使用タイミング:
 *   - 月次の転記完了後に突合を実施
 *   - 前月データの確認時
 */
import fs from 'fs';
import { logger } from '../core/logger';
import { normalizeCjkName, extractPlainName, resolveStaffAlias } from '../core/cjk-normalize';
import type { SpreadsheetService } from './spreadsheet.service';
import type { TranscriptionRecord } from '../types/spreadsheet.types';

// ─── 8-1 CSV パース用型 ───

/** 8-1 CSV の1行分のスケジュールデータ */
export interface ScheduleEntry {
  /** 利用者名 */
  patientName: string;
  /** 日付 (YYYY/MM/DD or YYYYMMDD 等) */
  visitDate: string;
  /** 開始時刻 (HH:MM) */
  startTime: string;
  /** 終了時刻 (HH:MM) */
  endTime: string;
  /** スタッフ名 */
  staffName: string;
  /** サービス種類（テキスト） — col 11 */
  serviceName: string;
  /** サービス内容（テキスト） — col 12 */
  serviceContent: string;
  /** 実績フラグ（"1" = 実績あり） */
  resultFlag: string;
  /** 元 CSV 行番号（デバッグ用） */
  csvRow: number;
}

// ─── 突合結果型 ───

export interface ReconciliationResult {
  /** Google Sheets の転記済みレコード数 */
  sheetsTotal: number;
  /** 8-1 CSV のレコード数（フィルタ・結合後） */
  hamTotal: number;
  /** マッチしたレコード数 */
  matched: number;
  /** Sheets にあるが HAM にないレコード */
  missingFromHam: ReconciliationMismatch[];
  /** HAM にあるが Sheets にないレコード */
  extraInHam: ReconciliationMismatch[];
  /** 資格不一致（准看護師 ↔ 看護師） */
  qualificationMismatches: QualificationMismatch[];
  /** 前月未登録レコード（オプション） */
  previousMonthPending?: PreviousMonthPendingResult;
}

export interface ReconciliationMismatch {
  patientName: string;
  visitDate: string;
  startTime: string;
  endTime: string;
  staffName: string;
  serviceType: string;
  source: 'sheets' | 'ham';
}

export interface QualificationMismatch {
  patientName: string;
  visitDate: string;
  startTime: string;
  staffName: string;
  sheetsServiceType: string;
  hamServiceType: string;
  issue: string;
}

export interface PreviousMonthPendingResult {
  hasPending: boolean;
  pendingCount: number;
  pendingRecords: Array<{
    recordId: string;
    patientName: string;
    visitDate: string;
    staffName: string;
    transcriptionFlag: string;
  }>;
}

// ─── 検証結果型 (Phase 1) ───

/** フィールド別不一致の詳細（D-06: 1レコード1オブジェクトに全mismatch集約） */
export interface VerificationMismatch {
  /** Sheets レコードの情報 */
  recordId: string;
  patientName: string;
  visitDate: string;
  startTime: string;
  endTime: string;
  staffName: string;
  sheetsServiceType: string;  // `${serviceType1}/${serviceType2}`

  /** REC-01: HAM に存在しない */
  missingFromHam: boolean;

  /** REC-02: 終了時刻の不一致（D-03: 完全一致、誤差許容なし） */
  timeMismatch?: {
    sheetsEndTime: string;
    hamEndTime: string;
  };

  /** REC-03: サービス種類/内容の不一致（D-04: 種類+コード両方比較） */
  serviceMismatch?: {
    sheetsServiceType1: string;
    sheetsServiceType2: string;
    hamServiceName: string;
    hamServiceContent: string;
    description: string;
  };

  /** REC-04: スタッフ配置の不一致（D-05: CJK正規化後の姓名+資格） */
  staffMismatch?: {
    sheetsStaffName: string;
    hamStaffName: string;
    qualificationIssue?: string;
  };
}

/** REC-05: HAM にあるが Sheets にないレコード */
export interface ExtraInHamRecord {
  patientName: string;
  visitDate: string;
  startTime: string;
  endTime: string;
  staffName: string;
  serviceName: string;
  serviceContent: string;
}

/** verify() の戻り値 */
export interface VerificationResult {
  /** Sheets 検証対象レコード数 */
  sheetsTotal: number;
  /** HAM CSV レコード数（フィルタ・リハビリ結合後） */
  hamTotal: number;
  /** 完全一致レコード数 */
  matched: number;
  /** フィールド別不一致あり（REC-01〜REC-04） */
  mismatches: VerificationMismatch[];
  /** HAM にあるが Sheets にない（REC-05） */
  extraInHam: ExtraInHamRecord[];
}

// ─── 検証ヘルパー (Phase 1) ───

/** 時刻正規化 (HH:MM or H:MM → HH:MM) */
function normalizeTimeForVerify(time: string): string {
  if (!time) return '';
  const m = time.match(/(\d{1,2}):(\d{2})/);
  if (!m) return '';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** HH:MM → 分数に変換 */
function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * 終了時刻の不一致チェック
 * HAM は終了時刻を -1 分で記録する（例: Sheets 08:30 → HAM 08:29）ため、
 * 1 分以内の差異は一致とみなす。
 * @returns 不一致がある場合は { sheetsEndTime, hamEndTime }、一致なら undefined
 */
export function checkTimeMismatch(
  sheetsEndTime: string,
  hamEndTime: string,
): { sheetsEndTime: string; hamEndTime: string } | undefined {
  const normSheets = normalizeTimeForVerify(sheetsEndTime);
  const normHam = normalizeTimeForVerify(hamEndTime);
  if (!normSheets || !normHam) return undefined;  // 片方がない場合はスキップ
  if (normSheets === normHam) return undefined;    // 完全一致
  const diff = Math.abs(timeToMinutes(normSheets) - timeToMinutes(normHam));
  if (diff <= 1) return undefined;                 // 1分以内の差異は許容（HAM -1分仕様）
  return { sheetsEndTime: normSheets, hamEndTime: normHam };
}

/**
 * サービス種類/内容の不一致チェック（D-04）
 * Adapted from run-full-reconciliation.ts checkServiceMismatch()
 * @returns 不一致がある場合は description 付きオブジェクト、一致なら undefined
 */
export function checkServiceMismatch(
  sheetsRecord: { serviceType1: string; serviceType2: string },
  hamEntry: { serviceName: string; serviceContent: string },
): { sheetsServiceType1: string; sheetsServiceType2: string; hamServiceName: string; hamServiceContent: string; description: string } | undefined {
  const st1 = sheetsRecord.serviceType1;
  const hamService = hamEntry.serviceContent;
  const hamType = hamEntry.serviceName;

  if (!hamService && !hamType) return undefined;

  const sheetsIsMedical = st1 === '医療' || st1 === '精神医療';
  const sheetsIsKaigo = st1 === '介護';
  const hamIsKaigoHoukanService = /訪看Ⅰ[１-５]|訪看Ⅱ[１-５]|予訪看|定期巡回|夜間対応/.test(hamService);
  const hamIsMedicalTherapy = hamService.includes('療養費') || hamService.includes('精神科') || hamService.includes('訪問看護基本療養費');

  // I5 rehab -- ambiguous insurance type, skip per D-08
  if (hamService.includes('Ⅰ５') || hamService.includes('I5')) return undefined;

  // Match cases
  if (sheetsIsKaigo && hamIsKaigoHoukanService) return undefined;
  if (sheetsIsMedical && hamIsMedicalTherapy) return undefined;

  // Cross-type mismatches
  if (sheetsIsMedical && hamIsKaigoHoukanService) {
    return {
      sheetsServiceType1: st1,
      sheetsServiceType2: sheetsRecord.serviceType2,
      hamServiceName: hamType,
      hamServiceContent: hamService,
      description: `保険種類不一致: Sheets=${st1} だが HAM は介護保険サービス (${hamService})`,
    };
  }
  if (sheetsIsKaigo && hamIsMedicalTherapy) {
    return {
      sheetsServiceType1: st1,
      sheetsServiceType2: sheetsRecord.serviceType2,
      hamServiceName: hamType,
      hamServiceContent: hamService,
      description: `保険種類不一致: Sheets=${st1} だが HAM は医療保険サービス (${hamService})`,
    };
  }

  return undefined;
}

/**
 * スタッフ配置の不一致チェック（D-05: CJK正規化後の姓名一致 + 資格）
 * @returns 不一致がある場合はオブジェクト、一致なら undefined
 */
export function checkStaffMismatch(
  sheetsStaffName: string,
  hamStaffName: string,
  hamServiceContent: string,
  staffQualifications: Map<string, string>,
): { sheetsStaffName: string; hamStaffName: string; qualificationIssue?: string } | undefined {
  // Sheets のスタッフ名は資格前缀付き（例: "准看護師-冨迫広美"）→ 除去 + エイリアス解決してから比較
  const normSheets = normalizeCjkName(resolveStaffAlias(extractPlainName(sheetsStaffName)));
  const normHam = normalizeCjkName(resolveStaffAlias(extractPlainName(hamStaffName)));

  // Name mismatch
  if (normSheets !== normHam) {
    return { sheetsStaffName, hamStaffName };
  }

  // Name matches -- check qualification (D-05)
  const actualQual = staffQualifications.get(normHam);
  if (actualQual) {
    const isJun = actualQual === '准看護師';
    const hasJun = hamServiceContent.includes('准');
    if ((isJun && !hasJun) || (!isJun && hasJun)) {
      return {
        sheetsStaffName,
        hamStaffName,
        qualificationIssue: `${hamStaffName} は ${actualQual} だが HAM サービス内容は「${hamServiceContent}」`,
      };
    }
  }

  return undefined;
}

// ─── フィルタリング設定 ───

/** テスト患者名に含まれるパターン */
const TEST_PATIENT_PATTERNS = ['青空', '練習', 'テスト'];

// ─── メインサービス ───

export class ReconciliationService {
  private sheets: SpreadsheetService;
  /** SmartHR 資格マップ: スタッフ名 → '看護師'|'准看護師'|'理学療法士等' */
  private staffQualifications: Map<string, string> = new Map();

  constructor(sheets: SpreadsheetService) {
    this.sheets = sheets;
  }

  /**
   * SmartHR から取得した資格マップを設定
   * スタッフ名（正規化済み）→ 実際の資格（看護師 > 准看護師 優先）
   */
  setStaffQualifications(map: Map<string, string>): void {
    this.staffQualifications = map;
  }

  /**
   * 8-1 CSV と Google Sheets の突合を実行
   *
   * @param csvPath 8-1 スケジュールデータ CSV パス
   * @param sheetId 転記用 Google Sheets ID
   * @param tab 月度タブ名 (e.g. "2026年03月")
   */
  async reconcile(
    csvPath: string,
    sheetId: string,
    tab?: string,
  ): Promise<ReconciliationResult> {
    // 8-1 CSV を読み込み
    const hamEntries = this.parseScheduleCsv(csvPath);
    logger.info(`8-1 CSV: ${hamEntries.length} 件読み込み`);

     // ── フィルタリング: テスト患者 + 月次加算レコード除外 ──
     const filteredEntries = hamEntries.filter(e => {
       // テスト患者を除外
       if (TEST_PATIENT_PATTERNS.some(p => e.patientName.includes(p))) return false;
       // 12:00-12:00 の月次加算レコードを除外（スタッフ未割当の加算行）
       if (e.startTime === '12:00' && e.endTime === '12:00') return false;
       // 超減算・月超レコードを除外（HAM 自動生成、正常なレコード）
       if (e.serviceContent.includes('超減算') || e.serviceContent.includes('月超')) return false;
       return true;
     });
    const filteredOut = hamEntries.length - filteredEntries.length;
    logger.info(`フィルタ後 HAM: ${filteredEntries.length} 件（テスト患者・加算除外: ${filteredOut} 件）`);

    // ── リハビリ 20 分セグメント結合 ──
    const mergedEntries = this.mergeRehabSegments(filteredEntries);
    logger.info(`リハビリ結合後: ${mergedEntries.length} 件`);

     // ── SmartHR 資格マップの確認 ──
     if (this.staffQualifications.size > 0) {
       logger.info(`SmartHR 資格マップ: ${this.staffQualifications.size} 名分の資格情報を使用`);
     } else {
       logger.warn(`SmartHR 資格マップが未設定です。CSV ベースの准看護師検出にフォールバック`);
     }

    // Google Sheets からレコード取得
    const sheetsRecords = await this.sheets.getTranscriptionRecords(sheetId, tab);
    // 転記済みレコードのみ突合対象
    const transcribedRecords = sheetsRecords.filter(r => r.transcriptionFlag === '転記済み');
    logger.info(`Sheets 転記済み: ${transcribedRecords.length}/${sheetsRecords.length} 件`);

    // 突合キーの作成（患者名正規化 + 日付 + 開始時刻）
    const hamMap = new Map<string, ScheduleEntry[]>();
    for (const entry of mergedEntries) {
      const key = this.makeMatchKey(entry.patientName, entry.visitDate, entry.startTime);
      const existing = hamMap.get(key) || [];
      existing.push(entry);
      hamMap.set(key, existing);
    }

    const sheetsMap = new Map<string, TranscriptionRecord[]>();
    for (const record of transcribedRecords) {
      const key = this.makeMatchKey(record.patientName, record.visitDate, record.startTime);
      const existing = sheetsMap.get(key) || [];
      existing.push(record);
      sheetsMap.set(key, existing);
    }

    let matched = 0;
    const missingFromHam: ReconciliationMismatch[] = [];
    const extraInHam: ReconciliationMismatch[] = [];
    const qualificationMismatches: QualificationMismatch[] = [];
    const matchedHamKeys = new Set<string>();

    // Sheets → HAM 方向: 転記済みが HAM にあるか
    for (const [key, records] of sheetsMap) {
      const hamRecords = hamMap.get(key);

      if (!hamRecords || hamRecords.length === 0) {
        for (const r of records) {
          missingFromHam.push({
            patientName: r.patientName,
            visitDate: r.visitDate,
            startTime: r.startTime,
            endTime: r.endTime,
            staffName: r.staffName,
            serviceType: `${r.serviceType1}/${r.serviceType2}`,
            source: 'sheets',
          });
        }
        continue;
      }

      matchedHamKeys.add(key);
      matched += records.length;

       // ── 資格チェック: SmartHR 資格マップを使用 ──
       for (const r of records) {
         if (r.serviceType1 !== '医療' && r.serviceType1 !== '精神医療') continue;

         for (const h of hamRecords) {
           const normStaff = this.normalizeNameForKey(h.staffName);
           // SmartHR 資格マップから実際の資格を取得
           const actualQual = this.staffQualifications.get(normStaff);
           if (!actualQual) continue; // SmartHR に登録されていないスタッフはスキップ

           // 実際の資格に基づいて期待されるサービス内容を判定
           const isJun = actualQual === '准看護師';
           const hasJun = h.serviceContent.includes('准');

           // 不一致: 准看護師なのに「准」がない、または 看護師なのに「准」がある
           if ((isJun && !hasJun) || (!isJun && hasJun)) {
             qualificationMismatches.push({
               patientName: r.patientName,
               visitDate: r.visitDate,
               startTime: r.startTime,
               staffName: h.staffName,
               sheetsServiceType: `${r.serviceType1}/${r.serviceType2}`,
               hamServiceType: h.serviceContent || h.serviceName,
               issue: `資格不一致: ${h.staffName} は ${actualQual} ですが、サービス内容は「${h.serviceContent}」`,
             });
           }
         }
       }
    }

    // HAM → Sheets 方向: HAM にあるが Sheets にない
    for (const [key, entries] of hamMap) {
      if (matchedHamKeys.has(key)) continue;
      for (const e of entries) {
        extraInHam.push({
          patientName: e.patientName,
          visitDate: e.visitDate,
          startTime: e.startTime,
          endTime: e.endTime,
          staffName: e.staffName,
          serviceType: e.serviceContent || e.serviceName,
          source: 'ham',
        });
      }
    }

    const result: ReconciliationResult = {
      sheetsTotal: transcribedRecords.length,
      hamTotal: mergedEntries.length,
      matched,
      missingFromHam,
      extraInHam,
      qualificationMismatches,
    };

    logger.info(
      `突合結果: マッチ=${matched}, Sheets→HAM欠落=${missingFromHam.length}, ` +
      `HAM余剰=${extraInHam.length}, 資格不一致=${qualificationMismatches.length}`
    );

    return result;
  }

  /**
   * 8-1 CSV と Sheets レコードのフィールドレベル検証を実行（Phase 1 検証コア）
   *
   * 既存の reconcile() が存在性+資格のみチェックするのに対し、
   * verify() は5つのフィールドレベルチェックを実行する。
   *
   * @param csvPath 8-1 スケジュールデータ CSV パス
   * @param sheetsRecords 検証対象の転記済みレコード（呼び出し元でフィルタ済み）
   * @param allRecords 全レコード（エラー含む）。HAM余剰判定に必須（全ステータスのキー別カウントで余剰を判定）
   * @returns フィールドレベル検証結果
   */
  async verify(
    csvPath: string,
    sheetsRecords: TranscriptionRecord[],
    allRecords: TranscriptionRecord[],
  ): Promise<VerificationResult> {
    // ── CSV パース + フィルタリング + リハビリ結合 + HAM重複排除 ──
    const mergedEntries = this.parseAndMergeScheduleCsv(csvPath);

    // ── HAM マップ構築 ──
    const hamMap = new Map<string, ScheduleEntry[]>();
    for (const entry of mergedEntries) {
      const key = this.makeMatchKey(entry.patientName, entry.visitDate, entry.startTime);
      const existing = hamMap.get(key) || [];
      hamMap.set(key, [...existing, entry]);
    }

    // ── Sheets レコード走査 + フィールドレベル検証 (D-06: per-record aggregation) ──
    const mismatches: VerificationMismatch[] = [];
    // HAM レコードの消費数をキーごとにカウント（重複検出用）
    const hamConsumedCount = new Map<string, number>();
    let matchedCount = 0;

    for (const r of sheetsRecords) {
      const key = this.makeMatchKey(r.patientName, r.visitDate, r.startTime);
      const hamRecords = hamMap.get(key);

      if (!hamRecords || hamRecords.length === 0) {
        // REC-01: missing from HAM
        mismatches.push({
          recordId: r.recordId,
          patientName: r.patientName,
          visitDate: r.visitDate,
          startTime: r.startTime,
          endTime: r.endTime,
          staffName: r.staffName,
          sheetsServiceType: `${r.serviceType1}/${r.serviceType2}`,
          missingFromHam: true,
        });
        continue;
      }

      hamConsumedCount.set(key, (hamConsumedCount.get(key) || 0) + 1);

      // Find best matching HAM record (multi-staff visits: staff name → endTime → first)
      const sheetsStaffNorm = normalizeCjkName(resolveStaffAlias(extractPlainName(r.staffName)));
      const bestHam =
        // 1st: スタッフ名一致（CJK正規化 + 資格前缀除去 + エイリアス解決）
        hamRecords.find(h => normalizeCjkName(resolveStaffAlias(extractPlainName(h.staffName))) === sheetsStaffNorm)
        // 2nd: 終了時刻一致
        || hamRecords.find(h => this.normalizeTime(h.endTime) === this.normalizeTime(r.endTime))
        // 3rd: 先頭エントリ
        || hamRecords[0];

      // Build mismatch object (D-06: aggregate all field mismatches)
      const timeMismatch = checkTimeMismatch(r.endTime, bestHam.endTime);
      const serviceMismatch = checkServiceMismatch(
        { serviceType1: r.serviceType1, serviceType2: r.serviceType2 },
        { serviceName: bestHam.serviceName, serviceContent: bestHam.serviceContent },
      );
      const staffMismatch = checkStaffMismatch(
        r.staffName,
        bestHam.staffName,
        bestHam.serviceContent,
        this.staffQualifications,
      );

      if (timeMismatch || serviceMismatch || staffMismatch) {
        mismatches.push({
          recordId: r.recordId,
          patientName: r.patientName,
          visitDate: r.visitDate,
          startTime: r.startTime,
          endTime: r.endTime,
          staffName: r.staffName,
          sheetsServiceType: `${r.serviceType1}/${r.serviceType2}`,
          missingFromHam: false,
          timeMismatch,
          serviceMismatch,
          staffMismatch,
        });
      } else {
        matchedCount++;
      }
    }

    // ── REC-05: extraInHam detection ──
    // Sheets 全レコードのキー別カウント（エラー含む全ステータス）
    const allSheetsKeyCount = new Map<string, number>();
    for (const r of allRecords) {
      const key = this.makeMatchKey(r.patientName, r.visitDate, r.startTime);
      allSheetsKeyCount.set(key, (allSheetsKeyCount.get(key) || 0) + 1);
    }

    const extraInHam: ExtraInHamRecord[] = [];
    for (const [key, entries] of hamMap) {
      // Sheets 側の件数（全ステータス合計）を取得
      const sheetsCount = allSheetsKeyCount.get(key) || 0;
      // HAM 件数が Sheets 件数以下 → 余剰なし
      if (entries.length <= sheetsCount) continue;
      // 差分のみ余剰として報告（末尾から余った分を取得）
      const extraEntries = entries.slice(sheetsCount);
      for (const e of extraEntries) {
        extraInHam.push({
          patientName: e.patientName,
          visitDate: e.visitDate,
          startTime: e.startTime,
          endTime: e.endTime,
          staffName: e.staffName,
          serviceName: e.serviceName,
          serviceContent: e.serviceContent,
        });
      }
    }

    logger.info(
      `[検証] Sheets=${sheetsRecords.length}, HAM=${mergedEntries.length}, ` +
      `一致=${matchedCount}, 不一致=${mismatches.length}, extraInHam=${extraInHam.length}`
    );

    return {
      sheetsTotal: sheetsRecords.length,
      hamTotal: mergedEntries.length,
      matched: matchedCount,
      mismatches,
      extraInHam,
    };
  }

  /**
   * 前月の未登録データチェック
   *
   * 当月の転記処理前に前月タブを確認し、未転記レコードがないかを検出する。
   *
   * @param sheetId 転記用 Google Sheets ID
   * @returns 前月の未転記レコード情報
   */
  async checkPreviousMonthUnregistered(
    sheetId: string,
  ): Promise<PreviousMonthPendingResult> {
    const prevTab = this.getPreviousMonthTab();
    logger.info(`前月タブ「${prevTab}」の未登録レコードをチェック...`);

    let records: TranscriptionRecord[];
    try {
      records = await this.sheets.getTranscriptionRecords(sheetId, prevTab);
    } catch (error) {
      logger.warn(`前月タブ「${prevTab}」の読み取り失敗（タブが存在しない可能性）: ${(error as Error).message}`);
      return { hasPending: false, pendingCount: 0, pendingRecords: [] };
    }

    // isTranscriptionTarget と同じロジックで判定
    const pendingRecords = records.filter(r => this.isTranscriptionTarget(r));

    const result: PreviousMonthPendingResult = {
      hasPending: pendingRecords.length > 0,
      pendingCount: pendingRecords.length,
      pendingRecords: pendingRecords.map(r => ({
        recordId: r.recordId,
        patientName: r.patientName,
        visitDate: r.visitDate,
        staffName: r.staffName,
        transcriptionFlag: r.transcriptionFlag,
      })),
    };

    if (result.hasPending) {
      logger.warn(`前月「${prevTab}」に未登録レコード ${result.pendingCount} 件を検出！`);
      for (const r of result.pendingRecords.slice(0, 10)) {
        logger.warn(`  - ${r.recordId}: ${r.patientName} (${r.visitDate}) [${r.transcriptionFlag || '未転記'}]`);
      }
      if (result.pendingCount > 10) {
        logger.warn(`  ... 他 ${result.pendingCount - 10} 件`);
      }
    } else {
      logger.info(`前月「${prevTab}」に未登録レコードなし ✓`);
    }

    return result;
  }

  /**
   * 突合結果を人間が読めるテキストレポートに変換
   */
  formatReport(result: ReconciliationResult): string {
    const lines: string[] = [];
    lines.push('=== 予実突合レポート ===');
    lines.push('');
    lines.push(`Sheets 転記済み: ${result.sheetsTotal} 件`);
    lines.push(`HAM 8-1 CSV（フィルタ・結合後）: ${result.hamTotal} 件`);
    lines.push(`マッチ: ${result.matched} 件`);
    lines.push('');

    if (result.missingFromHam.length > 0) {
      lines.push(`--- Sheets にあるが HAM にない（転記漏れの可能性）: ${result.missingFromHam.length} 件 ---`);
      for (const m of result.missingFromHam) {
        lines.push(`  ${m.patientName} | ${m.visitDate} ${m.startTime}-${m.endTime} | ${m.staffName} | ${m.serviceType}`);
      }
      lines.push('');
    }

    if (result.extraInHam.length > 0) {
      lines.push(`--- HAM にあるが Sheets にない（手動追加 or 二重登録）: ${result.extraInHam.length} 件 ---`);
      for (const m of result.extraInHam) {
        lines.push(`  ${m.patientName} | ${m.visitDate} ${m.startTime}-${m.endTime} | ${m.staffName} | ${m.serviceType}`);
      }
      lines.push('');
    }

    if (result.qualificationMismatches.length > 0) {
      lines.push(`--- 資格不一致（准看護師→看護師 誤登録）: ${result.qualificationMismatches.length} 件 ---`);
      for (const q of result.qualificationMismatches) {
        lines.push(`  ${q.patientName} | ${q.visitDate} ${q.startTime} | ${q.staffName}`);
        lines.push(`    Sheets: ${q.sheetsServiceType}`);
        lines.push(`    HAM: ${q.hamServiceType}`);
        lines.push(`    問題: ${q.issue}`);
      }
      lines.push('');
    }

    if (result.previousMonthPending) {
      if (result.previousMonthPending.hasPending) {
        lines.push(`--- 前月未登録レコード: ${result.previousMonthPending.pendingCount} 件 ---`);
        for (const r of result.previousMonthPending.pendingRecords) {
          lines.push(`  ${r.recordId}: ${r.patientName} (${r.visitDate}) [${r.transcriptionFlag || '未転記'}]`);
        }
      } else {
        lines.push('前月未登録レコード: なし ✓');
      }
      lines.push('');
    }

    if (
      result.missingFromHam.length === 0 &&
      result.extraInHam.length === 0 &&
      result.qualificationMismatches.length === 0
    ) {
      lines.push('✓ 差異なし — Sheets と HAM のデータは一致しています');
    }

    return lines.join('\n');
  }

  // ─── 8-1 CSV パーサー ───

  /**
   * 8-1 スケジュールデータ CSV をパース
   *
   * CSV はShift-JIS エンコード。列構造はヘッダー行から自動検出する。
   */
  parseScheduleCsv(csvPath: string): ScheduleEntry[] {
    if (!fs.existsSync(csvPath)) {
      throw new Error(`8-1 CSV が見つかりません: ${csvPath}`);
    }

    const buffer = fs.readFileSync(csvPath);
    const decoder = new TextDecoder('shift-jis');
    const text = decoder.decode(buffer);
    const lines = text.split(/\r?\n/);

    logger.debug(`8-1 CSV: ${lines.length} 行読み込み`);

    if (lines.length < 2) {
      throw new Error('8-1 CSV のフォーマットが不正です（2行未満）');
    }

    // ヘッダー行検出: 最初の数行を走査して列名を含む行を見つける
    let headerLineIdx = -1;
    let headers: string[] = [];
    const knownHeaders = ['利用者', '日付', '開始', '終了', 'スタッフ', 'サービス', '実績'];

    for (let i = 0; i < Math.min(5, lines.length); i++) {
      const cols = this.parseCsvLine(lines[i]);
      const matchCount = knownHeaders.filter(kh =>
        cols.some(c => c.includes(kh))
      ).length;
      if (matchCount >= 3) {
        headerLineIdx = i;
        headers = cols;
        break;
      }
    }

    if (headerLineIdx === -1) {
      logger.warn('8-1 CSV ヘッダー行を自動検出できませんでした。先頭行をヘッダーとして使用');
      headerLineIdx = 0;
      headers = this.parseCsvLine(lines[0]);
    }

    // 列インデックスの特定
    const colMap = this.detectColumns(headers);
    logger.debug(`8-1 CSV 列検出: ${JSON.stringify(colMap)}`);

    // データ行パース
    const entries: ScheduleEntry[] = [];
    for (let i = headerLineIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.length < 5) continue;

      const fields = this.parseCsvLine(line);
      const patientName = (fields[colMap.patientName] || '').trim();
      if (!patientName) continue;

      entries.push({
        patientName,
        visitDate: this.normalizeDate(fields[colMap.visitDate] || ''),
        startTime: this.normalizeTime(fields[colMap.startTime] || ''),
        endTime: this.normalizeTime(fields[colMap.endTime] || ''),
        staffName: (fields[colMap.staffName] || '').trim(),
        serviceName: (fields[colMap.serviceName] || '').trim(),
        serviceContent: (fields[colMap.serviceContent] || '').trim(),
        resultFlag: (fields[colMap.resultFlag] || '').trim(),
        csvRow: i + 1,
      });
    }

    logger.info(`8-1 CSV パース完了: ${entries.length} 件のスケジュールエントリ`);
    return entries;
  }

  /**
   * 8-1 CSV をパースし、フィルタリング + リハビリ結合 + HAM重複排除を適用した結果を返す。
   * verify() や verifyCorrectionRecords 等、処理済みデータが必要な場面で使用する。
   */
  parseAndMergeScheduleCsv(csvPath: string): ScheduleEntry[] {
    const raw = this.parseScheduleCsv(csvPath);
    const filtered = raw.filter(e => {
      if (TEST_PATIENT_PATTERNS.some(p => e.patientName.includes(p))) return false;
      if (e.startTime === '12:00' && e.endTime === '12:00') return false;
      if (e.serviceContent.includes('超減算') || e.serviceContent.includes('月超')) return false;
      return true;
    });
    return this.mergeRehabSegments(filtered);
  }

  // ─── プライベートヘルパー ───

  /**
   * CSV ヘッダーから列インデックスを自動検出
   */
  private detectColumns(headers: string[]): Record<string, number> {
    const find = (keywords: string[]): number => {
      for (let i = 0; i < headers.length; i++) {
        if (keywords.some(kw => headers[i].includes(kw))) return i;
      }
      return -1;
    };

    // 8-1 CSV 列構造 (2026-02 実データ検証済):
    //   0: サービス日付  1: 曜日  2: 開始時間  3: 終了時間
    //   4: 利用者名  5: フリガナ  6: 被保険者番号  7: スタッフ名
    //   8: 従業員番号  9: 訪問開始時間  10: 訪問終了時間
    //  11: サービス種類  12: サービス内容  13: サービスコード
    //  16: サービス実績
    const patientNameIdx = find(['利用者名', '利用者', '氏名']);
    const visitDateIdx = find(['サービス日付', '日付', '訪問日', '年月日']);
    const startTimeIdx = find(['開始時間', '開始時刻', '開始']);
    const endTimeIdx = find(['終了時間', '終了時刻', '終了']);
    const staffNameIdx = find(['スタッフ名', 'スタッフ', '担当者']);
    // サービス種類（col 11）とサービス内容（col 12）を別々に検出
    const serviceNameIdx = find(['サービス種類', 'サービス名']);
    const serviceContentIdx = find(['サービス内容']);
    const resultFlagIdx = find(['サービス実績', '実績', '実績フラグ', '予実']);

    return {
      patientName: patientNameIdx >= 0 ? patientNameIdx : 4,
      visitDate: visitDateIdx >= 0 ? visitDateIdx : 0,
      startTime: startTimeIdx >= 0 ? startTimeIdx : 2,
      endTime: endTimeIdx >= 0 ? endTimeIdx : 3,
      staffName: staffNameIdx >= 0 ? staffNameIdx : 7,
      serviceName: serviceNameIdx >= 0 ? serviceNameIdx : 11,
      serviceContent: serviceContentIdx >= 0 ? serviceContentIdx : 12,
      resultFlag: resultFlagIdx >= 0 ? resultFlagIdx : 16,
    };
  }

  /**
   * リハビリセグメント結合 + HAM 重複行の排除
   *
   * HAM の 8-1 CSV には以下の特性がある:
   *
   * 1. 介護保険リハビリ（訪看Ⅰ５/予訪看Ⅰ５）:
   *    20分セグメントに分割して記録される。
   *    → 患者+日付+スタッフ名でグループ化し、開始〜終了を結合する。
   *
   * 2. HAM 重複行（全サービス共通）:
   *    医療保険の訪問看護（療養費、精神科、理学療法士等）で、
   *    同一訪問に対してスタッフあり/なしの重複行が出力される。
   *    → 患者+日付+開始時刻+サービス内容でグループ化し、
   *       スタッフ名がある行を優先して1行に集約する。
   */
  private mergeRehabSegments(entries: ScheduleEntry[]): ScheduleEntry[] {
    // ── STEP 1: 介護保険リハビリ 20分セグメント結合 ──
    const isKaigoRehab = (e: ScheduleEntry) =>
      e.serviceContent.includes('訪看Ⅰ５') || e.serviceContent.includes('予訪看Ⅰ５');

    const nonKaigoRehab = entries.filter(e => !isKaigoRehab(e));
    const kaigoRehab = entries.filter(e => isKaigoRehab(e));

    // グループ化: 患者 + 日付 + スタッフ名
    const kaigoGroups = new Map<string, ScheduleEntry[]>();
    for (const e of kaigoRehab) {
      const key = `${this.normalizeNameForKey(e.patientName)}|${this.normalizeDate(e.visitDate)}|${this.normalizeNameForKey(e.staffName)}`;
      if (!kaigoGroups.has(key)) kaigoGroups.set(key, []);
      kaigoGroups.get(key)!.push(e);
    }

    // 時刻を分数に変換（ギャップ判定用）
    const toMinutes = (t: string): number => {
      const m = t.match(/^(\d{1,2}):(\d{2})/);
      return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : -1;
    };

    const kaigoMerged: ScheduleEntry[] = [];
    for (const [, segs] of kaigoGroups) {
      const sorted = [...segs].sort((a, b) => a.startTime.localeCompare(b.startTime));
      // 連続性で分割: prev.endTime と curr.startTime のギャップが 1分以下のみ連結
      // 例: 濵田博子 4/9 11:00-11:40 と 14:20-15:00 は同一staffだが別session
      let currentSession: ScheduleEntry[] = [];
      const flushSession = () => {
        if (currentSession.length === 0) return;
        const first = currentSession[0];
        const last = currentSession[currentSession.length - 1];
        kaigoMerged.push({
          patientName: first.patientName,
          visitDate: first.visitDate,
          startTime: first.startTime,
          endTime: last.endTime,
          staffName: first.staffName,
          serviceName: first.serviceName,
          serviceContent: first.serviceContent,
          resultFlag: first.resultFlag,
          csvRow: first.csvRow,
        });
        currentSession = [];
      };
      for (const seg of sorted) {
        if (currentSession.length === 0) {
          currentSession.push(seg);
          continue;
        }
        const prevEnd = toMinutes(currentSession[currentSession.length - 1].endTime);
        const currStart = toMinutes(seg.startTime);
        if (prevEnd >= 0 && currStart >= 0 && currStart - prevEnd <= 1) {
          // 連続: 現セッションに追加
          currentSession.push(seg);
        } else {
          // ギャップあり: 現セッション完了 + 新セッション開始
          flushSession();
          currentSession.push(seg);
        }
      }
      flushSession();
    }

    if (kaigoRehab.length > 0) {
      logger.debug(`介護リハビリ結合: ${kaigoRehab.length} セグメント → ${kaigoMerged.length} セッション`);
    }

    // ── STEP 2: HAM 重複行の排除（全サービス共通） ──
    // 患者+日付+開始時刻+終了時刻+サービス内容が同一の行をグループ化し、
    // スタッフ名がある行を優先して重複を排除する。
    // endTime を含めることで、同一開始時刻だが異なる訪問（終了時刻違い）を誤マージしない。
    const allAfterStep1 = [...nonKaigoRehab, ...kaigoMerged];
    const dedupGroups = new Map<string, ScheduleEntry[]>();
    for (const e of allAfterStep1) {
      const key = `${this.normalizeNameForKey(e.patientName)}|${this.normalizeDate(e.visitDate)}|${this.normalizeTime(e.startTime)}|${this.normalizeTime(e.endTime)}|${e.serviceContent}`;
      if (!dedupGroups.has(key)) dedupGroups.set(key, []);
      dedupGroups.get(key)!.push(e);
    }

    const dedupResult: ScheduleEntry[] = [];
    let dedupCount = 0;
    for (const [, dupes] of dedupGroups) {
      if (dupes.length === 1) {
        dedupResult.push(dupes[0]);
        continue;
      }
      // 重複あり: スタッフ名がある行を優先して1行に集約
      const withStaff = dupes.filter(d => d.staffName.trim() !== '');
      if (withStaff.length > 0) {
        // スタッフ付き行から一意のスタッフのみ残す
        const seenStaff = new Set<string>();
        for (const d of withStaff) {
          const normStaff = this.normalizeNameForKey(d.staffName);
          if (!seenStaff.has(normStaff)) {
            seenStaff.add(normStaff);
            dedupResult.push(d);
          }
        }
      } else {
        // 全てスタッフなし → 1行だけ残す
        dedupResult.push(dupes[0]);
      }
      dedupCount += dupes.length - (withStaff.length > 0
        ? new Set(withStaff.map(d => this.normalizeNameForKey(d.staffName))).size
        : 1);
    }

    if (dedupCount > 0) {
      logger.debug(`HAM 重複行排除: ${allAfterStep1.length} 行 → ${dedupResult.length} 行（${dedupCount} 行除外）`);
    }

    return dedupResult;
  }

  /**
   * 患者名/スタッフ名を正規化（マッチキー用）
   */
  private normalizeNameForKey(name: string): string {
    return normalizeCjkName(name);
  }

  /**
   * 突合用のマッチキーを作成
   * 患者名の正規化（スペース除去 + NFKC）+ 日付正規化 + 時刻正規化
   */
  private makeMatchKey(patientName: string, visitDate: string, startTime: string): string {
    const normName = this.normalizeNameForKey(patientName);
    const normDate = this.normalizeDate(visitDate);
    const normTime = this.normalizeTime(startTime);
    return `${normName}|${normDate}|${normTime}`;
  }

  /**
   * 日付を YYYY/MM/DD 形式に正規化
   * 入力: "2026/03/01", "20260301", "2026-03-01", "3/1" 等
   */
  private normalizeDate(dateStr: string): string {
    if (!dateStr) return '';
    const cleaned = dateStr.trim();

    // YYYYMMDD → YYYY/MM/DD
    if (/^\d{8}$/.test(cleaned)) {
      return `${cleaned.substring(0, 4)}/${cleaned.substring(4, 6)}/${cleaned.substring(6, 8)}`;
    }
    // YYYY-MM-DD → YYYY/MM/DD
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(cleaned)) {
      return cleaned.replace(/-/g, '/');
    }
    // 既に YYYY/MM/DD
    return cleaned;
  }

  /**
   * 時刻を HH:MM 形式に正規化
   * 入力: "10:00", "10時00分", "1000" 等
   */
  private normalizeTime(timeStr: string): string {
    if (!timeStr) return '';
    const cleaned = timeStr.trim();

    // HH:MM
    if (/^\d{1,2}:\d{2}$/.test(cleaned)) return cleaned;

    // HHMM → HH:MM
    if (/^\d{4}$/.test(cleaned)) {
      return `${cleaned.substring(0, 2)}:${cleaned.substring(2, 4)}`;
    }

    // XX時YY分
    const match = cleaned.match(/(\d{1,2})時(\d{1,2})分/);
    if (match) return `${match[1]}:${match[2].padStart(2, '0')}`;

    return cleaned;
  }

  /**
   * 転記対象レコードかどうかを判定
   * TranscriptionWorkflow.isTranscriptionTarget と同一ロジック
   */
  private isTranscriptionTarget(record: TranscriptionRecord): boolean {
    if (record.recordLocked) return false;
    const cs = record.completionStatus;
    if (cs === '' || cs === '1') return false;
    if (record.accompanyCheck.includes('重複') && !record.accompanyClerkCheck.trim()) return false;
    if (record.emergencyFlag.includes('緊急支援あり') && !record.emergencyClerkCheck.trim()) return false;
    if (record.transcriptionFlag === '転記済み') return false;
    if (record.transcriptionFlag === '') return true;
    if (record.transcriptionFlag === 'エラー：システム') return true;
    if (record.transcriptionFlag === 'エラー：マスタ不備' && record.masterCorrectionFlag) return true;
    if (record.transcriptionFlag === '修正あり') return true;
    return false;
  }

  /**
   * 前月タブ名を返す（形式: "2026年02月"）
   */
  private getPreviousMonthTab(): string {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${prev.getFullYear()}年${String(prev.getMonth() + 1).padStart(2, '0')}月`;
  }

  /**
   * CSV 行をパース（ダブルクォート対応）
   */
  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }
}
