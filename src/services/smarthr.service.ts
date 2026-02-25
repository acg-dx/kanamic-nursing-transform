import { logger } from '../core/logger';
import type { SmartHRConfig, SmartHRCrew, SmartHRDepartment, StaffMasterEntry } from '../types/smarthr.types';

const DEFAULT_BASE_URL = 'https://acg.smarthr.jp/api/v1';
const PER_PAGE = 100;

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

  async getDepartments(): Promise<SmartHRDepartment[]> {
    const url = `${this.baseUrl}/departments`;
    const response = await fetch(url, { headers: this.headers });

    if (!response.ok) {
      throw new Error(`SmartHR 部署取得エラー: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<SmartHRDepartment[]>;
  }

  toStaffMasterEntry(crew: SmartHRCrew): StaffMasterEntry {
    return {
      staffNumber: crew.emp_code || '',
      staffName: `${crew.last_name} ${crew.first_name}`.trim(),
      staffNameYomi: `${crew.last_name_yomi} ${crew.first_name_yomi}`.trim(),
      qualifications: [], // SmartHRのカスタムフィールドから資格情報を取得する場合はここで処理
    };
  }
}
