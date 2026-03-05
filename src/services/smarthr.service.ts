import { logger } from '../core/logger';
import type { SmartHRConfig, SmartHRCrew, SmartHRDepartment, StaffMasterEntry } from '../types/smarthr.types';

const DEFAULT_BASE_URL = 'https://acg.smarthr.jp/api/v1';
const PER_PAGE = 100;

/**
 * SmartHR カスタムフィールドIDマッピング（smarthr.txt参照）
 */
const CUSTOM_FIELD_IDS: Record<string, string> = {
  '資格1': '21289acb-d3f2-4ed7-84aa-5c42d0096c0d',
  '資格2': '14fe29ec-d0ef-4895-8121-901bd49b892e',
  '資格3': '773fbe7d-3457-4dc6-b702-5f0448432632',
  '資格4': 'e8be0014-51a3-4125-8506-80915529f9fa',
  '資格5': '3fa29e52-367d-4908-88a1-86a68a999a21',
  '資格6': '1631fb4c-93dd-4453-a74c-fd16d8e2edc3',
  '資格7': '4bc6b84d-45e1-498e-bc5f-1302b3b3f5d0',
  '資格8': '356e88dc-5bef-46f0-af3e-7ea34e83ded3',
  '就業時間帯': '5b919c90-8036-462a-9660-3cc1f64c7af9',
  '役職_等級_': 'a19c8286-2386-401f-b121-300024e227a6',
  '職種': '9dca2a4b-78e1-4bb0-97dd-389e13d99b0e',
  '入社取消日': '6a94a506-5c64-4344-8f37-26507e0db768',
};

export class SmartHRService {
  private config: SmartHRConfig;

  constructor(config: SmartHRConfig) {
    this.config = config;
  }

  private get baseUrl(): string {
    return this.config.baseUrl || DEFAULT_BASE_URL;
  }

  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.config.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * 全従業員を取得（ページネーション対応）
   */
  async getAllCrews(): Promise<SmartHRCrew[]> {
    const allCrews: SmartHRCrew[] = [];
    let page = 1;
    let totalCount = 0;

    do {
      const url = `${this.baseUrl}/crews?per_page=${PER_PAGE}&page=${page}`;
      logger.debug(`SmartHR: クルー取得 page=${page}`);

      const response = await fetch(url, { headers: this.headers });

      if (!response.ok) {
        throw new Error(`SmartHR API エラー: ${response.status} ${response.statusText}`);
      }

      const totalHeader = response.headers.get('x-total-count');
      if (totalHeader) {
        totalCount = parseInt(totalHeader, 10);
      }

      const crews = await response.json() as SmartHRCrew[];
      allCrews.push(...crews);

      logger.debug(`SmartHR: ${allCrews.length}/${totalCount} クルー取得済み`);

      if (allCrews.length >= totalCount) break;
      page++;
    } while (true);

    logger.info(`SmartHR: 合計 ${allCrews.length} クルー取得完了`);
    return allCrews;
  }

  /**
   * 従業員番号 (emp_code) で単一のクルーを検索
   * SmartHR API は `emp_code` クエリパラメータで完全一致検索をサポート。
   */
  async getCrewByEmpCode(empCode: string): Promise<SmartHRCrew | null> {
    const url = `${this.baseUrl}/crews?per_page=1&page=1&emp_code=${encodeURIComponent(empCode)}`;
    logger.debug(`SmartHR: emp_code=${empCode} で検索`);

    const response = await fetch(url, { headers: this.headers });
    if (!response.ok) {
      throw new Error(`SmartHR API エラー: ${response.status} ${response.statusText}`);
    }

    const crews = await response.json() as SmartHRCrew[];
    if (crews.length > 0 && crews[0].emp_code === empCode) {
      logger.debug(`SmartHR: emp_code=${empCode} → ${crews[0].last_name} ${crews[0].first_name}`);
      return crews[0];
    }

    logger.debug(`SmartHR: emp_code=${empCode} に一致するクルーなし`);
    return null;
  }

  /**
   * 複数の従業員番号で一括検索
   */
  async getCrewsByEmpCodes(empCodes: string[]): Promise<Map<string, SmartHRCrew>> {
    const result = new Map<string, SmartHRCrew>();
    for (const code of empCodes) {
      try {
        const crew = await this.getCrewByEmpCode(code);
        if (crew) result.set(code, crew);
      } catch (err) {
        logger.warn(`SmartHR 検索エラー (emp_code=${code}): ${(err as Error).message}`);
      }
    }
    return result;
  }

