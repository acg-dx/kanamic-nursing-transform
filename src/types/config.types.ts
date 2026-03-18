export interface SheetLocation {
  name: string;
  sheetId: string;
  /** HAM 事業所名（TRITRUS ポータルのリンクテキスト） */
  stationName: string;
  /** HAM 事業所コード（goCicHam.jsp の h パラメータ） */
  hamOfficeCode: string;
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
    /** 共同生活援助スプレッドシートID（鹿児島） */
    ghSheetIdKagoshima: string;
    /** 共同生活援助スプレッドシートID（福岡） */
    ghSheetIdFukuoka: string;
  };
  kintone: {
    baseUrl: string;
    app197Token: string;
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
