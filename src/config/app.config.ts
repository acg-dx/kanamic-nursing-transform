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

/** 4个事业所的Sheet ID */
const SHEET_LOCATIONS = [
  { name: '谷山', sheetId: '1JCtgIVXaAxRXjpOP9YbRGosYYm-j7835oOPCBccu3s8' },
  { name: '荒田', sheetId: '1dri7Bgj0gk3zq7giZ0690rQq0zYbKjKtBIKK5UtQJJ4' },
  { name: '博多', sheetId: '1xRnQ6d2rKKDvJvVPHPpAhyySvZFdjQ5gK3iBahYzmTg' },
  { name: '姶良', sheetId: '12lzQUObLw0ymZdTRPpBWqECRkRimMXO7-m9maWPUt6M' },
];

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
      locations: SHEET_LOCATIONS,
      buildingMgmtSheetId: BUILDING_MGMT_SHEET_ID,
    },
    aiHealing: {
      apiKey: requireEnv('ANTHROPIC_API_KEY'),
      model: process.env.AI_HEALING_MODEL || 'claude-sonnet-4-6',
      maxAttempts: parseInt(process.env.AI_HEALING_MAX_ATTEMPTS || '3', 10),
    },
    scheduling: {
      transcriptionCron: process.env.TRANSCRIPTION_CRON || '0 7 * * *',
      buildingMgmtCron: process.env.BUILDING_MGMT_CRON || '0 6 3 * *',
    },
    logging: {
      level: process.env.LOG_LEVEL || 'info',
      logDir: process.env.LOG_DIR || './logs',
      screenshotDir: process.env.SCREENSHOT_DIR || './screenshots',
    },
  };
}
