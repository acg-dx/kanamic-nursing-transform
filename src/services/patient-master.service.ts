/**
 * 利用者マスタサービス
 *
 * HAM の利用者マスター管理 (u1-1) からエクスポートされた CSV ファイルを解析し、
 * aozoraID → 被保険者番号のマッピングを構築する。
 *
 * CSV ファイル仕様（Shift-JIS エンコード、userallfull_YYYYMM.csv）:
 *   行1: "事業所番号","事業所名","対象年月"
 *   行2: "4664590280","訪問看護ステーションあおぞら姶良","2026/02"
 *   行3: ヘッダー行（利用者名,利用者名フリガナ,...被保険者番号,...お客様番号１,...）
 *   行4〜: データ行
 *
 * 重要な列:
 *   列0  = 利用者名
 *   列1  = 利用者名フリガナ
 *   列3  = 被保険者番号 (HAM k2_1 で検索可能)
 *   列4  = お客様番号１ = aozora ID (Google Sheets の F 列と対応)
 *   列22 = 要介護度区分 (要介護1-5 / 要支援1-2 / 未認定申請中)
 */
import fs from 'fs';
import { logger } from '../core/logger';

/** 利用者マスタの1患者分のデータ */
export interface PatientMasterEntry {
  /** 利用者名（漢字、全角スペース区切り） */
  name: string;
  /** 利用者名フリガナ */
  nameKana: string;
  /** 被保険者番号（HAM検索用、空の場合あり） */
  hihokenshaBangou: string;
  /** お客様番号１ = aozora ID */
  aozoraId: string;
  /** お客様番号２（予備） */
  okyakuBangou2: string;
  /** 要介護度区分（要介護1-5, 要支援1-2, 未認定申請中） */
  careLevel: string;
}

/**
 * 利用者マスタサービス
 * CSV → aozoraID ベースの患者マッピングを提供
 */
export class PatientMasterService {
  private entries: PatientMasterEntry[] = [];
  /** aozoraID → PatientMasterEntry */
  private byAozoraId = new Map<string, PatientMasterEntry>();
  /** 被保険者番号 → PatientMasterEntry */
  private byHihokensha = new Map<string, PatientMasterEntry>();
  /** 利用者名 → PatientMasterEntry[] (同名同姓対応) */
  private byName = new Map<string, PatientMasterEntry[]>();

  /**
   * Shift-JIS CSV ファイルを読み込みマッピングを構築
   *
   * @param csvPath userallfull CSV ファイルパス
   */
  async loadFromCsv(csvPath: string): Promise<void> {
    if (!fs.existsSync(csvPath)) {
      throw new Error(`利用者マスタ CSV が見つかりません: ${csvPath}`);
    }

    const buffer = fs.readFileSync(csvPath);

    // Shift-JIS → UTF-8 デコード
    // Node.js の TextDecoder は 'shift_jis' / 'shift-jis' をサポート
    const decoder = new TextDecoder('shift-jis');
    const text = decoder.decode(buffer);

    const lines = text.split(/\r?\n/);
    logger.info(`利用者マスタ CSV: ${lines.length} 行読み込み`);

    // 行1-2 はメタデータ、行3 はヘッダー、行4〜 がデータ
    if (lines.length < 4) {
      throw new Error('利用者マスタ CSV のフォーマットが不正です（4行未満）');
    }

    // ヘッダー解析（列番号を確認）
    const headerLine = lines[2];
    const headers = this.parseCsvLine(headerLine);
    logger.debug(`CSV ヘッダー列数: ${headers.length}`);

    // 列インデックスの特定（位置が変わっても対応できるようにヘッダー名で探す）
    const colName = headers.findIndex(h => h.includes('利用者名') && !h.includes('フリガナ'));
    const colKana = headers.findIndex(h => h.includes('フリガナ'));
    const colHihokensha = headers.findIndex(h => h === '被保険者番号');
    const colOkyaku1 = headers.findIndex(h => h.includes('お客様番号１'));
    const colOkyaku2 = headers.findIndex(h => h.includes('お客様番号２'));
    const colCareLevel = headers.findIndex(h => h.includes('要介護度区分'));

    // フォールバック: 固定位置
    const iName = colName >= 0 ? colName : 0;
    const iKana = colKana >= 0 ? colKana : 1;
    const iHihokensha = colHihokensha >= 0 ? colHihokensha : 3;
    const iOkyaku1 = colOkyaku1 >= 0 ? colOkyaku1 : 4;
    const iOkyaku2 = colOkyaku2 >= 0 ? colOkyaku2 : 5;
    const iCareLevel = colCareLevel >= 0 ? colCareLevel : 22;

    // データ行パース
    this.entries = [];
    this.byAozoraId.clear();
    this.byHihokensha.clear();
    this.byName.clear();

    for (let i = 3; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.length < 10) continue;

      const fields = this.parseCsvLine(line);
      const entry: PatientMasterEntry = {
        name: (fields[iName] || '').trim(),
        nameKana: (fields[iKana] || '').trim(),
        hihokenshaBangou: (fields[iHihokensha] || '').trim(),
        aozoraId: (fields[iOkyaku1] || '').trim(),
        okyakuBangou2: (fields[iOkyaku2] || '').trim(),
        careLevel: (fields[iCareLevel] || '').trim(),
      };

      if (!entry.name) continue;
      this.entries.push(entry);

      // aozoraID マッピング
      if (entry.aozoraId) {
        this.byAozoraId.set(entry.aozoraId, entry);
      }

      // 被保険者番号マッピング
      if (entry.hihokenshaBangou) {
        this.byHihokensha.set(entry.hihokenshaBangou, entry);
      }

      // 名前マッピング（同名同姓に対応）
      const nameKey = entry.name.replace(/\s+/g, '');
      const existing = this.byName.get(nameKey) || [];
      existing.push(entry);
      this.byName.set(nameKey, existing);
    }

    logger.info(
      `利用者マスタ: ${this.entries.length}名読み込み完了 ` +
      `(aozoraID: ${this.byAozoraId.size}, 被保険者番号: ${this.byHihokensha.size})`
    );
  }

  /**
   * aozora ID で患者を検索
   */
  findByAozoraId(aozoraId: string): PatientMasterEntry | undefined {
    return this.byAozoraId.get(aozoraId);
  }

  /**
   * 被保険者番号で患者を検索
   */
  findByHihokensha(bangou: string): PatientMasterEntry | undefined {
    return this.byHihokensha.get(bangou);
  }

  /**
   * 患者名で検索（同名同姓の場合は複数件返す）
   */
  findByName(name: string): PatientMasterEntry[] {
    const key = name.replace(/\s+/g, '');
    return this.byName.get(key) || [];
  }

  /**
   * 同名同姓が存在するかチェック
   */
  hasDuplicateName(name: string): boolean {
    const matches = this.findByName(name);
    return matches.length > 1;
  }

  /**
   * 要介護度から予防/介護を判定
   * @returns "介護" | "予防" | null (判定不可)
   */
  static determineCareType(careLevel: string): '介護' | '予防' | null {
    if (!careLevel) return null;
    // 要介護1-5 → 介護
    if (/要介護[1-5]/.test(careLevel)) return '介護';
    // 要支援1-2 → 予防
    if (/要支援[1-2]/.test(careLevel)) return '予防';
    // 未認定申請中 → 通常は医療保険のみ
    return null;
  }

  /** 全エントリを取得 */
  get all(): ReadonlyArray<PatientMasterEntry> {
    return this.entries;
  }

  /** エントリ数 */
  get count(): number {
    return this.entries.length;
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
          // エスケープされたダブルクォート
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
