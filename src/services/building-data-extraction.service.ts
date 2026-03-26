/**
 * 同一建物管理 データ取得サービス
 *
 * Kintone App 197 + 共同生活援助スプレッドシートからデータを取得・統合し、
 * 連携スプレッドシートの月度タブに書き込む。
 *
 * データフロー:
 *   1. Kintone 197 → 高齢者施設 / 短期入所 / 認知症GH の入居者
 *   2. GH鹿児島 + GH福岡 → 共同生活援助の入居者
 *   3. 施設定義タブで拠点名 → カナミック施設名にマッピング
 *   4. 前月タブとの差分で新規フラグ判定
 *   5. 月度タブに一括書き込み
 *
 * 実行タイミング: 毎月3日早朝6時（対象: 前月）
 */
import { logger } from '../core/logger';
import { KintoneService, type KintoneResidentRecord } from './kintone.service';
import { GHSpreadsheetService, type GHResidentRaw } from './gh-spreadsheet.service';
import { SpreadsheetService } from './spreadsheet.service';
import type { FacilityDefinition } from '../types/spreadsheet.types';

/** 連携シート月度タブに書き込む1行分のデータ */
export interface BuildingOutputRecord {
  /** A: 入居施設（カナミック登録施設名） */
  facilityName: string;
  /** B: あおぞらID */
  aozoraId: string;
  /** C: 利用者名（クリーニング済み） */
  userName: string;
  /** D: 利用訪問看護事業所名（空欄 — Phase 2で使用） */
  nursingOfficeName: string;
  /** E: 入居日 */
  moveInDate: string;
  /** F: 退去日（未退去の場合は空欄） */
  moveOutDate: string;
  /** G: 新規フラグ */
  isNew: boolean;
  /** H: ステータス */
  status: string;
  /** I: 備考 */
  notes: string;
}

/** 転記用事業所シートの定義 */
export interface NursingSheetLocation {
  /** 事業所短縮名 e.g. "姶良" */
  name: string;
  /** Google Sheets ID */
  sheetId: string;
  /** カナミック上の正式事業所名 e.g. "訪問看護ステーションあおぞら姶良" */
  officeName: string;
}

export interface ExtractionConfig {
  kintone: {
    baseUrl: string;
    appId: number;
    apiToken: string;
  };
  ghSheetIdKagoshima: string;
  ghSheetIdFukuoka: string;
  buildingMgmtSheetId: string;
  serviceAccountKeyPath: string;
  /** 転記用事業所シート（訪問看護利用実績の取得元） */
  nursingSheetLocations: NursingSheetLocation[];
}

export interface ExtractionResult {
  totalRecords: number;
  newRecords: number;
  filteredByNursing: number;
  kintoneRecords: number;
  ghRecords: number;
  unmappedFacilities: string[];
  tab: string;
}

/**
 * 施設定義では自動マッチングできない特殊ケースのハードコードマッピング
 *
 * Kintone施設名 → カナミック登録施設名
 * - うらら1/うらら2: 数字サフィックスで別施設を区別
 * - 田上: カナミック上は「有料老人ホームあおぞら」名で登録（後ろに地名なし）
 */
const KINTONE_SPECIAL_MAPPINGS: Record<string, string> = {
  'うらら1・認知症GH': 'グループホームうらら',
  'うらら2・介付有料': '介護付有料老人ホームうらら',
  '田上・有料': '有料老人ホームあおぞら',
};

/**
 * GH拠点名 → カナミック登録施設名（施設定義に行が存在しないケース）
 */
const GH_SPECIAL_MAPPINGS: Record<string, string> = {
  '宇宿': '共同生活援助あおぞら',
};

export class BuildingDataExtractionService {
  private kintone: KintoneService;
  private gh: GHSpreadsheetService;
  private sheets: SpreadsheetService;
  private config: ExtractionConfig;

