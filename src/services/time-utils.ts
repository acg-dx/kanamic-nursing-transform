/**
 * 時間関連ユーティリティ
 *
 * HAM の timetype 値:
 *   0  = 未設定
 *   20 = 20分未満（0~20分）
 *   30 = 30分未満（21~30分）
 *   60 = 1時間未満（31~60分）
 *   90 = 1時間30分未満（61~90分）
 *   91 = 1時間30分以上（91分~）
 *
 * ※ timetype='21'（20分ちょうど）は不使用（専務確認済み 2026-02-26）
 *
 * 終了時間補正:
 *   HAM は timetype 選択時に区間終了時刻を自動設定するが、
 *   訪問時間が区間境界と一致しない場合は不正確（例: 12:00-12:35 → HAM自動=12:59）。
 *   正しい終了時間 = 表格の終了時間 - 1分（HAM仕様: 12:35 → 12:34）。
 *
 * HAM の starttype/endtype 値:
 *   0 = 指定なし
 *   1 = 日中（6:00-18:00）
 *   2 = 夜間・早朝（18:00-22:00, 6:00前）
 *   3 = 深夜（22:00-6:00）
 */

/**
 * 開始時刻と終了時刻から所要時間（分）を計算
 */
export function calcDurationMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);

  let startMin = sh * 60 + sm;
  let endMin = eh * 60 + em;

  // 日跨ぎ対応（e.g. 23:00 - 01:00）
  if (endMin <= startMin) {
    endMin += 24 * 60;
  }

  return endMin - startMin;
}

/**
 * 所要時間（分）から HAM timetype 値を計算
 *
 * 専務確認済み統一ルール (2026-02-26):
 *   全支援区分（介護・医療・精神医療）共通。
 *   30分ジャスト → 30分未満、60分ジャスト → 1時間未満。
 *   終了時間は calcCorrectedEndTime() で補正する（表格終了時間 - 1分）。
 */
export function calcTimetype(durationMinutes: number): string {
  if (durationMinutes <= 20) return '20';      // 20分未満（0~20分）
  if (durationMinutes <= 30) return '30';      // 30分未満（21~30分）
  if (durationMinutes <= 60) return '60';      // 1時間未満（31~60分）
  if (durationMinutes <= 90) return '90';      // 1時間30分未満（61~90分）
  return '91';                                 // 1時間30分以上（91分~）
}

/**
 * 開始・終了時刻から timetype を直接算出
 */
export function getTimetype(startTime: string, endTime: string): string {
  const duration = calcDurationMinutes(startTime, endTime);
  return calcTimetype(duration);
}

/**
 * 時刻から starttype/endtype（時間帯区分）を算出
 *   1 = 日中（6:00-18:00）
 *   2 = 夜間・早朝（18:00-22:00 or 4:00-6:00）
 *   3 = 深夜（22:00-4:00）
 */
export function getTimePeriod(time: string): string {
  const [h] = time.split(':').map(Number);
  if (h >= 6 && h < 18) return '1';    // 日中
  if (h >= 18 && h < 22) return '2';   // 夜間
  if (h >= 22 || h < 6) return '3';    // 深夜
  return '1'; // default
}

/**
 * 時刻文字列から時・分を分解
 * "09:30" → { hour: "09", minute: "30" }
 */
export function parseTime(time: string): { hour: string; minute: string } {
  const parts = time.split(':');
  return {
    hour: parts[0].padStart(2, '0'),
    minute: (parts[1] || '00').padStart(2, '0'),
  };
}

/**
 * 日付文字列を HAM 用の YYYYMMDD 形式に変換
 * "2026-02-01" → "20260201"
 * "2026/02/01" → "20260201"
 */
export function toHamDate(dateStr: string): string {
  return dateStr.replace(/[-/]/g, '');
}

/**
 * 日付文字列を HAM 用の YYYYMM01 形式（月初日）に変換
 * "2026-02-15" → "20260201"
 */
export function toHamMonthStart(dateStr: string): string {
  const d = toHamDate(dateStr);
  return d.substring(0, 6) + '01';
}

/**
 * 終了時刻から1分引いた時刻を返す（HAM終了時間補正用）
 *
 * HAM は timetype 選択時に区間終了時刻を自動設定するが、
 * 訪問時間が区間境界と一致しない場合は不正確。
 * 正しい HAM 終了時間 = 表格の終了時間 - 1分。
 *
 * 例:
 *   "12:35" → { hour: "12", minute: "34" }
 *   "13:00" → { hour: "12", minute: "59" }
 *   "00:00" → { hour: "23", minute: "59" }
 */
export function calcCorrectedEndTime(endTime: string): { hour: string; minute: string } {
  const [h, m] = endTime.split(':').map(Number);
  let correctedMinute = m - 1;
  let correctedHour = h;
  if (correctedMinute < 0) {
    correctedMinute = 59;
    correctedHour -= 1;
    if (correctedHour < 0) correctedHour = 23;
  }
  return {
    hour: String(correctedHour).padStart(2, '0'),
    minute: String(correctedMinute).padStart(2, '0'),
  };
}

/**
 * カタカナの頭文字を取得（カナ検索用）
 * "瀧下絹子" → 名前からカナは取得できないため、あおぞらID等で直接検索する
 * フリガナ "タキシタ" → "タ"
 */
export function getKanaInitial(katakaneName: string): string {
  if (!katakaneName) return '';
  return katakaneName.charAt(0);
}
