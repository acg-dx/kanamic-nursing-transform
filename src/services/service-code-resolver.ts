/**
 * サービスコード決定エンジン
 *
 * Google Sheets の転記レコード (serviceType1, serviceType2, 各フラグ) から
 * HAM k2_3a ページで選択すべきサービスコードパラメータを決定する。
 *
 * 決定要素:
 *   - showflag: 1=介護, 2=予防, 3=医療/精神医療
 *   - servicetype: サービス種類コード (e.g. "13" = 訪問看護)
 *   - serviceitem: サービス項目コード (e.g. "1111")
 *   - longcareflag: 介護保険フラグ ("0" or "1")
 *   - pluralnurseflag1: 複数名訪問加算フラグ ("0" or "1")
 *   - pluralnurseflag2: 同行事務員フラグ ("0" or "1")
 *   - useI5Page: true の場合、k2_3 フローではなく k2_7_1 (訪看I5入力) を使用
 *
 * 転記処理詳細.xlsx の全組み合わせ表に基づく。
 */
import type { TranscriptionRecord } from '../types/spreadsheet.types';

/** サービスコード決定結果 */
export interface ServiceCodeResult {
  /** 保険種別切替フラグ: 1=介護, 2=予防, 3=医療/精神医療 */
  showflag: string;
  /** サービス種類コード (e.g. "13") — useI5Page=true の場合は空文字 */
  servicetype: string;
  /** サービス項目コード (e.g. "1111") — useI5Page=true の場合は空文字 */
  serviceitem: string;
  /** 介護保険フラグ: "1"=介護保険, "0"=医療保険 */
  longcareflag: string;
  /** 複数名訪問加算フラグ1 */
  pluralnurseflag1: string;
  /** 複数名訪問加算フラグ2（同行事務員） */
  pluralnurseflag2: string;
  /** true = k2_7_1 (訪看I5入力) ページを使用（介護+リハビリのみ） */
  useI5Page: boolean;
  /** サービスコード名称（デバッグ用） */
  description: string;
  /** 緊急時加算フラグ: k2_2 の urgentflags チェックボックスを ON にする */
  setUrgentFlag: boolean;
}

/**
 * サービスコード決定エンジン
 */
export class ServiceCodeResolver {
  /**
   * 転記レコードからサービスコードパラメータを決定する
   *
   * @throws Error 不明な組み合わせの場合
   */
  resolve(record: TranscriptionRecord): ServiceCodeResult {
    const { serviceType1, serviceType2 } = record;
    const hasAccompany = ServiceCodeResolver.isTruthy(record.accompanyCheck);
    const hasMultipleVisit = ServiceCodeResolver.isTruthy(record.multipleVisit);
    const hasEmergency = ServiceCodeResolver.isTruthy(record.emergencyFlag);
    const hasAccompanyClerk = ServiceCodeResolver.isTruthy(record.accompanyClerkCheck);
    // emergencyClerkCheck は現在のマッピングでは使用しないが将来用に保持

    // 共通フラグ
    const longcareflag = serviceType1 === '介護' ? '1' : '0';
    const pluralnurseflag1 = hasMultipleVisit ? '1' : '0';
    const pluralnurseflag2 = hasAccompanyClerk ? '1' : '0';
    const setUrgentFlag = hasEmergency;

    // ========== 介護 + リハビリ → k2_7_1 (訪看I5) ==========
    if (serviceType1 === '介護' && serviceType2 === 'リハビリ') {
      return {
        showflag: '1',
        servicetype: '',
        serviceitem: '',
        longcareflag: '1',
        pluralnurseflag1,
        pluralnurseflag2,
        useI5Page: true,
        description: '訪看I5（介護リハビリ）— k2_7_1ページで入力',
        setUrgentFlag,
      };
    }

    // ========== 医療 ==========
    if (serviceType1 === '医療') {
      return this.resolveIryo(serviceType2, hasAccompany, hasMultipleVisit, hasAccompanyClerk, {
        longcareflag: '0',
        pluralnurseflag1,
        pluralnurseflag2,
        setUrgentFlag,
      });
    }

    // ========== 精神医療 ==========
    if (serviceType1 === '精神医療') {
      return this.resolveSeishin(serviceType2, hasAccompany, hasMultipleVisit, {
        longcareflag: '0',
        pluralnurseflag1,
        pluralnurseflag2,
        setUrgentFlag,
      });
    }

    // ========== 介護（リハビリ以外） ==========
    if (serviceType1 === '介護') {
      return this.resolveKaigo(serviceType2, hasAccompany, hasMultipleVisit, hasAccompanyClerk, {
        longcareflag: '1',
        pluralnurseflag1,
        pluralnurseflag2,
        setUrgentFlag,
      });
    }

    throw new Error(
      `不明なサービス種別: serviceType1="${serviceType1}", serviceType2="${serviceType2}"。` +
      '医療/精神医療/介護 のいずれかを指定してください。'
    );
  }

