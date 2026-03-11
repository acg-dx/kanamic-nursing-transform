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
   * リハビリの 20 分セグメントを結合
   *
   * HAM は訪看Ⅰ５/予訪看Ⅰ５（リハビリ 20 分）を分割して記録するが、
   * Sheets は全体の訪問時間で記録する。連続する同一患者・同一日のリハビリ
   * セグメントを結合し、最初のセグメントの開始時刻と最後のセグメントの
   * 終了時刻で1つのエントリにまとめる。
   */
  private mergeRehabSegments(entries: ScheduleEntry[]): ScheduleEntry[] {
    const isRehab = (e: ScheduleEntry) =>
      e.serviceContent.includes('訪看Ⅰ５') || e.serviceContent.includes('予訪看Ⅰ５');

    const nonRehab = entries.filter(e => !isRehab(e));
    const rehab = entries.filter(e => isRehab(e));

    if (rehab.length === 0) return entries;

    // 同一患者 + 同一日でグループ化（スタッフは無視 — HAM はセラピストを分割する場合あり）
    const groups = new Map<string, ScheduleEntry[]>();
    for (const e of rehab) {
      const normName = this.normalizeNameForKey(e.patientName);
      const normDate = this.normalizeDate(e.visitDate);
      const key = `${normName}|${normDate}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(e);
    }

    // 各グループを結合: 最初のセグメントの開始時刻 + 最後のセグメントの終了時刻
    const merged: ScheduleEntry[] = [];
    for (const [, segs] of groups) {
      const sorted = segs.sort((a, b) => a.startTime.localeCompare(b.startTime));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      merged.push({
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
    }

    logger.debug(`リハビリ結合: ${rehab.length} セグメント → ${merged.length} セッション`);
    return [...nonRehab, ...merged];
  }

  /**
   * 患者名/スタッフ名を正規化（マッチキー用）
   */
  private normalizeNameForKey(name: string): string {
    return name
      .normalize('NFKC')
      .replace(/[\s\u3000\u00a0]+/g, '')
      .trim();
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
