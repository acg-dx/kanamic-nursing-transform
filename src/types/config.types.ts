export interface SheetLocation {
  name: string;
  sheetId: string;
}

export interface AppConfig {
  kanamick: {
    url: string;
    username: string;
    password: string;
  };
  sheets: {
    serviceAccountKeyPath: string;
    /** 4つの転記/削除用事業所シート */
    locations: SheetLocation[];
    /** 同一建物管理用の連携スプレッドシートID */
    buildingMgmtSheetId: string;
  };
  aiHealing: {
    apiKey: string;
    model: string;
    maxAttempts: number;
  };
  scheduling: {
    transcriptionCron: string;
    buildingMgmtCron: string;
  };
  logging: {
    level: string;
    logDir: string;
    screenshotDir: string;
  };
}