  constructor(config: ExtractionConfig) {
    this.config = config;
    this.kintone = new KintoneService({
      baseUrl: config.kintone.baseUrl,
      appId: config.kintone.appId,
      apiToken: config.kintone.apiToken,
    });
    this.gh = new GHSpreadsheetService(config.serviceAccountKeyPath);
    this.sheets = new SpreadsheetService(config.serviceAccountKeyPath);
  }

  /**
   * メイン処理: データ取得 → 訪問看護フィルタ → 統合 → 書き込み
   *
   * フロー:
   *   1. 転記シートから訪問看護利用者のあおぞらIDを取得
   *   2. Kintone + GH から入居者を取得
   *   3. 施設定義でマッピング
   *   4. 訪問看護利用実績でフィルタ（入居 AND 訪問看護利用 の利用者のみ）
   *   5. 利用訪問看護事業所名を設定
   *   6. 重複除去 → 新規フラグ → 書き込み
   *
   * @param targetYear 対象年 e.g. 2026
   * @param targetMonth 対象月 e.g. 2 (= 2月)
   * @param dryRun true の場合、シートへの書き込みを行わない
   */
  async extract(targetYear: number, targetMonth: number, dryRun = false): Promise<ExtractionResult> {
    const tab = `${targetYear}/${String(targetMonth).padStart(2, '0')}`;
    // 転記シートのタブ名形式: "2026年02月"
    const transcriptionTab = `${targetYear}年${String(targetMonth).padStart(2, '0')}月`;
    logger.info(`=== 同一建物管理データ取得開始 (${tab}) ===`);

    // 1. 転記シートから訪問看護利用者のあおぞらIDを取得（全事業所並列）
    const nursingIdMap = await this.buildNursingVisitMap(transcriptionTab);
    const allNursingIds = new Set<string>();
    for (const ids of nursingIdMap.values()) {
      for (const id of ids) allNursingIds.add(id);
    }
    logger.info(`訪問看護利用者: ${allNursingIds.size} 名 (${this.config.nursingSheetLocations.length} 事業所から取得)`);

    // 2. 施設定義を読み込み
    const facilityDefs = await this.sheets.getFacilityDefinitions(this.config.buildingMgmtSheetId);
    logger.info(`施設定義: ${facilityDefs.length} 件`);

    // 3. Kintone + GH から並列取得
    const [kintoneRecords, ghKagoshima, ghFukuoka] = await Promise.all([
      this.kintone.getResidents(targetYear, targetMonth),
      this.gh.getActiveResidents(this.config.ghSheetIdKagoshima, 'kagoshima', targetYear, targetMonth),
      this.gh.getActiveResidents(this.config.ghSheetIdFukuoka, 'fukuoka', targetYear, targetMonth),
    ]);

    // 4. Kintoneから共同生活援助以外を抽出（共同生活援助はGHシートから取得）
    const kintoneNonGH = kintoneRecords.filter(r => r.providedBusiness !== '共同生活援助');
    logger.info(`Kintone (非GH): ${kintoneNonGH.length} 件 (全${kintoneRecords.length}件から共同生活援助${kintoneRecords.length - kintoneNonGH.length}件を除外)`);

    const ghAll = [...ghKagoshima, ...ghFukuoka];
    logger.info(`GH合計: ${ghAll.length} 件 (鹿児島: ${ghKagoshima.length}, 福岡: ${ghFukuoka.length})`);

    // 5. 施設定義にマッピング
    const unmappedFacilities: string[] = [];
    const outputRecords: BuildingOutputRecord[] = [];

    // 5a. Kintone → 施設定義マッピング
    for (const kr of kintoneNonGH) {
      const kanamickName = this.mapKintoneFacility(kr, facilityDefs);
      if (!kanamickName) {
        if (!unmappedFacilities.includes(kr.facilityName)) {
          unmappedFacilities.push(kr.facilityName);
        }
        continue;
      }

      outputRecords.push({
        facilityName: kanamickName,
        aozoraId: kr.aozoraId,
        userName: cleanUserName(kr.userName),
        nursingOfficeName: '', // 後でフィルタ時に設定
        moveInDate: formatDateForSheet(kr.contractStartDate),
        moveOutDate: kr.movingOutDate === '9999-12-31' ? '' : formatDateForSheet(kr.movingOutDate),
        isNew: false,
        status: '',
        notes: '',
      });
    }

    // 5b. GH → 施設定義マッピング
    for (const gr of ghAll) {
      const kanamickName = this.mapGHLocation(gr.locationName, facilityDefs);
      if (!kanamickName) {
        const label = `GH:${gr.locationName}`;
        if (!unmappedFacilities.includes(label)) {
          unmappedFacilities.push(label);
        }
        continue;
      }

      outputRecords.push({
        facilityName: kanamickName,
        aozoraId: gr.aozoraId,
        userName: cleanUserName(gr.userName),
        nursingOfficeName: '',
        moveInDate: gr.moveInDate,
        moveOutDate: (gr as any).moveOutDate || '',
        isNew: false,
        status: '',
        notes: '',
      });
    }

    // 6. あおぞらIDで重複除去
    const deduped = this.deduplicateByAozoraId(outputRecords);
    logger.info(`マッピング後: ${outputRecords.length} 件 → 重複除去後: ${deduped.length} 件`);

    if (unmappedFacilities.length > 0) {
      logger.warn(`マッピング不能な施設: ${unmappedFacilities.join(', ')}`);
    }

    // 7. ★ 訪問看護利用実績でフィルタ + 事業所名設定
    const beforeFilter = deduped.length;
    const filtered = this.filterByNursingVisits(deduped, nursingIdMap);
    logger.info(`訪問看護フィルタ: ${beforeFilter} 件 → ${filtered.length} 件 (${beforeFilter - filtered.length} 件除外)`);

    // 8. 前月タブとの比較で新規フラグ判定
    const prevTab = this.getPreviousTab(targetYear, targetMonth);
    await this.markNewRecords(filtered, prevTab);

    // 9. 施設名でソート
    filtered.sort((a, b) => a.facilityName.localeCompare(b.facilityName, 'ja') || a.userName.localeCompare(b.userName, 'ja'));

    // 10. 書き込み
    if (!dryRun) {
      await this.sheets.ensureBuildingMonthlyTab(this.config.buildingMgmtSheetId, tab);
      await this.sheets.writeBuildingMonthlyRecords(this.config.buildingMgmtSheetId, tab, filtered);
    } else {
      logger.info(`[DRY RUN] ${filtered.length} 件の書き込みをスキップ`);
      for (const r of filtered.slice(0, 15)) {
        logger.info(`  ${r.facilityName} | ${r.aozoraId} | ${r.userName} | ${r.nursingOfficeName} | ${r.moveInDate} | ${r.moveOutDate || '-'} | 新規=${r.isNew}`);
      }
      if (filtered.length > 15) {
        logger.info(`  ... 他 ${filtered.length - 15} 件`);
      }
    }

    const result: ExtractionResult = {
      totalRecords: filtered.length,
      newRecords: filtered.filter(r => r.isNew).length,
      filteredByNursing: beforeFilter - filtered.length,
      kintoneRecords: kintoneNonGH.length,
      ghRecords: ghAll.length,
      unmappedFacilities,
      tab,
    };

    logger.info(`=== データ取得完了: ${result.totalRecords} 件 (新規: ${result.newRecords} 件, 訪問看護なし除外: ${result.filteredByNursing} 件) ===`);
    return result;
  }

