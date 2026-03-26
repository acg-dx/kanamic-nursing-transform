/**
 * CJK 異体字正規化ユーティリティ
 *
 * 日本語の人名に出現する旧字体・異体字を新字体に統一する。
 * NFKC 正規化だけでは対応できない旧字体→新字体の変換をカバーする。
 *
 * 用途: HAM / Google Sheets 間の患者名・スタッフ名マッチング
 */

/**
 * 旧字体 → 新字体マッピング
 *
 * 日本の人名で頻出する異体字ペア。
 * キー: 旧字体（または異体字）、値: 対応する新字体（常用漢字）
 */
export const CJK_VARIANT_MAP: Record<string, string> = {
  // 人名頻出（旧字体 → 新字体）
  '眞': '真',
  '實': '実',
  '學': '学',
  '體': '体',
  '國': '国',
  '會': '会',
  '發': '発',
  '廣': '広',
  '齋': '斎',
  '齊': '斉',
  '澤': '沢',
  '邊': '辺',
  '邉': '辺',
  '瀨': '瀬',
  '櫻': '桜',
  '靈': '霊',
  '鐵': '鉄',
  '龍': '竜',
  '壽': '寿',
  '榮': '栄',
  '譽': '誉',
  '惠': '恵',
  '峯': '峰',
  '彌': '弥',
  '與': '与',
  '淵': '渕',
  '曾': '曽',
  '德': '徳',
  '薗': '園',
  '嶋': '島',
  '條': '条',
  '黑': '黒',
  '賣': '売',
  '藝': '芸',
  '寬': '寛',
  '絲': '糸',
  '縣': '県',
  '顯': '顕',
  '關': '関',
  '驛': '駅',
  '亞': '亜',
  '圓': '円',
  '佛': '仏',
  '塚': '塚', // U+FA10 CJK互換 → U+585A
  '辻': '辻', // 一点しんにょう vs 二点（フォント依存だが念のため）

  // 拡張漢字（CJK 拡張領域の異体字）
  '㔟': '勢', // U+3517 — 伊㔟 → 伊勢
  '𫝆': '今', // U+2B746 (CJK拡張D) — 𫝆村 → 今村

  // 人名用異体字（CJK 互換漢字で NFKC 非対応のもの）
  '髙': '高', // はしご高 (U+9AD9) — NFKC で未統一のケースがある環境向け
  '﨑': '崎', // たつさき (U+FA11) — NFKC で通常統一されるが念のため
  '濵': '浜',
  '濱': '浜',
  '櫛': '櫛',
  '穗': '穂',
  '增': '増',
  '萬': '万',
  '禮': '礼',
  '藏': '蔵',
  '鑛': '鉱',
  '晝': '昼',
  '靜': '静',
  '從': '従',
  '應': '応',
  '戶': '戸',
  '單': '単',
  '營': '営',
  '豐': '豊',
  '歲': '歳',
  '氣': '気',
  '鹽': '塩',
  '賴': '頼',
  '兒': '児',
  '號': '号',
  '總': '総',
  '聽': '聴',
  '廳': '庁',
  '餘': '余',
  '兩': '両',
  '疊': '畳',
  '齒': '歯',
  '假': '仮',
};

/**
 * CJK 異体字を含む名前を正規化する（Node.js コンテキスト用）
 *
 * 処理順序:
 *   1. NFKC 正規化（﨑→崎 等の Unicode 互換漢字統一）
 *   2. 旧字体 → 新字体マッピング
 *   3. 空白除去
 *
 * @param name - 正規化対象の名前
 * @returns 正規化後の名前
 */
export function normalizeCjkName(name: string): string {
  let result = name.normalize('NFKC');
  // Variation Selectors を除去 (VS1-VS16: U+FE00-FE0F, VS17-VS256: U+E0100-E01EF)
  // Google Sheets が付与する不可見文字で、文字列比較を妨げる (例: 榊󠄀 → 榊)
  result = result.replace(/[\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, '');
  for (const [old, replacement] of Object.entries(CJK_VARIANT_MAP)) {
    if (result.includes(old)) {
      result = result.replaceAll(old, replacement);
    }
  }
  // ひらがな (U+3041-U+3096) → カタカナ (U+30A1-U+30F6) に統一
  result = result.replace(/[\u3041-\u3096]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
  return result.replace(/[\s\u3000\u00a0]+/g, '').trim();
}

/**
 * frame.evaluate() 内で使用するための正規化関数文字列を生成
 *
 * Playwright の evaluate() はブラウザコンテキストで実行されるため、
 * Node.js モジュールを直接 import できない。
 * この関数はマッピングテーブルを含む正規化関数のソースコードを返す。
 *
 * 使用例:
 *   const result = await frame.evaluate(
 *     new Function('name', `${CJK_NORMALIZE_INLINE}; return normalizeCjk(name);`) as any,
 *     targetName,
 *   );
 *
 * または evaluate 内に直接展開:
 *   await frame.evaluate((args) => {
 *     const variantMap = args.variantMap;
 *     function normalizeCjk(s) { ... }
 *   }, { variantMap: CJK_VARIANT_MAP_SERIALIZABLE });
 */
export const CJK_VARIANT_MAP_SERIALIZABLE = Object.entries(CJK_VARIANT_MAP);

/**
 * スタッフ名エイリアス（旧姓→新姓 等）
 *
 * Sheet 上の名前と HAM/SmartHR 上の登録名が異なる場合のマッピング。
 * キー: Sheet 上の名前（空白除去済み）、値: HAM 上の登録名（空白除去済み）
 */
export const STAFF_NAME_ALIASES: Record<string, string> = {
  '新盛裕望': '落合裕望',
};

/**
 * スタッフ名をエイリアス解決する
 *
 * Sheet 名が HAM/SmartHR と異なる場合、STAFF_NAME_ALIASES で変換する。
 * 一致しなければそのまま返す。
 */
export function resolveStaffAlias(name: string): string {
  const normalized = name.replace(/[\s\u3000]+/g, '');
  return STAFF_NAME_ALIASES[normalized] || normalized;
}

/**
 * 資格プレフィックスのリスト（明示的リスト — 汎用ダッシュ分割は使用しない）
 * 人名にダッシュが含まれる場合があるため、既知のプレフィックスのみ除去する。
 */
const QUALIFICATION_PREFIXES = [
  '看護師-',
  '准看護師-',
  '理学療法士等-',
  '理学療法士-',
  '作業療法士-',
  '言語聴覚士-',
];

/**
 * 資格プレフィックスを除去して氏名のみを返す
 *
 * 例:
 *   extractPlainName("看護師-冨迫広美") → "冨迫広美"
 *   extractPlainName("准看護師-永松アケミ") → "永松アケミ"
 *   extractPlainName("冨迫広美") → "冨迫広美"  (プレフィックスなし → そのまま)
 *
 * @param name - 資格プレフィックス付き、または通常の氏名
 * @returns プレフィックスを除去した氏名
 */
export function extractPlainName(name: string): string {
  for (const prefix of QUALIFICATION_PREFIXES) {
    if (name.startsWith(prefix)) {
      return name.slice(prefix.length);
    }
  }
  return name;
}