  /**
   * 医療保険 (showflag=3) のサービスコード決定
   */
  private resolveIryo(
    serviceType2: string,
    hasAccompany: boolean,
    hasMultipleVisit: boolean,
    hasAccompanyClerk: boolean,
    flags: Pick<ServiceCodeResult, 'longcareflag' | 'pluralnurseflag1' | 'pluralnurseflag2' | 'setUrgentFlag'>,
  ): ServiceCodeResult {
    const base = { showflag: '3', useI5Page: false, ...flags };

    if (serviceType2 === '緊急') {
      return { ...base, servicetype: '13', serviceitem: '1111', description: '訪看I2（緊急時加算あり）' };
    }

    if (serviceType2 === 'リハビリ') {
      if (hasMultipleVisit) {
        return { ...base, servicetype: '13', serviceitem: '5114', description: '訪看I5複数名訪問加算' };
      }
      return { ...base, servicetype: '13', serviceitem: '5111', description: '訪看I5（理学療法等）' };
    }

    // 通常
    if (hasAccompany) {
      return { ...base, servicetype: '13', serviceitem: '1121', description: '訪看I2准（同行）' };
    }
    if (hasMultipleVisit || hasAccompanyClerk) {
      return { ...base, servicetype: '13', serviceitem: '1114', description: '訪看I2複数名訪問加算(看11)' };
    }
    return { ...base, servicetype: '13', serviceitem: '1111', description: '訪看I2' };
  }

  /**
   * 精神医療 (showflag=3) のサービスコード決定
   */
  private resolveSeishin(
    serviceType2: string,
    hasAccompany: boolean,
    hasMultipleVisit: boolean,
    flags: Pick<ServiceCodeResult, 'longcareflag' | 'pluralnurseflag1' | 'pluralnurseflag2' | 'setUrgentFlag'>,
  ): ServiceCodeResult {
    const base = { showflag: '3', useI5Page: false, ...flags };

    if (serviceType2 === '緊急') {
      return { ...base, servicetype: '13', serviceitem: '7111', description: '精神訪問看護基本療養費I（緊急時加算あり）' };
    }

    // 通常
    if (hasAccompany) {
      return { ...base, servicetype: '13', serviceitem: '7121', description: '精神訪問看護基本療養費I准（同行）' };
    }
    if (hasMultipleVisit) {
      return { ...base, servicetype: '13', serviceitem: '7114', description: '精神I複数名訪問加算' };
    }
    return { ...base, servicetype: '13', serviceitem: '7111', description: '精神訪問看護基本療養費I' };
  }

  /**
   * 介護保険 (showflag=1) のサービスコード決定（リハビリ以外）
   */
  private resolveKaigo(
    serviceType2: string,
    hasAccompany: boolean,
    hasMultipleVisit: boolean,
    hasAccompanyClerk: boolean,
    flags: Pick<ServiceCodeResult, 'longcareflag' | 'pluralnurseflag1' | 'pluralnurseflag2' | 'setUrgentFlag'>,
  ): ServiceCodeResult {
    const base = { showflag: '1', useI5Page: false, ...flags };

    if (serviceType2 === '緊急') {
      return { ...base, servicetype: '13', serviceitem: '1111', description: '訪問看護I（緊急時加算あり）' };
    }

    // 通常
    if (hasAccompany) {
      return { ...base, servicetype: '13', serviceitem: '1121', description: '訪問看護I准（同行）' };
    }
    if (hasMultipleVisit || hasAccompanyClerk) {
      return { ...base, servicetype: '13', serviceitem: '1114', description: '訪看I複数名訪問加算(看11)' };
    }
    return { ...base, servicetype: '13', serviceitem: '1111', description: '訪問看護I' };
  }

  /**
   * スプレッドシートのセル値が真偽値として「真」かどうかを判定
   *
   * @returns true: "TRUE", "true", "1", "はい", "〇", "○", その他の空でない文字列
   * @returns false: "", "FALSE", "false", "0", "いいえ", undefined, null
   */
  static isTruthy(value: string | undefined | null): boolean {
    if (!value) return false;
    const v = value.trim().toLowerCase();
    if (v === '' || v === 'false' || v === '0' || v === 'いいえ') return false;
    return true;
  }
}
