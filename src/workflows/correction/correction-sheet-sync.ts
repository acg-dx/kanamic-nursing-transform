/**
 * 修正管理シート駆動の修正同期
 *
 * 修正管理シート（看護記録修正管理）の「上書きOK」かつ未処理のレコードを読み取り、
 * 月次シートの該当レコードに「修正あり」フラグを強制設定する。
 *
 * これにより updatedAt > dataFetchedAt のタイミング問題で修正が見逃されるバグを防止する。
 * 修正管理シートが「信頼できる唯一の情報源（Single Source of Truth）」として機能する。
 */
import { logger } from '../../core/logger';
import { SpreadsheetService } from '../../services/spreadsheet.service';
import type { TranscriptionRecord, CorrectionRecord } from '../../types/spreadsheet.types';

// ─── changeDetail パーサー ───

export interface ChangeDetailField {
  /** フィールド名 (e.g., '開始時間', '日付', '利用者') */
  field: string;
  oldValue: string;
  newValue: string;
}

/** 突合キーに影響するフィールド名 → TranscriptionRecord プロパティ名 */
const KEY_FIELD_MAP: Record<string, 'startTime' | 'visitDate' | 'patientName'> = {
  '開始時間': 'startTime',
  '日付': 'visitDate',
  '利用者': 'patientName',
};

/**
 * changeDetail からフィールド単位の変更を抽出する。
 *
 * 対応フォーマット:
 *   - 【開始時間】16:13→16:00
 *   - 【日付】2026-04-04→2026-04-03
 *   - 【利用者】旧名→新名
 *   - 複数変更は改行区切り
 *
 * 「転記後データ変更: ...」のような非構造化テキストは空配列を返す。
 */
export function parseChangeDetail(changeDetail: string): ChangeDetailField[] {
  const results: ChangeDetailField[] = [];
  // → (U+2192) が標準セパレータ。全角・半角矢印もフォールバック許容
  const regex = /【([^】]+)】\s*(.+?)\s*(?:→|->|＝＞|=>)\s*([^\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(changeDetail)) !== null) {
    results.push({
      field: match[1].trim(),
      oldValue: match[2].trim(),
      newValue: match[3].trim(),
    });
  }
  // 【...】 形式があるのにパース結果が空 → フォーマット不正の可能性を警告
  if (results.length === 0 && changeDetail.includes('【')) {
    logger.warn(`parseChangeDetail: 【】形式を検出したがパース結果が空です: ${changeDetail.substring(0, 80)}`);
  }
  return results;
}

/** changeDetail のフィールドが突合キー（患者名/日付/開始時刻）に影響するか判定 */
export function isKeyFieldChange(field: string): boolean {
  return field in KEY_FIELD_MAP;
}

/** changeDetail のフィールド名 → TranscriptionRecord プロパティ名 */
export function getKeyFieldName(field: string): 'startTime' | 'visitDate' | 'patientName' | undefined {
  return KEY_FIELD_MAP[field];
}

/**
 * 現在の Sheet レコードの値をベースに、changeDetail のキー変更分だけ旧値で上書きした
 * 不変オブジェクトを返す。変更がなければ現在の値をそのまま返す。
 */
export function buildOldKeyValues(
  current: { patientName: string; visitDate: string; startTime: string },
  keyChanges: readonly ChangeDetailField[],
): { patientName: string; visitDate: string; startTime: string } {
  let { patientName, visitDate, startTime } = current;
  for (const change of keyChanges) {
    const prop = getKeyFieldName(change.field);
    if (prop === 'patientName') patientName = change.oldValue;
    else if (prop === 'visitDate') visitDate = change.oldValue;
    else if (prop === 'startTime') startTime = change.oldValue;
  }
  return { patientName, visitDate, startTime };
}

/**
 * 修正管理シートと月次シートを同期するユーティリティ。
 *
 * processLocation 内で転記ループ前に呼び出し、
 * 修正管理シートの未処理レコードで月次シートのフラグを強制設定する。
 */
export class CorrectionSheetSync {
  private sheets: SpreadsheetService;

  constructor(sheets: SpreadsheetService) {
    this.sheets = sheets;
  }

  /**
   * 修正管理シートから未処理の「上書きOK」レコードを取得
   */
  async getUnprocessedCorrections(sheetId: string): Promise<CorrectionRecord[]> {
    const allCorrections = await this.sheets.getCorrectionRecords(sheetId);
    return allCorrections.filter(c =>
      c.status === '上書きOK' && c.processedFlag !== '1'
    );
  }