  // ─── 訪問看護利用実績 ────────────────────────────────────────

  /**
   * 全転記シートから訪問看護利用者のあおぞらIDを事業所別に取得
   * @returns Map<事業所名, Set<あおぞらID>>
   */
  private async buildNursingVisitMap(transcriptionTab: string): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    const promises = this.config.nursingSheetLocations.map(async (loc) => {
      const ids = await this.sheets.getVisitedAozoraIds(loc.sheetId, transcriptionTab);
      logger.info(`  転記シート「${loc.name}」: ${ids.size} 名の訪問看護利用者`);
      map.set(loc.officeName, ids);
    });
    await Promise.all(promises);
    return map;
  }

  /**
   * 訪問看護利用実績でフィルタし、利用訪問看護事業所名を設定
   *
   * - 入居者のあおぞらIDが転記シートに存在する → 対象（訪問看護を利用）
   * - 複数事業所で利用 → カンマ区切りで全事業所名を設定
   * - 転記シートに存在しない → 除外（訪問看護を利用していない）
   */
  private filterByNursingVisits(
    records: BuildingOutputRecord[],
    nursingIdMap: Map<string, Set<string>>,
  ): BuildingOutputRecord[] {
    const result: BuildingOutputRecord[] = [];
    for (const r of records) {
      const officeNames: string[] = [];
      for (const [officeName, ids] of nursingIdMap) {
        if (ids.has(r.aozoraId)) {
          officeNames.push(officeName);
        }
      }
      if (officeNames.length > 0) {
        r.nursingOfficeName = officeNames.join(', ');
        result.push(r);
      }
    }
    return result;
  }

  // ─── Kintone 施設名マッピング ────────────────────────────────

  /**
   * Kintone の Facility_Name (e.g. "南栄・有料", "小松原・ＧＨ") から
   * 施設定義のカナミック施設名にマッピングする。
   *
   * ロジック:
   *   1. "・" で分割 → 拠点名 = 前半、種別 = 後半
   *   2. 種別が "有料", "特養" 等 → 施設定義 A列 (有料老人ホーム系) で検索
   *   3. 種別が "ＧＨ", "認知" 等 → 施設定義 B列 (GH系) で検索
   *   4. 拠点名が施設定義の名前に含まれているか照合
   */
  private mapKintoneFacility(record: KintoneResidentRecord, defs: FacilityDefinition[]): string | null {
    const fname = record.facilityName;

    // 1. ハードコード特殊ケースを先にチェック
    if (KINTONE_SPECIAL_MAPPINGS[fname]) {
      return KINTONE_SPECIAL_MAPPINGS[fname];
    }

    const parts = fname.split('・');
    // "南栄・有料" → location="南栄", type="有料"
    // "野芥1・有料" → location="野芥1", type="有料"
    const location = parts.length >= 2 ? parts[0] : fname;
    const typeStr = parts.length >= 2 ? parts.slice(1).join('・') : '';

    // 全角→半角変換してマッチングしやすくする
    const normalizedLocation = normalizeForMatch(location);
    // 末尾の数字を除去したバージョン（"野芥1" → "野芥"）
    const normalizedLocationNoDigit = normalizedLocation.replace(/\d+$/, '');

    // 2. 施設定義 A列/B列 で検索（完全一致優先）
    for (const candidate of [normalizedLocation, normalizedLocationNoDigit]) {
      if (!candidate) continue;
      for (const def of defs) {
        const normA = normalizeForMatch(def.sourceNameA);
        const normB = normalizeForMatch(def.sourceNameB);

        if (normA && normA.includes(candidate)) {
          return def.kanamickName;
        }
        if (normB && normB.includes(candidate)) {
          return def.kanamickName;
        }
      }
    }

    // 3. フォールバック: カナミック施設名に拠点名が含まれる
    for (const candidate of [normalizedLocation, normalizedLocationNoDigit]) {
      if (!candidate) continue;
      for (const def of defs) {
        if (normalizeForMatch(def.kanamickName).includes(candidate)) {
          return def.kanamickName;
        }
      }
    }

    logger.warn(`施設マッピング不能: "${fname}" (拠点=${location}, 種別=${typeStr}, 事業=${record.providedBusiness})`);
    return null;
  }

  // ─── GH 拠点名マッピング ────────────────────────────────────

  /**
   * GHの拠点名 (e.g. "宇宿", "小松原") から
   * 施設定義B列（共同生活援助系）でカナミック施設名にマッピング
   */
  private mapGHLocation(locationName: string, defs: FacilityDefinition[]): string | null {
    // 1. ハードコード特殊ケースを先にチェック
    if (GH_SPECIAL_MAPPINGS[locationName]) {
      return GH_SPECIAL_MAPPINGS[locationName];
    }

    const normalized = normalizeForMatch(locationName);

    // 2. B列で検索
    for (const def of defs) {
      if (def.sourceNameB && normalizeForMatch(def.sourceNameB).includes(normalized)) {
        return def.kanamickName;
      }
    }

    // 3. フォールバック: カナミック施設名に拠点名が含まれる
    for (const def of defs) {
      if (normalizeForMatch(def.kanamickName).includes(normalized)) {
        return def.kanamickName;
      }
    }

    logger.warn(`GH拠点マッピング不能: "${locationName}"`);
    return null;
  }

  // ─── 重複除去 ────────────────────────────────────────────

  /**
   * あおぞらIDで重複を除去。
   * 同一IDで複数施設に入居している場合（月途中転居）は両方残す。
   */
  private deduplicateByAozoraId(records: BuildingOutputRecord[]): BuildingOutputRecord[] {
    const seen = new Map<string, BuildingOutputRecord[]>();
    for (const r of records) {
      const key = `${r.aozoraId}_${r.facilityName}`;
      const existing = seen.get(key);
      if (existing) {
        // 同一施設+同一IDの完全重複 → スキップ
        logger.debug(`重複スキップ: ${r.userName} (ID:${r.aozoraId}) @ ${r.facilityName}`);
      } else {
        seen.set(key, [r]);
      }
    }
    return Array.from(seen.values()).map(arr => arr[0]);
  }

  // ─── 新規フラグ判定 ────────────────────────────────────────

  /**
   * 前月タブのデータと比較し、前月にいなかったレコードを新規としてマーク
   */
  private async markNewRecords(records: BuildingOutputRecord[], prevTab: string): Promise<void> {
    try {
      const prevRecords = await this.sheets.getBuildingManagementRecords(this.config.buildingMgmtSheetId, prevTab);
      const prevIds = new Set(prevRecords.map(r => r.aozoraId));

      let newCount = 0;
      for (const r of records) {
        if (!prevIds.has(r.aozoraId)) {
          r.isNew = true;
          newCount++;
        }
      }
      logger.info(`新規フラグ: ${newCount} 件 (前月タブ「${prevTab}」に ${prevRecords.length} 件)`);
    } catch {
      // 前月タブが存在しない場合（初回実行）→ 全て新規
      logger.info(`前月タブ「${prevTab}」が見つかりません。全レコードを新規としてマークします。`);
      for (const r of records) {
        r.isNew = true;
      }
    }
  }

  /**
   * 前月のタブ名を計算
   * e.g. (2026, 2) → "2026/01", (2026, 1) → "2025/12"
   */
  private getPreviousTab(year: number, month: number): string {
    if (month === 1) {
      return `${year - 1}/12`;
    }
    return `${year}/${String(month - 1).padStart(2, '0')}`;
  }
}

// ─── ユーティリティ ────────────────────────────────────────

/**
 * 利用者名のクリーニング
 * GASコードと同一ルール:
 *   1. 末尾の「様」を削除
 *   2. 半角・全角スペースを全て削除
 */
function cleanUserName(name: string): string {
  return name
    .replace(/様$/, '')
    .replace(/[\s\u3000]/g, '');
}

/**
 * マッチング用の正規化
 * 全角英数→半角、カタカナの長音等を統一
 */
function normalizeForMatch(str: string): string {
  return str
    .replace(/[\s\u3000]/g, '')  // スペース除去
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))  // 全角→半角
    .toLowerCase();
}

/**
 * ISO日付 "2026-02-15" → シート表示形式 "2026/02/15"
 */
function formatDateForSheet(isoDate: string): string {
  if (!isoDate) return '';
  return isoDate.replace(/-/g, '/');
}
