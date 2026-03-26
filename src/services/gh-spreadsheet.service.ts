/**
 * 共同生活援助 (GH) スプレッドシート解析サービス
 *
 * 鹿児島・福岡の共同生活援助入居者情報を「入居日」「退去日」タブから解析する。
 * データソース:
 *   - GH_SHEET_ID_KAGOSHIMA: 鹿児島（12拠点、~147名有効）
 *   - GH_SHEET_ID_FUKUOKA: 福岡（1拠点 野芥、~22名有効）
 *
 * 入居日タブ構造 (2列並行レイアウト):
 *   A: "拠点名 部屋番号 利用者名(ID:あおぞらID)"
 *   B: 入居日 "2023/05/26(金)"
 *   F: ステータス "1.有効" / "2.無効"
 *   H-M: 同じ構造の2人目データ（H=名前, I=入居日, M=ステータス）
 *
 * 退去日タブ構造:
 *   A: 記録名
 *   B: "拠点名 部屋番号 利用者名(ID:xxx)"
 *   C: 区分 (退去/自社内転居/入院退去/外泊退去)
 *   D: 退去日
 */
import { google, sheets_v4 } from 'googleapis';
import { logger } from '../core/logger';

/** GH入居者の生データ（入居日タブから解析） */
export interface GHResidentRaw {
  /** 拠点名 e.g. "宇宿", "小松原", "野芥" */
  locationName: string;
  /** 利用者名（スペース等含む生値） */
  userName: string;
  /** あおぞらID e.g. "5939" */
  aozoraId: string;
  /** 入居日 e.g. "2023/05/26" (曜日除去済み) */
  moveInDate: string;
  /** ステータス: true=有効 */
  isActive: boolean;
  /** ソースシート: "kagoshima" | "fukuoka" */
  source: 'kagoshima' | 'fukuoka';
}

/** GH退去記録（退去日タブから解析） */
export interface GHMoveOutRecord {
  /** 拠点名 */
  locationName: string;
  /** 利用者名 */
  userName: string;
  /** あおぞらID */
  aozoraId: string;
  /** 区分: 退去 / 自社内転居 / 入院退去 / 外泊退去 */
  category: string;
  /** 退去日 e.g. "2025/06/28" */
  moveOutDate: string;
  /** ソースシート */
  source: 'kagoshima' | 'fukuoka';
}

/**
 * "拠点名 部屋番号 利用者名(ID:あおぞらID)" をパースする
 * 例: "宇宿 102 前原まゆみ(ID:5939)" → { locationName: "宇宿", userName: "前原まゆみ", aozoraId: "5939" }
 */
function parseResidentCell(cell: string): { locationName: string; userName: string; aozoraId: string } | null {
  if (!cell || !cell.trim()) return null;
  // パターン: 拠点名 部屋番号(任意) 利用者名(ID:数字)
  const match = cell.trim().match(/^(\S+)\s+\S+\s+(.+?)\(ID:(\d+)\)$/);
  if (match) {
    return { locationName: match[1], userName: match[2].trim(), aozoraId: match[3] };
  }
  // 部屋番号なしパターン: "拠点名 利用者名(ID:数字)"
  const match2 = cell.trim().match(/^(\S+)\s+(.+?)\(ID:(\d+)\)$/);
  if (match2) {
    return { locationName: match2[1], userName: match2[2].trim(), aozoraId: match2[3] };
  }
  return null;
}

/**
 * 入居日文字列から日付部分を抽出
 * "2023/05/26(金)" → "2023/05/26"
 * "2023/05/26" → "2023/05/26"
 */
function parseDateCell(cell: string): string {
  if (!cell) return '';
  const match = cell.trim().match(/^(\d{4}\/\d{1,2}\/\d{1,2})/);
  return match ? match[1] : cell.trim();
}

export class GHSpreadsheetService {
  private sheets: sheets_v4.Sheets;

