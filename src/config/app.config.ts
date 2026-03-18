import dotenv from 'dotenv';
import { AppConfig } from '../types/config.types';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`必须设置环境变量: ${key}`);
  }
  return value;
}

/** 4事業所の Sheet ID + HAM/TRITRUS 事業所情報 */
const SHEET_LOCATIONS = [
  { name: '姶良', sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M', stationName: '訪問看護ステーションあおぞら姶良', hamOfficeCode: '400021814', tritrusOfficeCd: '4664590280' },
  { name: '荒田', sheetId: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4', stationName: '訪問看護ステーションあおぞら荒田', hamOfficeCode: '109152', tritrusOfficeCd: '4660190861' },
  { name: '谷山', sheetId: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8', stationName: '訪問看護ステーションあおぞら谷山', hamOfficeCode: '400011055', tritrusOfficeCd: '4660191471' },
  { name: '福岡', sheetId: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg', stationName: '訪問看護ステーションあおぞら福岡', hamOfficeCode: '103435', tritrusOfficeCd: '4060391200' },
];

/**
 * RUN_LOCATIONS 環境変数で処理対象の事業所をフィルタ（カンマ区切り）
 * 例: RUN_LOCATIONS=姶良        → 姶良のみ
 *     RUN_LOCATIONS=姶良,谷山   → 姶良と谷山
 *     未設定                    → 全事業所
 */
function getActiveLocations() {
  const runLocations = process.env.RUN_LOCATIONS;
  if (!runLocations) return SHEET_LOCATIONS;

  const names = runLocations.split(',').map(s => s.trim()).filter(Boolean);
  if (names.length === 0) return SHEET_LOCATIONS;

  const filtered = SHEET_LOCATIONS.filter(loc => names.includes(loc.name));
  return filtered.length > 0 ? filtered : SHEET_LOCATIONS;
}

/** 同一建物管理用連携スプレッドシートID */
const BUILDING_MGMT_SHEET_ID = process.env.BUILDING_MGMT_SHEET_ID
  || '18DueDsYPsNmePiYIp9hVpD1rIWWMCyPX5SdWzXOnZBY';

export function loadConfig(): AppConfig {
  return {
    kanamick: {
      url: requireEnv('KANAMICK_URL'),
      username: requireEnv('KANAMICK_USERNAME'),
      password: requireEnv('KANAMICK_PASSWORD'),
    },
    sheets: {
      serviceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || './kangotenki.json',
      locations: getActiveLocations(),
      buildingMgmtSheetId: BUILDING_MGMT_SHEET_ID,
      ghSheetIdKagoshima: process.env.GH_SHEET_ID_KAGOSHIMA || '',
      ghSheetIdFukuoka: process.env.GH_SHEET_ID_FUKUOKA || '',
    },
    kintone: {
      baseUrl: process.env.KINTONE_BASE_URL || '',
      app197Token: process.env.KINTONE_APP_197_TOKEN || '',
    },
    aiHealing: {
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.AI_HEALING_MODEL || 'gpt-4o',
      maxAttempts: parseInt(process.env.AI_HEALING_MAX_ATTEMPTS || '3', 10),
    },
    scheduling: {
      transcriptionCron: process.env.TRANSCRIPTION_CRON || '0 13 * * *',
      buildingMgmtCron: process.env.BUILDING_MGMT_CRON || '0 6 3 * *',
    },
    logging: {
      level: process.env.LOG_LEVEL || 'info',
      logDir: process.env.LOG_DIR || './logs',
      screenshotDir: process.env.SCREENSHOT_DIR || './screenshots',
    },
  };
}