  /**
   * 部署一覧を取得
   */
  async getDepartments(): Promise<SmartHRDepartment[]> {
    const url = `${this.baseUrl}/departments`;
    const response = await fetch(url, { headers: this.headers });

    if (!response.ok) {
      throw new Error(`SmartHR 部署取得エラー: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<SmartHRDepartment[]>;
  }

  /**
   * カスタムフィールドから値を取得（テキスト型）
   */
  getCustomFieldValue(crew: SmartHRCrew, fieldName: string): string | null {
    const fieldId = CUSTOM_FIELD_IDS[fieldName];
    if (!fieldId || !crew.custom_fields) return null;

    const field = crew.custom_fields.find(
      cf => cf.template?.id === fieldId
    );
    return field?.value ?? null;
  }

  /**
   * カスタムフィールドからオプション型の値を取得（表示名を返す）
   * SmartHRのオプション型フィールドは physical_name が value に入り、
   * template.elements[].name が表示名
   */
  getCustomOptionFieldValue(crew: SmartHRCrew, fieldName: string): string | null {
    const fieldId = CUSTOM_FIELD_IDS[fieldName];
    if (!fieldId || !crew.custom_fields) return null;

    const field = crew.custom_fields.find(
      cf => cf.template?.id === fieldId
    );
    if (!field || !field.value) return null;

    // オプション型の場合、template.elements から表示名を取得
    if (field.template?.elements) {
      const option = field.template.elements.find(e => e.physical_name === field.value);
      if (option) return option.name;
    }

    // テンプレート情報がない場合は value をそのまま返す
    return field.value;
  }

  /**
   * 資格1〜8 のリストを取得
   */
  getQualifications(crew: SmartHRCrew): string[] {
    const qualifications: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const q = this.getCustomOptionFieldValue(crew, `資格${i}`);
      if (q) qualifications.push(q);
    }
    return qualifications;
  }

  /**
   * 部署名を取得（departments[0].name）
   */
  getDepartmentName(crew: SmartHRCrew): string {
    if (!crew.departments || crew.departments.length === 0) return '';
    const d = crew.departments[0];
    return (d && d.name) || '';
  }

  /**
   * 部署のフル階層パスを取得
   */
  getDepartmentFullPath(crew: SmartHRCrew): string[] {
    if (!crew.departments || crew.departments.length === 0) return [];
    return this.flattenDepartment(crew.departments[0]);
  }

  /**
   * 部署の入れ子構造をフラット配列に変換
   */
  private flattenDepartment(dept: SmartHRDepartment | null, maxLevel = 3): string[] {
    if (!dept) return [];
    const result: string[] = [];
    const flatten = (d: SmartHRDepartment | null, level: number): void => {
      if (!d || level <= 0) return;
      if (d.parent) flatten(d.parent as unknown as SmartHRDepartment, level - 1);
      result.push(d.name);
    };
    flatten(dept, maxLevel);
    return result;
  }

  /**
   * 特定部署名を含むクルーのみフィルタ
   */
  filterByDepartment(crews: SmartHRCrew[], departmentKeyword: string): SmartHRCrew[] {
    return crews.filter(crew => {
      if (!crew.departments) return false;
      return crew.departments.some(dept => {
        const path = this.flattenDepartment(dept);
        return path.some(name => name.includes(departmentKeyword));
      });
    });
  }

  /**
   * 退職済みでないクルーのみフィルタ
   */
  filterActive(crews: SmartHRCrew[]): SmartHRCrew[] {
    return crews.filter(crew => !crew.resigned_at);
  }

  /**
   * クルーをスタッフマスタエントリに変換
   */
  toStaffMasterEntry(crew: SmartHRCrew): StaffMasterEntry {
    const businessName = crew.business_last_name && crew.business_first_name
      ? `${crew.business_last_name} ${crew.business_first_name}`.trim()
      : '';
    const legalName = `${crew.last_name} ${crew.first_name}`.trim();

    return {
      staffNumber: crew.emp_code || '',
      staffName: businessName || legalName,
      staffNameLegal: legalName,
      staffNameYomi: `${crew.last_name_yomi} ${crew.first_name_yomi}`.trim(),
      gender: crew.gender || '',
      qualifications: this.getQualifications(crew),
      departmentName: this.getDepartmentName(crew),
      enteredAt: crew.entered_at || '',
      resignedAt: crew.resigned_at || '',
    };
  }
}
