/**
 * サービスコード決定エンジン
 *
 * Google Sheets の転記レコード (serviceType1, serviceType2, 各フラグ) から
 * HAM k2_3a ページで選択すべきサービスコードパラメータを決定する。
 *
 * 決定要素:
 *   - showflag: 1=介護, 2=予防, 3=医療/精神医療
 *   - servicetype: サービス種類コード (e.g. "93" = 訪問看護)
 *   - serviceitem: サービス項目コード (e.g. "1001")
 *   - longcareflag: 介護保険フラグ ("0" or "1")
 *   - pluralnurseflag1: 複数名訪問加算フラグ ("0" or "1")
 *   - pluralnurseflag2: 同行事務員フラグ ("0" or "1")
 *   - useI5Page: true の場合、k2_3 フローではなく k2_7_1 (訪看I5入力) を使用
 *
 * 転記処理詳細.xlsx の全組み合わせ表に基づく。
 *
 * textPattern はサービス選択の主要手段。servicetype#serviceitem は searchKbn フィルタ
 * 状態によって変動するため、textPattern でのテキスト部分一致を一次手段とし、
 * servicetype#serviceitem は参考値として保持する。
 *
 * textRequire: textPattern 一致後、さらにこの文字列を含む行のみを候補とする。
 *   例: 緊急+加算対象 → textRequire='・緊急' で「・緊急」を含むサービスのみ選択。
 */
import type { TranscriptionRecord } from '../types/spreadsheet.types';

/** サービスコード決定結果 */
export interface ServiceCodeResult {
  /** 保険種別切替フラグ: 1=介護, 2=予防, 3=医療/精神医療 */
  showflag: string;
  /** サービス種類コード — HAM radio value の左側 (e.g. "93") */
  servicetype: string;
  /** サービス項目コード — HAM radio value の右側 (e.g. "1001") */
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
  /**
   * HAM k2_3a テキストマッチパターン（radio 行テキストに部分一致検索）
   *
   * searchKbn フィルタ状態により servicetype#serviceitem が変わるため、
   * テキストパターンを一次選択手段とする。
   *
   * 医療: '訪問看護基本療養費（Ⅰ・Ⅱ）' — 精神科（Ⅰ・Ⅲ）とは Ⅱ/Ⅲ で区別
   * 精神: '精神科訪問看護基本療養費（Ⅰ・Ⅲ）'
   */
  textPattern: string;
  /**
   * textPattern 一致後の追加必須パターン。
   * これが設定されている場合、textPattern AND textRequire 両方を含む行のみ候補とする。
   * 例: 緊急+加算対象 → textRequire='・緊急'
   */
  textRequire?: string;
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
    const hasEmergency = ServiceCodeResolver.isTruthy(record.emergencyFlag);
    const qTruthy = ServiceCodeResolver.isTruthy(record.multipleVisit);

    // P列: 具体的な値（同行者/複数人(主)/複数人(副)/複数人(看護+介護)/支援者/空欄）
    const pCol = record.accompanyClerkCheck?.trim() || '';

    // R列: 緊急時の加算対象判定（医療/精神医療のみ使用）
    const emergencyClerkCheck = record.emergencyClerkCheck?.trim() || '';
    const isKasanTaisho = emergencyClerkCheck === '加算対象';

    // 共通フラグ計算（転記処理詳細.xlsx 全組み合わせ表に基づく正確な条件）
    const longcareflag = serviceType1 === '介護' ? '1' : '0';

    // pluralnurseflag1=複数名訪問: P∈{複数人(主/副/看護+介護)} AND Q=FALSE
    //   ROW 4-5,7(介護), ROW 20,22,24(医療), ROW 44,46,48(精神)
    const isMultiNurseP = ['複数人(主)', '複数人(副)', '複数人(看護+介護)'].includes(pCol);
    const pluralnurseflag1 = (isMultiNurseP && !qTruthy) ? '1' : '0';

    // pluralnurseflag2=複数名訪問(二): P∈{支援者,複数人(主),複数人(看護+介護)} AND Q=TRUE
    //   ROW 8-10(介護), ROW 17,21,25(医療), ROW 41,45,49(精神)
    const isSupporterOrMulti = ['支援者', '複数人(主)', '複数人(看護+介護)'].includes(pCol);
    const pluralnurseflag2 = (isSupporterOrMulti && qTruthy) ? '1' : '0';

    // 緊急時加算フラグ (k2_2 urgentflags):
    //   介護: O列(emergencyFlag) 基準
    //   医療/精神医療: O列=true AND R列='加算対象' のときのみ ON
    const setUrgentFlag = serviceType1 === '介護'
      ? hasEmergency
      : (hasEmergency && isKasanTaisho);

    const flags = { longcareflag, pluralnurseflag1, pluralnurseflag2, setUrgentFlag };

