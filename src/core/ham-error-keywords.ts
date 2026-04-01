/**
 * HAM ページ死亡/OOM/サーバーエラー検出用キーワード。
 *
 * ページの innerText に以下のキーワードが含まれている場合、
 * そのページは正常な状態ではないと判断する。
 * 検出時の対応は呼び出し元が決定する（リロード、ブラウザ再起動等）。
 */
export const PAGE_DEATH_KEYWORDS = [
  'メモリが不足',         // HAM: "メモリが不足しています" 等
  'メモリ不足',           // 短縮形
  'Out of Memory',        // Chrome OOM
  'このページを開けません', // Chrome: "このページを開けません"
  '開けません',           // 上記の短縮マッチ
  'Aw, Snap!',            // Chrome クラッシュページ（英語）
  'サーバーエラー',        // HAM サーバー側
  '一時的に利用できません', // HAM メンテナンス
  'E00010',               // HAM 固有エラーコード
  '502 Bad Gateway',      // プロキシ/ロードバランサー
  '503 Service',          // サーバー過負荷
  'Internal Server Error', // 500 系
] as const;

/**
 * Playwright レベルのページ/ブラウザクラッシュ信号。
 *
 * evaluate() 等の Playwright API が投げるエラーメッセージに
 * これらのキーワードが含まれている場合、ページプロセスが死亡している。
 * 「フレーム遷移中」のエラー（Execution context was destroyed）とは区別する。
 */
export const PLAYWRIGHT_CRASH_SIGNALS = [
  'Target crashed',           // ページプロセスクラッシュ
  'Page crashed',             // Playwright: page crash イベント
  'page has been closed',     // ページが閉じられた
  'browser has been closed',  // ブラウザ全体が閉じられた
  'Session closed',           // CDP セッション切断
  'Browser closed',           // ブラウザ閉鎖
  'Connection closed',        // WebSocket 切断
] as const;

/**
 * Playwright エラーメッセージがページ/ブラウザのクラッシュを示すかどうか判定する。
 *
 * 「Execution context was destroyed」はフォーム送信後のフレーム遷移でも
 * 発生するため、ここでは含めない（正常パスと区別不可）。
 * ただし「Target closed」はフレーム遷移でも出るため、
 * 「Execution context」と組み合わさっていない場合のみクラッシュと判定。
 */
export function isPageCrashError(errorMessage: string): boolean {
  if (PLAYWRIGHT_CRASH_SIGNALS.some(sig => errorMessage.includes(sig))) {
    return true;
  }
  // "Target closed" 単独 = クラッシュ、"Execution context" 付き = フレーム遷移
  if (errorMessage.includes('Target closed') && !errorMessage.includes('Execution context')) {
    return true;
  }
  return false;
}