  /**
   * 未処理の修正レコードを月次シートのレコードに適用する。
   *
   * - recordId が一致
   * - 月次シートで転記済み (hamAssignId が存在)
   * → transcriptionFlag を「修正あり」に強制設定 + ロック解除
   *
   * @returns recordId → 修正管理レコードの rowIndex 配列のマップ
   *          （転記成功後に処理済みマークを付けるために使用）
   */
  async applyCorrectionsToRecords(
    corrections: readonly CorrectionRecord[],
    records: TranscriptionRecord[],
    sheetId: string,
    tab?: string,
  ): Promise<Map<string, number[]>> {
    const correctionMap = new Map<string, number[]>();

    if (corrections.length === 0) return correctionMap;

    // recordId → TranscriptionRecord のインデックスマップ
    const recordsByRecordId = new Map<string, TranscriptionRecord>();
    for (const r of records) {
      recordsByRecordId.set(r.recordId, r);
    }

    let appliedCount = 0;
    let unlockedCount = 0;

    for (const corr of corrections) {
      const record = recordsByRecordId.get(corr.recordId);

      if (!record) {
        logger.debug(`修正管理同期: recordId=${corr.recordId} (${corr.patientName}) が月次シートに存在しません（別月度の可能性）`);
        continue;
      }

      if (!record.hamAssignId) {
        logger.debug(`修正管理同期: recordId=${corr.recordId} (${corr.patientName}) は hamAssignId 未設定（未転記 or 削除済み）→ スキップ`);
        continue;
      }

      // 既に「修正あり」なら重複設定しないが、ロック済みなら転記対象に戻す。
      if (record.transcriptionFlag !== '修正あり') {
        if (record.transcriptionFlag !== '転記済み') {
          logger.debug(`修正管理同期: recordId=${corr.recordId} (${corr.patientName}) は転記フラグ="${record.transcriptionFlag}" → スキップ`);
          continue;
        }

        // I列='1' かつ T列='転記済み' → 看護記録転記が月次sheetを覆盖済み、かつ RPA も再転記完了
        // この場合は「修正あり」に戻さない（不要な再転記を防止）
        // COR-01 で CSV 照合後に G='処理済み' + J='1' が書き込まれる
        if (corr.overwriteDone === '1') {
          logger.info(
            `修正管理同期: recordId=${corr.recordId} (${corr.patientName}) ` +
            `→ I列=1(上書き済み) かつ 転記済み — 再転記スキップ（COR-01 で CSV 検証予定）`
          );
          // correctionMap には追加しない（COR-01 が直接処理する）
          continue;
        }

        // ロック解除 + フラグ強制設定
        if (record.recordLocked) {
          await this.sheets.unlockRecord(sheetId, record.rowIndex, tab);
          record.recordLocked = false;
        }
        await this.sheets.updateTranscriptionStatus(sheetId, record.rowIndex, '修正あり', undefined, tab);
        record.transcriptionFlag = '修正あり';

        logger.info(
          `修正管理同期: recordId=${corr.recordId} (${corr.patientName}) ` +
          `→ 「修正あり」に強制設定 (変更: ${corr.changeDetail.replace(/\n/g, ', ')})`
        );
        appliedCount++;
      } else if (record.recordLocked) {
        await this.sheets.unlockRecord(sheetId, record.rowIndex, tab);
        record.recordLocked = false;
        unlockedCount++;
        logger.info(
          `修正管理同期: recordId=${corr.recordId} (${corr.patientName}) ` +
          `→ 既存「修正あり」のロック解除 (変更: ${corr.changeDetail.replace(/\n/g, ', ')})`
        );
      }

      // correctionMap に追加（転記成功後の処理済みマーク用）
      const existing = correctionMap.get(corr.recordId) || [];
      existing.push(corr.rowIndex);
      correctionMap.set(corr.recordId, existing);
    }

    if (appliedCount > 0) {
      logger.info(`修正管理同期: ${appliedCount}件のレコードを「修正あり」に設定`);
    }
    if (unlockedCount > 0) {
      logger.info(`修正管理同期: ${unlockedCount}件の既存「修正あり」レコードをロック解除`);
    }
    if (appliedCount === 0 && unlockedCount === 0 && corrections.length > 0) {
      logger.debug(`修正管理同期: 未処理修正 ${corrections.length}件あるが、適用対象なし`);
    }

    return correctionMap;
  }

  /**
   * 転記成功後に、修正管理レコードを「処理済み」にマークする
   */
  async markProcessed(sheetId: string, correctionRowIndexes: number[]): Promise<void> {
    for (const rowIndex of correctionRowIndexes) {
      try {
        await this.sheets.markCorrectionProcessed(sheetId, rowIndex);
      } catch (error) {
        // マーク失敗は致命的ではない（次回実行時に再処理される = 冪等）
        logger.warn(`修正管理処理済みマーク失敗 (row=${rowIndex}): ${(error as Error).message}`);
      }
    }
  }
}
