/**
 * Kintone REST API サービス
 *
 * 居室利用変更履歴管理アプリ (App 197) からデータを取得し、
 * 同一建物管理の入居者データとして返す。
 */
import { logger } from '../core/logger';

export interface KintoneConfig {
  baseUrl: string;    // e.g. https://acgaozora.cybozu.com
  appId: number;      // e.g. 197
  apiToken: string;
}

/** Kintone から取得した居室利用変更レコード */
export interface KintoneResidentRecord {
  recordId: string;
  facilityName: string;       // e.g. "南栄・有料", "小松原・ＧＨ"
  userName: string;           // e.g. "川畑　佐江子様"
  aozoraId: string;           // e.g. "8691"
  contractStartDate: string;  // e.g. "2026-02-02"
  movingOutDate: string;      // e.g. "9999-12-31" or "2025-06-28"
  providedBusiness: string;   // e.g. "高齢者施設", "共同生活援助"
}

export class KintoneService {
  private config: KintoneConfig;

  constructor(config: KintoneConfig) {
    this.config = config;
  }

  /**
   * 指定月に入居中の全利用者を取得
   *
   * 条件:
   *   - 契約適用開始日 <= targetMonth末日
   *   - 退去日 >= targetMonth1日 or 退去日 = "9999-12-31"（未退去）
   */
  async getResidents(targetYear: number, targetMonth: number): Promise<KintoneResidentRecord[]> {
    const firstDay = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
    const lastDay = this.getLastDayOfMonth(targetYear, targetMonth);

    // Kintone query: 契約開始日が対象月末以前 AND 退去日が対象月初日以降
    const query = `Contract_Start_Date <= "${lastDay}" and Moving_Out_Date >= "${firstDay}" order by Facility_Name asc`;

    const fields = [
      'Facility_Name', 'User_Name', 'Aozora_Id',
      'Contract_Start_Date', 'Moving_Out_Date', 'Provided_Business',
    ];

    const allRecords: KintoneResidentRecord[] = [];
    let offset = 0;
    const limit = 500;

    while (true) {
      const params = new URLSearchParams();
      params.set('app', String(this.config.appId));
      params.set('query', `${query} limit ${limit} offset ${offset}`);
      for (const f of fields) {
        params.append('fields[]', f);
      }

      const url = `${this.config.baseUrl}/k/v1/records.json?${params.toString()}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'X-Cybozu-API-Token': this.config.apiToken },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Kintone API エラー (${response.status}): ${body}`);
      }

      const data = await response.json() as { records: Record<string, { value: string }>[] };
      if (!data.records || data.records.length === 0) break;

      for (const r of data.records) {
        allRecords.push({
          recordId: r['$id']?.value || '',
          facilityName: r.Facility_Name?.value || '',
          userName: r.User_Name?.value || '',
          aozoraId: r.Aozora_Id?.value || '',
          contractStartDate: r.Contract_Start_Date?.value || '',
          movingOutDate: r.Moving_Out_Date?.value || '',
          providedBusiness: r.Provided_Business?.value || '',
        });
      }

      logger.debug(`Kintone: ${allRecords.length} 件取得済み (offset=${offset})`);
      offset += limit;
      if (data.records.length < limit) break;
    }

    logger.info(`Kintone App ${this.config.appId}: ${allRecords.length} 件取得完了 (${firstDay} 〜 ${lastDay})`);
    return allRecords;
  }

  private getLastDayOfMonth(year: number, month: number): string {
    const d = new Date(year, month, 0); // month is 1-based, but Date(year, month, 0) gives last day of month
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