    // ========== 介護 + リハビリ → k2_7_1 (訪看I5) ==========
    if (serviceType1 === '介護' && serviceType2 === 'リハビリ') {
      return {
        showflag: '1', servicetype: '', serviceitem: '',
        longcareflag: '1', pluralnurseflag1, pluralnurseflag2,
        useI5Page: true,
        description: '訪看I5（介護リハビリ）— k2_7_1ページで入力',
        setUrgentFlag, textPattern: '',
      };
    }

    // ========== 医療 ==========
    if (serviceType1 === '医療') {
      return this.resolveIryo(serviceType2, isKasanTaisho, {
        ...flags, longcareflag: '0',
      });
    }

    // ========== 精神医療 ==========
    if (serviceType1 === '精神医療') {
      return this.resolveSeishin(serviceType2, isKasanTaisho, {
        ...flags, longcareflag: '0',
      });
    }

    // ========== 介護（リハビリ以外） ==========
    if (serviceType1 === '介護') {
      return this.resolveKaigo(serviceType2, pCol, qTruthy, {
        ...flags, longcareflag: '1',
      });
    }

    throw new Error(
      `不明なサービス種別: serviceType1="${serviceType1}", serviceType2="${serviceType2}"。` +
      '医療/精神医療/介護 のいずれかを指定してください。'
    );
  }

  /**
   * 医療保険 (showflag=3) のサービスコード決定
   *
   * 転記処理詳細 全組み合わせ表 ROW 15-38:
   *   通常/リハビリ: textPattern='訪問看護基本療養費（Ⅰ・Ⅱ）' で最短一致 → base サービス
   *   緊急+加算対象: textRequire='・緊急' で ・緊急 suffix 付きサービスを選択
   *   緊急+加算対象外: textPattern のみ → 最短一致で base（・緊急なし）を選択
   *
   * textPattern で（Ⅰ・Ⅱ）を含めることで、精神科（Ⅰ・Ⅲ）との混在を防ぐ。
   * servicetype#serviceitem は searchKbn フィルタ状態で変動するため参考値。
   */
  private resolveIryo(
    serviceType2: string,
    isKasanTaisho: boolean,
    flags: Pick<ServiceCodeResult, 'longcareflag' | 'pluralnurseflag1' | 'pluralnurseflag2' | 'setUrgentFlag'>,
  ): ServiceCodeResult {
    const base = { showflag: '3', useI5Page: false, ...flags };
    // 医療の textPattern: （Ⅰ・Ⅱ）で精神科（Ⅰ・Ⅲ）と区別
    const iryo = '訪問看護基本療養費（Ⅰ・Ⅱ）';

    // --- 緊急 (ROW 26-27) ---
    if (serviceType2.startsWith('緊急')) {
      if (isKasanTaisho) {
        // ROW 26: 加算対象 → ・緊急 suffix 付きサービスを選択
        return {
          ...base, servicetype: '93', serviceitem: '1001',
          textPattern: iryo, textRequire: '・緊急',
          description: '訪問看護基本療養費（Ⅰ・Ⅱ）・緊急（加算対象）',
        };
      }
      // ROW 27: 加算対象外 → base（・緊急なし）/ urgentflags OFF（flags.setUrgentFlag は既に false）
      return {
        ...base, servicetype: '93', serviceitem: '1001',
        textPattern: iryo,
        description: '訪問看護基本療養費（Ⅰ・Ⅱ）（加算対象外）',
      };
    }

    // --- リハビリ (ROW 28) --- 理学療法士等のみ可（資格チェックは selectQualificationCheckbox で実施）
    if (serviceType2 === 'リハビリ') {
      return {
        ...base, servicetype: '93', serviceitem: '1001',
        textPattern: iryo,
        description: '訪問看護基本療養費（Ⅰ・Ⅱ）（理学療法等）',
      };
    }

    // --- 通常 (ROW 15-25) ---
    return {
      ...base, servicetype: '93', serviceitem: '1001',
      textPattern: iryo,
      description: '訪問看護基本療養費（Ⅰ・Ⅱ）',
    };
  }

  /**
   * 精神医療 (showflag=3) のサービスコード決定
   *
   * 転記処理詳細 全組み合わせ表 ROW 39-62:
   *   通常/リハビリ: textPattern='精神科訪問看護基本療養費（Ⅰ・Ⅲ）' で最短一致
   *   緊急+加算対象: textRequire='・緊急' で ・緊急 suffix 付きサービスを選択
   *     ※ k2_3a の flag2=緊急 checkbox は selectQualificationCheckbox で設定
   *   緊急+加算対象外 (ROW 51): ★特例★ 医療の textPattern '訪問看護基本療養費（Ⅰ・Ⅱ）' を使用
   *     spec 原文: 「①訪問看護基本療養費（Ⅰ・Ⅱ）②・准 ③（理学療法士等）」
   */
  private resolveSeishin(
    serviceType2: string,
    isKasanTaisho: boolean,
    flags: Pick<ServiceCodeResult, 'longcareflag' | 'pluralnurseflag1' | 'pluralnurseflag2' | 'setUrgentFlag'>,
  ): ServiceCodeResult {
    const base = { showflag: '3', useI5Page: false, ...flags };
    // 精神科の textPattern: （Ⅰ・Ⅲ）で医療（Ⅰ・Ⅱ）と区別
    const seishin = '精神科訪問看護基本療養費（Ⅰ・Ⅲ）';
    // ROW 51 特例: 精神+緊急+加算対象外は医療のサービスを使用
    const iryo = '訪問看護基本療養費（Ⅰ・Ⅱ）';

    // --- 緊急 (ROW 50-51) ---
    if (serviceType2.startsWith('緊急')) {
      if (isKasanTaisho) {
        // ROW 50: 加算対象 → flag2=緊急 + ・緊急 suffix（flag2 は selectQualificationCheckbox で設定）
        return {
          ...base, servicetype: '93', serviceitem: '1225',
          textPattern: seishin, textRequire: '・緊急',
          description: '精神科訪問看護基本療養費（Ⅰ・Ⅲ）・緊急（加算対象）',
        };
      }
      // ROW 51: ★加算対象外 → 医療の基本療養費（Ⅰ・Ⅱ）を選択★
      return {
        ...base, servicetype: '93', serviceitem: '1001',
        textPattern: iryo,
        description: '訪問看護基本療養費（Ⅰ・Ⅱ）（精神緊急・加算対象外 → 医療サービス使用）',
      };
    }

    // --- リハビリ (ROW 52-62) ---
    // ★医療リハビリと異なり、精神リハビリは看護師/准看護師も可★
    // 資格制限チェックは selectQualificationCheckbox で serviceType1 を考慮して実施
    if (serviceType2 === 'リハビリ') {
      return {
        ...base, servicetype: '93', serviceitem: '1225',
        textPattern: seishin,
        description: '精神科訪問看護基本療養費（Ⅰ・Ⅲ）（リハビリ）',
      };
    }

    // --- 通常 (ROW 39-49) ---
    return {
      ...base, servicetype: '93', serviceitem: '1225',
      textPattern: seishin,
      description: '精神科訪問看護基本療養費（Ⅰ・Ⅲ）',
    };
  }

  /**
   * 介護保険 (showflag=1) のサービスコード決定（リハビリ以外）
   *
   * HAM k2_3a のサービス等級は訪問時間に基づいて自動決定される:
   *   訪看Ⅰ１ = 20分未満, Ⅰ２ = 30分未満, Ⅰ３ = 30分以上1h未満, Ⅰ４ = 1h以上1.5h未満
   * ※HAM は終了時刻を -1分する（例: 11:30→11:29）ため、
   *   表面上30分の訪問が29分扱いで Ⅰ２ になるケースがある。
   *
   * textPattern='訪看Ⅰ' で全等級（Ⅰ１〜Ⅰ４）に対応し、
   * HAM が表示したサービス一覧から最短一致で基本サービスを選択する。
   *
   * ★資格区分（看護師/准看護師）は selectQualificationCheckbox で制御:
   *   - searchKbn ラジオ設定（医療/精神では有効だが介護では非対応）
   *   - textRequire='・准' で介護の准看護師サービスを精准選択
   *
   * servicetype#serviceitem は参考値。等級により変動するため、
   * textPattern + textRequire によるテキストマッチを一次選択手段とする。
   */
  private resolveKaigo(
    serviceType2: string,
    pCol: string,
    qTruthy: boolean,
    flags: Pick<ServiceCodeResult, 'longcareflag' | 'pluralnurseflag1' | 'pluralnurseflag2' | 'setUrgentFlag'>,
  ): ServiceCodeResult {
    const base = { showflag: '1', useI5Page: false, ...flags };

    // 緊急 (ROW 12): urgentflags は setUrgentFlag で制御済み
    if (serviceType2.startsWith('緊急')) {
      return { ...base, servicetype: '13', serviceitem: '1211', textPattern: '訪看Ⅰ', description: '訪看Ⅰ（緊急）' };
    }

    // 通常 (ROW 1-10): P列+Q列 の組み合わせで分岐
    // ※同行者は isTranscriptionTarget で既にフィルタ済み（ここに到達しない）
    // pluralnurseflag1/2 は flags に正しい値が含まれている（resolve() で計算済み）
    return { ...base, servicetype: '13', serviceitem: '1211', textPattern: '訪看Ⅰ', description: '訪看Ⅰ' };
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