  constructor(serviceAccountKeyPath: string) {
    const auth = new google.auth.GoogleAuth({
      keyFile: serviceAccountKeyPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    this.sheets = google.sheets({ version: 'v4', auth });
  }

  /**
   * 入居日タブから全有効入居者を取得
   */
  async getResidents(sheetId: string, source: 'kagoshima' | 'fukuoka'): Promise<GHResidentRaw[]> {
    const range = '入居日!A:M';
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });
      const rows = response.data.values || [];
      const residents: GHResidentRaw[] = [];

      for (const row of rows) {
        // 左側（A-F列）: A=名前, B=入居日, F=ステータス
        const left = parseResidentCell(row[0]);
        if (left) {
          residents.push({
            ...left,
            moveInDate: parseDateCell(row[1]),
            isActive: (row[5] || '').startsWith('1'),
            source,
          });
        }

        // 右側（H-M列 = index 7-12）: H=名前, I=入居日, M=ステータス
        const right = parseResidentCell(row[7]);
        if (right) {
          residents.push({
            ...right,
            moveInDate: parseDateCell(row[8]),
            isActive: (row[12] || '').startsWith('1'),
            source,
          });
        }
      }

      logger.info(`GH入居者 (${source}): ${residents.length} 件取得 (有効: ${residents.filter(r => r.isActive).length} 件)`);
      return residents;
    } catch (error) {
      logger.error(`GH入居日取得エラー (${source}): ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 退去日タブから退去記録を取得
   */
  async getMoveOutRecords(sheetId: string, source: 'kagoshima' | 'fukuoka'): Promise<GHMoveOutRecord[]> {
    const range = '退去日!A:D';
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range,
      });
      const rows = response.data.values || [];
      const records: GHMoveOutRecord[] = [];

      for (const row of rows) {
        // B列: "拠点名 部屋番号 利用者名(ID:xxx)"
        const parsed = parseResidentCell(row[1]);
        if (!parsed) continue;

        const category = (row[2] || '').trim();
        const moveOutDate = parseDateCell(row[3]);
        if (!moveOutDate) continue;

        records.push({
          ...parsed,
          category,
          moveOutDate,
          source,
        });
      }

      logger.info(`GH退去記録 (${source}): ${records.length} 件取得`);
      return records;
    } catch (error) {
      logger.error(`GH退去日取得エラー (${source}): ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 指定月に入居中の全利用者を取得（入居日 + 退去日を結合）
   *
   * 条件:
   *   - 入居日 <= 対象月末日
   *   - 退去日 >= 対象月1日 or 退去記録なし（有効ステータス）
   *   - ステータスが有効 or 対象月内に退去記録あり
   */
  async getActiveResidents(
    sheetId: string,
    source: 'kagoshima' | 'fukuoka',
    targetYear: number,
    targetMonth: number,
  ): Promise<Array<GHResidentRaw & { moveOutDate?: string; moveOutCategory?: string }>> {
    const [residents, moveOuts] = await Promise.all([
      this.getResidents(sheetId, source),
      this.getMoveOutRecords(sheetId, source),
    ]);

    const targetFirstDay = new Date(targetYear, targetMonth - 1, 1);
    const targetLastDay = new Date(targetYear, targetMonth, 0); // 末日

    // 退去記録をあおぞらIDでインデックス化（複数退去あり得る → 直近を採用）
    const moveOutMap = new Map<string, GHMoveOutRecord>();
    for (const mo of moveOuts) {
      const existing = moveOutMap.get(mo.aozoraId);
      if (!existing || mo.moveOutDate > (existing.moveOutDate || '')) {
        moveOutMap.set(mo.aozoraId, mo);
      }
    }

    const results: Array<GHResidentRaw & { moveOutDate?: string; moveOutCategory?: string }> = [];

    for (const r of residents) {
      // 入居日が対象月末より後 → 対象外
      const moveInDate = parseStandardDate(r.moveInDate);
      if (moveInDate && moveInDate > targetLastDay) continue;

      const mo = moveOutMap.get(r.aozoraId);

      if (mo) {
        // 退去記録あり
        const moDate = parseStandardDate(mo.moveOutDate);
        if (moDate && moDate < targetFirstDay) continue; // 対象月より前に退去 → 対象外

        results.push({
          ...r,
          moveOutDate: mo.moveOutDate,
          moveOutCategory: mo.category,
        });
      } else if (r.isActive) {
        // 退去記録なし & 有効 → 対象
        results.push(r);
      }
      // 退去記録なし & 無効 → 対象外（既に退去済みだが記録不備）
    }

    logger.info(`GH対象利用者 (${source}): ${results.length} 件 (${targetYear}/${String(targetMonth).padStart(2, '0')})`);
    return results;
  }
}

/**
 * "2023/05/26" → Date オブジェクト
 */
function parseStandardDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
