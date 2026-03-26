/**
 * スタッフ同期ワークフロー（3フェーズ構成）
 *
 * カナミック職員情報登録マニュアル準拠:
 *
 * Phase 1: マスター管理での基本登録 (TRITRUS /tritrus/staffInfo/)
 *   - スタッフ管理 → 新規追加
 *   - 氏名（フリガナ・漢字）入力
 *   - 資格情報は空欄（後ほど HAM で設定）
 *   - 代表事業所を検索・設定
 *   - 「登録する」クリック
 *
 * Phase 2: 詳細情報の編集 (TRITRUS)
 *   - 従業員情報・編集: 雇用形態=スタッフ, 従業員番号, 入社日
 *   - 事業所設定: 対象事業所を選択
 *   - アカウント情報: ログインID=ACGP+従業員番号, パスワード=Acgp2308!
 *
 * Phase 3: HAM 資格登録 (HAM h1-1)
 *   - マスター → スタッフマスター管理
 *   - 登録スタッフ一覧 → 詳細
 *   - 所有資格チェックボックス設定
 *   - データ上書き保存 → 終了
 */
import { Page, Frame } from 'playwright';
import { logger } from '../../core/logger';
import { SmartHRService } from '../../services/smarthr.service';
import { KanamickAuthService } from '../../services/kanamick-auth.service';
import { HamNavigator } from '../../core/ham-navigator';
import { withRetry } from '../../core/retry-manager';
import type { StaffMasterEntry } from '../../types/smarthr.types';

// ============================================================
// 定数
// ============================================================

/** TRITRUS スタッフ管理の URL パス */
const TRITRUS_STAFF_INDEX = '/tritrus/staffInfo/index';
const TRITRUS_STAFF_ADD = '/tritrus/staffInfo/staffInfoAdd?executeFlag=0&flg=add';
const TRITRUS_MASTER = '/tritrus/master/';
const BASE_URL = 'https://portal.kanamic.net';

/** 事業所情報 */
export interface OfficeInfo {
  cd: string;
  name: string;
}

/**
 * 補登スキップ対象の従業員番号
 * Sheet 上の番号と TRITRUS/CSV 上の番号が異なるため、別番号で既に登録済みのスタッフ。
 * 例: Sheet=1382 → TRITRUS=1045（牛込智美）
 */
const SKIP_EMPLOYEE_NUMBERS = new Set([
  '669',   // 高田衿湖 — TRITRUS 上は 2057
  '1382',  // 牛込智美 — TRITRUS 上は 1045
  '1182',  // 小川亜紀子 — TRITRUS 上は 1898
]);

/** デフォルト事業所（姶良） */
const DEFAULT_OFFICE: OfficeInfo = {
  cd: '4664590280',
  name: '訪問看護ステーションあおぞら姶良',
};

/** アカウント設定 */
const ACCOUNT_PREFIX = 'ACGP';
const ACCOUNT_PASSWORD = 'Acgp2308!';

/**
 * SmartHR 資格名 → HAM h1-1b チェックボックス操作定義
 *
 * HAM のチェックボックス構造:
 *   - 通常: <input type="checkbox" id="licenceXX" name="licenceXX" class="licence-check">
 *   - 看護師/准看護師は特殊:
 *     <input type="checkbox" name="licence5s"> で有効化
 *     <input type="radio" name="licence5" value="1"> 看護師
 *     <input type="radio" name="licence5" value="2"> 准看護師
 */
interface HamQualAction {
  checkboxId?: string;      // チェックする checkbox の id
  checkboxName?: string;    // チェックする checkbox の name (id がない場合)
  radioName?: string;       // 追加で選択する radio の name
  radioValue?: string;      // radio の value
}

const HAM_QUALIFICATION_MAP: Record<string, HamQualAction> = {
  '看護師':     { checkboxName: 'licence5s', radioName: 'licence5', radioValue: '1' },
  '正看護師':   { checkboxName: 'licence5s', radioName: 'licence5', radioValue: '1' },
  '准看護師':   { checkboxName: 'licence5s', radioName: 'licence5', radioValue: '2' },
  '理学療法士': { checkboxId: 'licence10' },
  '作業療法士': { checkboxId: 'licence11' },
  '言語聴覚士': { checkboxId: 'licence12' },
  '保健師':     { checkboxId: 'licence18' },
};

// ============================================================
// インターフェース
// ============================================================

export interface StaffSyncResult {
  synced: number;
  skipped: number;
  errors: number;
  details: StaffSyncDetail[];
}

export interface StaffSyncDetail {
  staffNumber: string;
  staffName: string;
  /** Phase 1: マスター管理基本登録 */
  phase1: 'registered' | 'existing' | 'skipped' | 'error';
  /** Phase 2: 詳細情報編集 */
  phase2: 'set' | 'skipped' | 'error' | 'not-applicable';
  /** Phase 3: HAM 資格登録 */
  phase3: 'set' | 'skipped' | 'error' | 'not-applicable';
  error?: string;
}

// ============================================================
// メインサービス
// ============================================================

export class StaffSyncService {
  private smarthr: SmartHRService;
  private auth: KanamickAuthService;
  private office: OfficeInfo;

  constructor(smarthr: SmartHRService, auth: KanamickAuthService, office?: OfficeInfo) {
    this.smarthr = smarthr;
    this.auth = auth;
    this.office = office || DEFAULT_OFFICE;
  }

  /**
   * SmartHR から対象部署のスタッフ情報を取得し、カナミックに登録する。
   * 3フェーズ: マスター管理 → 詳細編集 → HAM 資格。
   * 失敗しても例外を投げない（エラー数を返す）。
   */
  async syncStaff(departmentKeyword: string = '姶良', limit?: number, offset?: number): Promise<StaffSyncResult> {
    const result: StaffSyncResult = { synced: 0, skipped: 0, errors: 0, details: [] };

    try {
      logger.info(`SmartHR スタッフ同期開始 (部署フィルタ: ${departmentKeyword}${offset ? `, オフセット: ${offset}` : ''}${limit ? `, 上限: ${limit}名` : ''})`);

      // SmartHR からスタッフ取得 + フィルタ
      const allCrews = await this.smarthr.getAllCrews();
      const activeCrews = this.smarthr.filterActive(allCrews);
      const filteredCrews = this.smarthr.filterByDepartment(activeCrews, departmentKeyword);
      let staffEntries = filteredCrews.map(c => this.smarthr.toStaffMasterEntry(c));

      // offset が指定されている場合は先頭 N 件をスキップ
      if (offset && offset > 0) {
        const skippedNames = staffEntries.slice(0, offset).map(s => s.staffName).join(', ');
        staffEntries = staffEntries.slice(offset);
        logger.info(`SmartHR: 先頭 ${offset}名をスキップ (${skippedNames})`);
      }

      // limit が指定されている場合は先頭 N 件に絞る
      if (limit && limit > 0) {
        staffEntries = staffEntries.slice(0, limit);
        logger.info(`SmartHR: ${filteredCrews.length}名中 ${staffEntries.length}名に制限 (--limit=${limit})`);
      }

      logger.info(`SmartHR: ${staffEntries.length}名のスタッフを処理 (${departmentKeyword})`);

      // TRITRUS にログイン（HAM も開く）
      const nav = await this.auth.ensureLoggedIn();
      const page = this.auth.page; // TRITRUS ページ（タブ0）

      // スタッフ管理ページへ遷移
      await this.navigateToStaffIndex(page);

      // 既存スタッフ名を取得（重複チェック用）
      const existingNames = await this.getExistingStaffNames(page);
      logger.info(`TRITRUS 既存スタッフ: ${existingNames.length}名`);

      for (const staff of staffEntries) {
        const detail: StaffSyncDetail = {
          staffNumber: staff.staffNumber,
          staffName: staff.staffName,
          phase1: 'skipped',
          phase2: 'not-applicable',
          phase3: 'not-applicable',
        };

        if (!staff.staffName) {
          logger.warn(`スタッフ情報不完全のためスキップ: ${staff.staffNumber || '(番号なし)'}`);
          result.skipped++;
          result.details.push(detail);
          continue;
        }

        // 氏名で既存チェック
        const { lastName, firstName } = this.splitName(staff.staffName);
        const fullName = `${lastName} ${firstName}`.trim();
        const isExisting = existingNames.some(
          name => name === fullName || name === staff.staffName || name === staff.staffNameLegal
        );

        if (isExisting) {
          logger.debug(`スタッフ既存: ${staff.staffNumber} ${staff.staffName}`);
          result.skipped++;
          detail.phase1 = 'existing';
          result.details.push(detail);
          continue;
        }

        // === Phase 1: マスター管理基本登録 ===
        try {
          const registered = await withRetry(
            () => this.phase1_registerBasicInfo(page, staff),
            `Phase1[${staff.staffNumber}]`,
            { maxAttempts: 2, baseDelay: 2000, maxDelay: 10000, backoffMultiplier: 2 },
          );

          if (registered) {
            detail.phase1 = 'registered';
            logger.info(`Phase1 完了: ${staff.staffNumber} ${staff.staffName}`);
          } else {
            detail.phase1 = 'existing';
            result.skipped++;
            result.details.push(detail);
            continue;
          }
        } catch (error) {
          const err = error as Error;
          logger.error(`Phase1 エラー [${staff.staffNumber}]: ${err.message}`);
          detail.phase1 = 'error';
          detail.error = err.message;
          result.errors++;
          await this.tryRecoverToStaffIndex(page);
          result.details.push(detail);
          continue;
        }

        // === Phase 2: 詳細情報編集 ===
        try {
          await this.phase2_editDetails(page, staff);
          detail.phase2 = 'set';
          logger.info(`Phase2 完了: ${staff.staffNumber} ${staff.staffName}`);
        } catch (error) {
          const err = error as Error;
          logger.error(`Phase2 エラー [${staff.staffNumber}]: ${err.message}`);
          detail.phase2 = 'error';
          detail.error = (detail.error ? detail.error + '; ' : '') + `Phase2: ${err.message}`;
        }

        // === Phase 3: HAM 資格登録 ===
        if (staff.qualifications.length > 0) {
          try {
            await this.phase3_registerQualificationsInHam(nav, staff);
            detail.phase3 = 'set';
            logger.info(`Phase3 完了: ${staff.staffNumber} ${staff.staffName}`);
          } catch (error) {
            const err = error as Error;
            logger.error(`Phase3 エラー [${staff.staffNumber}]: ${err.message}`);
            detail.phase3 = 'error';
            detail.error = (detail.error ? detail.error + '; ' : '') + `Phase3: ${err.message}`;
          }
        } else {
          detail.phase3 = 'skipped';
          logger.debug(`Phase3 スキップ（資格なし）: ${staff.staffNumber}`);
        }

        // 最終結果判定
        if (detail.phase1 === 'registered') {
          result.synced++;
        }
        if (detail.phase2 === 'error' || detail.phase3 === 'error') {
          result.errors++;
        }

        // スタッフ一覧に戻る（次のスタッフ処理のため）
        await this.tryRecoverToStaffIndex(page);
        result.details.push(detail);
      }

      logger.info(`スタッフ同期完了: 登録=${result.synced}, スキップ=${result.skipped}, エラー=${result.errors}`);
    } catch (error) {
      logger.error(`スタッフ同期全体エラー: ${(error as Error).message}`);
      result.errors++;
    }

    return result;
  }

  /**
   * Phase 3 のみ実行: 既存スタッフの HAM 資格登録を一括実行する。
   * Phase 1/2 はスキップし、HAM の所有資格チェックのみ行う。
   */
  async syncPhase3Only(departmentKeyword: string = '姶良', limit?: number, offset?: number): Promise<StaffSyncResult> {
    const result: StaffSyncResult = { synced: 0, skipped: 0, errors: 0, details: [] };

    try {
      logger.info(`Phase3 一括実行開始 (部署フィルタ: ${departmentKeyword})`);

      const allCrews = await this.smarthr.getAllCrews();
      const activeCrews = this.smarthr.filterActive(allCrews);
      const filteredCrews = this.smarthr.filterByDepartment(activeCrews, departmentKeyword);
      let staffEntries = filteredCrews.map(c => this.smarthr.toStaffMasterEntry(c));

      if (offset && offset > 0) {
        staffEntries = staffEntries.slice(offset);
        logger.info(`SmartHR: 先頭 ${offset}名をスキップ`);
      }
      if (limit && limit > 0) {
        staffEntries = staffEntries.slice(0, limit);
        logger.info(`SmartHR: ${limit}名に制限`);
      }

      // 資格なしのスタッフは除外
      staffEntries = staffEntries.filter(s => s.qualifications.length > 0);
      logger.info(`Phase3 対象: ${staffEntries.length}名（資格ありのみ）`);

      // ログイン
      const nav = await this.auth.ensureLoggedIn();

      for (const staff of staffEntries) {
        const detail: StaffSyncDetail = {
          staffNumber: staff.staffNumber,
          staffName: staff.staffName,
          phase1: 'existing',
          phase2: 'not-applicable',
          phase3: 'not-applicable',
        };

        try {
          await this.phase3_registerQualificationsInHam(nav, staff);
          detail.phase3 = 'set';
          result.synced++;
          logger.info(`Phase3 完了: ${staff.staffNumber} ${staff.staffName}`);
        } catch (error) {
          const err = error as Error;
          logger.error(`Phase3 エラー [${staff.staffNumber}]: ${err.message}`);
          detail.phase3 = 'error';
          detail.error = err.message;
          result.errors++;
        }

        result.details.push(detail);
      }

      logger.info(`Phase3 一括完了: 成功=${result.synced}, エラー=${result.errors}`);
    } catch (error) {
      logger.error(`Phase3 一括実行全体エラー: ${(error as Error).message}`);
      result.errors++;
    }

    return result;
  }

  /**
   * 指定されたスタッフのみを登録する（転記前の自動補登用）
   *
   * TranscriptionWorkflow から呼ばれる。
   * 既にログイン済みの前提で、渡された StaffMasterEntry[] について
   * Phase 1 → 2 → 3 を実行する。
   */
  async registerSpecificStaff(entries: StaffMasterEntry[], validityStartDate?: string): Promise<StaffSyncResult> {
    const result: StaffSyncResult = { synced: 0, skipped: 0, errors: 0, details: [] };
    if (entries.length === 0) return result;

    logger.info(`スタッフ個別登録開始: ${entries.length}名`);

    const nav = await this.auth.ensureLoggedIn();
    const page = this.auth.page;

    // TRITRUS スタッフ管理ページへ遷移
    await this.navigateToStaffIndex(page);
    const existingNames = await this.getExistingStaffNames(page);

    for (const staff of entries) {
      const detail: StaffSyncDetail = {
        staffNumber: staff.staffNumber,
        staffName: staff.staffName,
        phase1: 'skipped',
        phase2: 'not-applicable',
        phase3: 'not-applicable',
      };

      if (!staff.staffName) {
        logger.warn(`スタッフ情報不完全のためスキップ: ${staff.staffNumber || '(番号なし)'}`);
        result.skipped++;
        result.details.push(detail);
        continue;
      }

      // 番号不一致の既知スタッフをスキップ
      if (SKIP_EMPLOYEE_NUMBERS.has(staff.staffNumber)) {
        logger.debug(`補登スキップ（番号不一致の既知スタッフ）: ${staff.staffNumber} ${staff.staffName}`);
        result.skipped++;
        detail.phase1 = 'existing';
        result.details.push(detail);
        continue;
      }

      // 既存チェック: 従業員番号で TRITRUS 検索（名前マッチより確実）
      if (staff.staffNumber) {
        try {
          const navResult = await this.navigateToStaffByEmpNo(page, staff.staffNumber);
          if (navResult.found) {
            if (!navResult.alreadyHasOffice) {
              // 既存スタッフだが現事業所が未設定 → 事業所のみ追加
              logger.info(`既存スタッフに事業所追加: ${staff.staffNumber} ${staff.staffName}`);
              try {
                const staffInfoUrl = page.url();
                await this.addOfficeToStaffFromCurrentPage(page, staffInfoUrl);
                detail.phase2 = 'set';
                logger.info(`事業所追加完了: ${staff.staffNumber} ${staff.staffName}`);
              } catch (err) {
                detail.phase2 = 'error';
                logger.error(`事業所追加失敗: ${staff.staffNumber} ${staff.staffName}: ${(err as Error).message}`);
              }
            } else {
              logger.debug(`スタッフ既存（従業員番号検索）: ${staff.staffNumber} ${staff.staffName}`);
            }
            result.skipped++;
            detail.phase1 = 'existing';
            result.details.push(detail);
            await this.tryRecoverToStaffIndex(page);
            continue;
          }
        } catch {
          // 検索失敗時は名前マッチにフォールバック
          logger.debug(`従業員番号検索失敗、名前マッチにフォールバック: ${staff.staffNumber}`);
        }
      }

      // フォールバック: 名前マッチ
      const { lastName, firstName } = this.splitName(staff.staffName);
      const fullName = `${lastName} ${firstName}`.trim();
      const isExisting = existingNames.some(
        name => name === fullName || name === staff.staffName || name === staff.staffNameLegal
      );

      if (isExisting) {
        logger.debug(`スタッフ既存（名前マッチ）: ${staff.staffNumber} ${staff.staffName}`);
        result.skipped++;
        detail.phase1 = 'existing';
        result.details.push(detail);
        continue;
      }

      // Phase 1: マスター管理基本登録
      try {
        const registered = await withRetry(
          () => this.phase1_registerBasicInfo(page, staff),
          `Phase1[${staff.staffNumber}]`,
          { maxAttempts: 2, baseDelay: 2000, maxDelay: 10000, backoffMultiplier: 2 },
        );
        if (registered) {
          detail.phase1 = 'registered';
          logger.info(`補登 Phase1 完了: ${staff.staffNumber} ${staff.staffName}`);
        } else {
          detail.phase1 = 'existing';
          result.skipped++;
          result.details.push(detail);
          continue;
        }
      } catch (error) {
        logger.error(`補登 Phase1 エラー [${staff.staffNumber}]: ${(error as Error).message}`);
        detail.phase1 = 'error';
        detail.error = (error as Error).message;
        result.errors++;
        await this.tryRecoverToStaffIndex(page);
        result.details.push(detail);
        continue;
      }

      // Phase 2: 詳細情報編集
      try {
        await this.phase2_editDetails(page, staff, validityStartDate);
        detail.phase2 = 'set';
        logger.info(`補登 Phase2 完了: ${staff.staffNumber} ${staff.staffName}`);
      } catch (error) {
        logger.error(`補登 Phase2 エラー [${staff.staffNumber}]: ${(error as Error).message}`);
        detail.phase2 = 'error';
        detail.error = (detail.error ? detail.error + '; ' : '') + `Phase2: ${(error as Error).message}`;
      }

      // Phase 3: HAM 資格登録
      if (staff.qualifications.length > 0) {
        try {
          await this.phase3_registerQualificationsInHam(nav, staff);
          detail.phase3 = 'set';
          logger.info(`補登 Phase3 完了: ${staff.staffNumber} ${staff.staffName}`);
        } catch (error) {
          logger.error(`補登 Phase3 エラー [${staff.staffNumber}]: ${(error as Error).message}`);
          detail.phase3 = 'error';
          detail.error = (detail.error ? detail.error + '; ' : '') + `Phase3: ${(error as Error).message}`;
        }
      }

      if (detail.phase1 === 'registered') result.synced++;
      if (detail.phase2 === 'error' || detail.phase3 === 'error') result.errors++;

      await this.tryRecoverToStaffIndex(page);
      result.details.push(detail);
    }

    logger.info(`スタッフ個別登録完了: 登録=${result.synced}, スキップ=${result.skipped}, エラー=${result.errors}`);
    return result;
  }

  // ============================================================
  // Phase 1: マスター管理での基本登録
  // ============================================================

  /**
   * Phase 1: TRITRUS スタッフ管理で基本情報を新規登録
   *
   * マニュアル:
   *  - 氏名（フリガナ・漢字）入力
   *  - 資格情報は空欄のまま（HAM で後から設定）
   *  - 代表事業所を設定
   *  - 「登録する」クリック
   */
  private async phase1_registerBasicInfo(page: Page, staff: StaffMasterEntry): Promise<boolean> {
    logger.debug(`Phase1 開始: ${staff.staffNumber} ${staff.staffName}`);

    // 新規追加ページへ遷移
    const addBtn = await page.$('a[href*="staffInfoAdd"], img[alt="新規追加"]');
    if (addBtn) {
      await addBtn.click();
    } else {
      await page.goto(`${BASE_URL}${TRITRUS_STAFF_ADD}`, { waitUntil: 'networkidle', timeout: 30000 });
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    await this.sleep(1000);

    // フォーム確認
    const formExists = await page.$('form#staffInfoForm, form[name="staffInfoActionForm"]');
    if (!formExists) {
      throw new Error('スタッフ登録フォームが見つかりません');
    }

    // === 氏名入力 ===
    const { lastName, firstName } = this.splitName(staff.staffName);
    const { lastName: lastNameKana, firstName: firstNameKana } = this.splitName(staff.staffNameYomi);

    // TRITRUS の氏名入力フィールドは hidden + 表示用の組み合わせ
    // page.fill は visible 要素にしか使えないため、evaluate で hidden field を直接設定
    await page.evaluate((names) => {
      const fields: Record<string, string> = {
        'mStaffInfo.userLastNameKana': names.lastNameKana,
        'mStaffInfo.userFirstNameKana': names.firstNameKana,
        'mStaffInfo.userLastName': names.lastName,
        'mStaffInfo.userFirstName': names.firstName,
      };
      for (const [name, val] of Object.entries(fields)) {
        const inputs = document.querySelectorAll(`input[name="${name}"]`);
        for (const inp of Array.from(inputs)) {
          (inp as HTMLInputElement).value = val;
        }
      }
    }, { lastNameKana, firstNameKana, lastName, firstName });

    // === 性別設定 ===
    // mStaffInfo.sex は hidden field なので evaluate で値を設定
    // 1=男性, 2=女性
    if (staff.gender === 'female') {
      await page.evaluate(() => {
        const el = document.querySelector('input[name="mStaffInfo.sex"]') as HTMLInputElement;
        if (el) el.value = '2';
      });
    } else if (staff.gender === 'male') {
      await page.evaluate(() => {
        const el = document.querySelector('input[name="mStaffInfo.sex"]') as HTMLInputElement;
        if (el) el.value = '1';
      });
    }
    // gender が空の場合はデフォルト値のまま

    // === 資格情報は空欄のまま（マニュアル指示） ===
    // 職種・資格チェックボックスは設定しない。HAM Phase3 で設定する。

    // === 代表事業所の設定 ===
    // hidden フィールドに直接値を設定する方式
    // NOTE: page.evaluate 内で const fn = () => {} を使うと esbuild が __name を注入して
    // ブラウザ側で ReferenceError になるため、インラインで記述する
    await page.evaluate((office) => {
      let el;
      el = document.getElementById('officecdDelegate');
      if (el) el.setAttribute('value', office.cd);
      el = document.getElementById('officenameDelegate');
      if (el) el.setAttribute('value', office.name);
      el = document.getElementById('officeNo');
      if (el) el.textContent = office.cd;
      el = document.getElementById('officeName');
      if (el) el.textContent = office.name;
    }, this.office);

    // === 情報有効期間はデフォルト値のまま ===

    // === 登録実行（入力フォーム → 確認画面 → 登録完了） ===
    logger.debug(`Phase1 フォーム入力完了: ${staff.staffName}`);

    // Step 1: 入力フォームの「登録する」をクリック → 確認画面へ遷移
    page.once('dialog', async (dialog) => {
      logger.debug(`Phase1 確認ダイアログ: ${dialog.message()}`);
      await dialog.accept();
    });

    await page.click('#regist');
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    await this.sleep(2000);

    // エラーチェック（入力バリデーション）
    const validationError = await page.evaluate(() => {
      const el = document.querySelector('.errorMessage, .error, .alert-danger');
      return el?.textContent?.trim() || '';
    });

    if (validationError) {
      throw new Error(`Phase1 入力エラー: ${validationError}`);
    }

    // Step 2: 確認画面（スタッフ登録確認）の「登録する」をクリック → 実際に登録
    // 確認画面かどうかをチェック
    const isConfirmPage = await page.evaluate(() => {
      const heading = document.querySelector('h2, h3, .title, .heading');
      const body = document.body?.textContent || '';
      return body.includes('スタッフ登録確認') || body.includes('登録確認');
    });

    if (isConfirmPage) {
      logger.debug(`Phase1 確認画面に到達: ${staff.staffName}`);

      // 確認画面の「登録する」ボタンをクリック
      // 確認画面のボタンは id="update", onclick="insertStaffInfo();return false;"
      page.once('dialog', async (dialog) => {
        logger.debug(`Phase1 登録確認ダイアログ: ${dialog.message()}`);
        await dialog.accept();
      });

      const confirmBtn = await page.$('#update');
      if (confirmBtn) {
        await confirmBtn.click();
      } else {
        // フォールバック: テキストで検索
        const linkBtn = await page.$('a:has-text("登録する"), input[type="submit"][value*="登録"]');
        if (linkBtn) {
          await linkBtn.click();
        } else {
          throw new Error('Phase1 確認画面の登録ボタンが見つかりません');
        }
      }

      await page.waitForLoadState('networkidle', { timeout: 30000 });
      await this.sleep(2000);

      // 登録後のエラーチェック
      const registerError = await page.evaluate(() => {
        const el = document.querySelector('.errorMessage, .error, .alert-danger');
        return el?.textContent?.trim() || '';
      });

      if (registerError) {
        throw new Error(`Phase1 登録エラー: ${registerError}`);
      }
    } else {
      logger.warn(`Phase1 確認画面が検出されませんでした。現在のURL: ${page.url()}`);
    }

    logger.info(`Phase1 基本登録完了: ${staff.staffNumber} ${staff.staffName}`);
    return true;
  }

  // ============================================================
  // Phase 2: 詳細情報の編集
  // ============================================================

  /**
   * Phase 2: 保存後の詳細情報編集
   *
   * マニュアル:
   *  - 従業員情報・編集: 雇用形態=スタッフ, 従業員番号, 入社日
   *  - 事業所設定: 対象事業所を選択
   *  - アカウント情報: ログインID=ACGP+従業員番号, パスワード=Acgp2308!
   */
  private async phase2_editDetails(page: Page, staff: StaffMasterEntry, validityStartDate?: string): Promise<void> {
    logger.debug(`Phase2 開始: ${staff.staffNumber} ${staff.staffName}`);

    // Phase1 登録完了後は /tritrus/staffInfo/staffInfoInsert に遷移している
    // そこに「その他情報を登録する」リンク (/tritrus/staffInfo/staffInfo?userId=XXX) がある
    const currentUrl = page.url();

    // スタッフ情報ページ (staffInfo?userId=XXX) への遷移
    if (currentUrl.includes('staffInfoInsert') || currentUrl.includes('登録完了')) {
      // 登録完了ページ → 「その他情報を登録する」リンクをクリック
      const otherInfoLink = await page.$('a[href*="staffInfo/staffInfo?userId="]');
      if (otherInfoLink) {
        await otherInfoLink.click();
        await page.waitForLoadState('networkidle', { timeout: 15000 });
        await this.sleep(1000);
      } else {
        logger.warn('Phase2 「その他情報を登録する」リンクが見つかりません');
        return;
      }
    } else if (!currentUrl.includes('staffInfo/staffInfo?userId=')) {
      // staffInfo ページでない場合はスキップ
      logger.warn(`Phase2 スキップ: 想定外のページ URL=${currentUrl}`);
      return;
    }

    // === 従業員情報の新規追加 ===
    // Playwright MCP 検証済 (2026-02-26):
    //   URL: /tritrus/staffInfo/employee?userId=XXX&flg=add
    //   雇用形態: select[name="mEmployee.employeeKbn"] id="employeeKbn" (value="1"=スタッフ, 唯一の選択肢・既定選択済み)
    //   従業員番号: input[name="mEmployee.employeeNo"] id="employeeNo" type="text"
    //   入社日: input[name="mEmployee.hireDate"] id="hireDate" type="text"
    //   登録: javascript:formsub('employee')
    const empAddLink = await page.$('a[href*="employee"][href*="flg=add"]');
    if (empAddLink) {
      await empAddLink.click();
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      await this.sleep(1000);

      // 雇用形態はデフォルトで「スタッフ」(value=1) が選択済み — 変更不要

      // 従業員番号のみ設定（入社日等は不要）
      await page.evaluate((staffNum) => {
        const el = document.getElementById('employeeNo') as HTMLInputElement;
        if (el) el.value = staffNum;
      }, staff.staffNumber);
      logger.debug(`Phase2 従業員番号入力: ${staff.staffNumber}`);

      // 登録ボタン — javascript:formsub('employee')
      page.once('dialog', async (dialog) => {
        logger.debug(`Phase2 従業員情報ダイアログ: ${dialog.message()}`);
        await dialog.accept();
      });
      await page.evaluate(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const win = window as any;
        if (typeof win.formsub === 'function') {
          win.formsub('employee');
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
      });
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      await this.sleep(1500);

      logger.debug(`Phase2 従業員情報設定完了: ${staff.staffNumber}`);
    } else {
      logger.warn(`Phase2 従業員情報・新規追加リンクが見つかりません: ${staff.staffNumber}`);
    }

    // スタッフ情報ページに戻る
    // 従業員情報保存後のリダイレクト先を確認
    const staffInfoUrl = await this.ensureStaffInfoPage(page);

    // === 事業所設定 ===
    // staffInfo ページの「新規追加」→ Thickbox iframe ポップアップ
    // iframe 内: 事業所名検索 → チェック → 「選択する」→ 自動閉じ
    await this.phase2_setOffice(page, staffInfoUrl);

    // === 情報有効期間の修正 ===
    if (validityStartDate) {
      await this.ensureStaffInfoPage(page);
      await this.updateOfficeValidityPeriod(page, validityStartDate);
    }

    // スタッフ情報ページに戻る
    await this.ensureStaffInfoPage(page);

    // === アカウント情報の新規追加 ===
    // Playwright MCP 検証済 (2026-02-26):
    //   URL: /tritrus/staffInfo/mAccountInit?userId=XXX&flg=add
    //   ログインID: input[name="mAccount.loginId"] id="loginId" type="text"
    //     ※ "ACGP" プレフィックスは hidden field mAccount.topMouji に既設定
    //     ※ loginId には従業員番号のみ入力すればよい（最終ID = ACGP + loginId）
    //   パスワード: input[name="mAccount.loginPass"] id="passwd" type="password"
    //   登録: javascript:checkSel()
    const accountAddLink = await page.$('a[href*="mAccountInit"][href*="flg=add"]');
    if (accountAddLink) {
      await accountAddLink.click();
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      await this.sleep(1000);

      // ログインID — 従業員番号のみ（ACGP プレフィックスは topMouji hidden field で自動付与）
      await page.evaluate((staffNum) => {
        const el = document.getElementById('loginId') as HTMLInputElement;
        if (el) el.value = staffNum;
      }, staff.staffNumber);
      logger.debug(`Phase2 ログインID入力: ${ACCOUNT_PREFIX}${staff.staffNumber}`);

      // パスワード
      await page.evaluate((pwd) => {
        const el = document.getElementById('passwd') as HTMLInputElement;
        if (el) el.value = pwd;
      }, ACCOUNT_PASSWORD);

      // 登録ボタン — javascript:checkSel()
      page.once('dialog', async (dialog) => {
        logger.debug(`Phase2 アカウント情報ダイアログ: ${dialog.message()}`);
        await dialog.accept();
      });
      await page.evaluate(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const win = window as any;
        if (typeof win.checkSel === 'function') {
          win.checkSel();
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
      });
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      await this.sleep(1500);

      logger.debug(`Phase2 アカウント情報設定完了: ${ACCOUNT_PREFIX}${staff.staffNumber}`);
    } else {
      logger.warn(`Phase2 アカウント情報・新規追加リンクが見つかりません: ${staff.staffNumber}`);
    }

    logger.info(`Phase2 詳細情報編集完了: ${staff.staffNumber} ${staff.staffName}`);
  }

  // ============================================================
  // Phase 3: HAM 資格登録
  // ============================================================

  /**
   * Phase 3: HAM スタッフマスタで所有資格チェックボックスを設定
   *
   * マニュアル:
   *  - HAM → マスター → スタッフマスター管理 (h1-1)
   *  - 登録スタッフ一覧 (h1-1a) → 詳細 (h1-1b)
   *  - 所有資格チェックボックスを設定
   *  - データ上書き保存 → 終了
   */
  private async phase3_registerQualificationsInHam(nav: HamNavigator, staff: StaffMasterEntry): Promise<void> {
    logger.debug(`Phase3 開始: ${staff.staffNumber} ${staff.staffName} 資格=[${staff.qualifications.join(',')}]`);

    // HAM メインメニュー (t1-2) に確実に戻る
    await this.ensureHamMainMenu(nav);

    // HAM メインメニューからスタッフマスタ管理へ (h1-1)
    await this.auth.navigateToStaffMaster();
    await this.sleep(1500);

    // 「登録スタッフ一覧」へ遷移 (h1-1 → h1-1a)
    await nav.submitForm({
      action: 'act_edit',
      waitForPageId: 'h1-1a',
      timeout: 15000,
    });
    await this.sleep(2000);

    // h1-1a: フレーム取得 + JS ロード待機
    const h1_1aFrame = await nav.waitForMainFrame('h1-1a', 15000);
    await this.waitForFrameFunction(h1_1aFrame, 'xinwork_searchKeyword', 10000);

    // 50音順で全件検索を実行
    await h1_1aFrame.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const win = window as any;
      win.submited = 0;
      const form = document.forms[0];
      form.doAction.value = 'act_search';
      form.target = 'commontarget';
      if (form.doTarget) form.doTarget.value = 'commontarget';
      form.submit();
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });

    // 検索結果が mainFrame にロードされるまで待機（「詳細」ボタン出現まで）
    let h1_1aFrameAfter: Frame | null = null;
    const searchStart = Date.now();
    while (Date.now() - searchStart < 15000) {
      await this.sleep(1000);
      try {
        const frame = await nav.getMainFrame();
        const count = await frame.evaluate(() =>
          document.querySelectorAll('input[type="button"][name="act_edit"][value="詳細"]').length
        ).catch(() => 0);
        if (count > 0) { h1_1aFrameAfter = frame; break; }
      } catch { /* フレーム未準備 */ }
    }
    if (!h1_1aFrameAfter) {
      throw new Error('HAM h1-1a 検索結果が表示されませんでした（タイムアウト）');
    }
    logger.debug('Phase3 h1-1a 検索結果ロード完了');

    // ---- Step 1: 対象スタッフの「詳細」ボタンを特定して Playwright click ----
    // h1-1a の HTML 構造:
    //   <tr>
    //     <td><input name="act_edit" value="詳細" onclick="return submitHelper(this.form,'act_edit',998223686);"></td>
    //     <td>1870</td>
    //     <td>乾 真子</td>
    //     ...
    //   </tr>
    // onclick に helperId がリテラルで埋め込まれているため、Playwright native click で正しく動作する
    const targetIndex = await h1_1aFrameAfter.evaluate((staffNum) => {
      const btns = document.querySelectorAll('input[type="button"][name="act_edit"][value="詳細"]');
      for (let i = 0; i < btns.length; i++) {
        const row = btns[i].closest('tr');
        const cells = row?.querySelectorAll('td');
        if (cells && cells.length >= 2) {
          const empNo = cells[1]?.textContent?.trim();
          if (empNo === staffNum) return i;
        }
      }
      return -1;
    }, staff.staffNumber);

    if (targetIndex < 0) {
      throw new Error(`HAM h1-1a でスタッフが見つかりません: ${staff.staffName} (${staff.staffNumber})`);
    }

    // submited ロックを解除してから Playwright native click
    await h1_1aFrameAfter.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      (window as any).submited = 0;
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    const detailBtns = await h1_1aFrameAfter.$$('input[type="button"][name="act_edit"][value="詳細"]');
    await detailBtns[targetIndex].click();
    logger.debug(`Phase3 「詳細」クリック: index=${targetIndex} for ${staff.staffName}`);

    await this.sleep(3000);

    // ---- Step 2: h1-1b 詳細ページで資格チェックボックスを設定 ----
    const h1_1bFrame = await nav.waitForMainFrame('h1-1b', 15000);

    const qualActions = staff.qualifications
      .map(q => ({ qual: q, action: HAM_QUALIFICATION_MAP[q] }))
      .filter(item => item.action);

    if (qualActions.length > 0) {
      // 全 licence チェックボックスを OFF → 対象のみ ON（前回の誤設定クリア）
      const actions = qualActions.map(item => ({
        qual: item.qual,
        checkboxId: item.action.checkboxId || null,
        checkboxName: item.action.checkboxName || null,
        radioName: item.action.radioName || null,
        radioValue: item.action.radioValue || null,
      }));

      const checkResult = await h1_1bFrame.evaluate((params) => {
        const matched: string[] = [];

        // まず全 licence チェックボックスを OFF（class="licence-check" のもの）
        const allCbs = document.querySelectorAll('input.licence-check[type="checkbox"]');
        for (const cb of Array.from(allCbs)) {
          (cb as HTMLInputElement).checked = false;
        }
        // licence5s, licence1s も OFF
        const specialCbs = document.querySelectorAll('input[name="licence5s"], input[name="licence1s"]');
        for (const cb of Array.from(specialCbs)) {
          (cb as HTMLInputElement).checked = false;
        }

        for (const act of params) {
          // checkbox をチェック
          if (act.checkboxId) {
            const cb = document.getElementById(act.checkboxId) as HTMLInputElement;
            if (cb) {
              cb.checked = true;
              matched.push(`${act.qual} → #${act.checkboxId}`);
            }
          } else if (act.checkboxName) {
            const cb = document.querySelector(`input[name="${act.checkboxName}"]`) as HTMLInputElement;
            if (cb) {
              cb.checked = true;
              matched.push(`${act.qual} → [name=${act.checkboxName}]`);
            }
          }

          // radio をセット（看護師/准看護師用）
          if (act.radioName && act.radioValue) {
            const radio = document.querySelector(
              `input[type="radio"][name="${act.radioName}"][value="${act.radioValue}"]`
            ) as HTMLInputElement;
            if (radio) {
              radio.checked = true;
              matched.push(`${act.qual} → radio[${act.radioName}]=${act.radioValue}`);
            }
          }
        }

        return { matched };
      }, actions);

      logger.debug(`Phase3 資格チェック: ${JSON.stringify(checkResult.matched)}`);
    }

    // ---- Step 3: 「データ上書き保存」を Playwright native click ----
    await h1_1bFrame.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      (window as any).submited = 0;
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    const saveBtn = await h1_1bFrame.$('#Submit01, input[value="データ上書き保存"]');
    if (saveBtn) {
      await saveBtn.click();
      logger.debug('Phase3 「データ上書き保存」クリック');
    } else {
      throw new Error('Phase3 「データ上書き保存」ボタンが見つかりません');
    }
    await this.sleep(3000);

    // ---- Step 4: 「終了」を Playwright native click で詳細ページを閉じる ----
    try {
      const frameAfterSave = await nav.getMainFrame();
      const endBtn = await frameAfterSave.$('input[value="終了"]');
      if (endBtn) {
        await endBtn.click();
        logger.debug('Phase3 「終了」クリック');
        await this.sleep(2000);
      } else {
        logger.debug('Phase3 「終了」ボタン未検出');
      }
    } catch {
      logger.debug('Phase3 「終了」スキップ（フレーム変更）');
    }

    // メインメニューに戻る
    await this.ensureHamMainMenu(nav);

    logger.info(`Phase3 HAM 資格登録完了: ${staff.staffNumber} ${staff.staffName}`);
  }

  // ============================================================
  // ヘルパーメソッド
  // ============================================================

  /**
   * HAM メインメニュー (t1-2) に確実に復帰する
   * Phase3 の繰り返し実行時にフレーム状態が壊れることを防ぐ
   */
  private async ensureHamMainMenu(nav: HamNavigator): Promise<void> {
    try {
      const currentPageId = await nav.getCurrentPageId();
      if (currentPageId === 't1-2') {
        logger.debug('HAM: 既にメインメニュー (t1-2) にいます');
        return;
      }

      // act_back を最大3回試行してメインメニューへ戻る
      for (let i = 0; i < 3; i++) {
        try {
          await nav.submitForm({ action: 'act_back', timeout: 5000 });
          await this.sleep(1000);
          const pageId = await nav.getCurrentPageId();
          if (pageId === 't1-2') {
            logger.debug('HAM: メインメニュー (t1-2) に復帰');
            return;
          }
        } catch {
          // 失敗しても次を試す
        }
      }

      // フォールバック: topFrame のメニューリンクを直接クリック
      logger.warn('HAM: act_back によるメインメニュー復帰に失敗。topFrame 経由で復帰を試みます');
      const hamPage = nav.hamPage;
      const topFrame = hamPage.frame('topFrame');
      if (topFrame) {
        const menuLink = await topFrame.$('a[href*="t1-2"], a:has-text("メニュー"), a:has-text("戻る")');
        if (menuLink) {
          await menuLink.click();
          await this.sleep(2000);
        }
      }
    } catch (error) {
      logger.warn(`HAM メインメニュー復帰エラー: ${(error as Error).message}`);
    }
  }

  /**
   * フレーム内の JavaScript 関数が利用可能になるまで待機
   */
  private async waitForFrameFunction(frame: Frame, funcName: string, timeout: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const available = await frame.evaluate((name) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        return typeof (window as any)[name] === 'function';
        /* eslint-enable @typescript-eslint/no-explicit-any */
      }, funcName).catch(() => false);
      if (available) {
        logger.debug(`フレーム関数 ${funcName} が利用可能`);
        return;
      }
      await this.sleep(500);
    }
    throw new Error(`フレーム関数 ${funcName} が ${timeout}ms 以内に利用可能になりませんでした`);
  }

  /**
   * スタッフ情報ページ (/tritrus/staffInfo/staffInfo?userId=XXX) に戻る
   * 従業員情報保存や事業所設定後のリダイレクト先から復帰するために使用
   */
  private async ensureStaffInfoPage(page: Page): Promise<string> {
    const currentUrl = page.url();
    logger.debug(`ensureStaffInfoPage: 現在URL=${currentUrl}`);

    if (currentUrl.includes('staffInfo/staffInfo?userId=')) {
      logger.debug(`既にスタッフ情報ページにいます: ${currentUrl}`);
      return currentUrl;
    }

    // staffInfoUrl パターンから userId を抽出して直接遷移する方式を優先
    // （リンククリックよりも確実）
    const userIdMatch = currentUrl.match(/userId=(\d+)/);
    if (userIdMatch) {
      const userId = userIdMatch[1];
      const staffInfoUrl = `${BASE_URL}/tritrus/staffInfo/staffInfo?userId=${userId}`;
      logger.debug(`ensureStaffInfoPage: userId=${userId} で直接遷移`);
      await page.goto(staffInfoUrl, { waitUntil: 'load', timeout: 30000 });
      await this.sleep(1500);
      return page.url();
    }

    // URL に userId がない場合: リンクで戻る
    const backLink = await page.$('a[href*="staffInfo/staffInfo?userId="]');
    if (backLink) {
      const href = await backLink.getAttribute('href');
      logger.debug(`ensureStaffInfoPage: リンク経由で遷移 href=${href}`);
      await backLink.click();
      await page.waitForLoadState('load', { timeout: 30000 });
      await this.sleep(1500);
      return page.url();
    }

    // フォールバック: ブラウザの戻るで対応
    logger.warn('ensureStaffInfoPage: staffInfo リンクが見つからないため goBack を使用');
    await page.goBack();
    await page.waitForLoadState('load', { timeout: 15000 });
    await this.sleep(1000);
    return page.url();
  }

  /**
   * Phase 2: 事業所設定
   *
   * staffInfo ページの事業所設定「新規追加」をクリック → Thickbox iframe が開く
   * → iframe 内で事業所名検索 → チェック → 「選択する」→ iframe が閉じて親ページ更新
   *
   * 重要: 直接 URL 遷移ではなく、Thickbox iframe ポップアップ経由で操作する。
   *   checkOffice() は parent.tb_remove() を呼んで iframe を閉じるため、
   *   iframe コンテキスト内で操作する必要がある。
   */
  private async phase2_setOffice(page: Page, _staffInfoUrl: string): Promise<void> {
    logger.debug(`Phase2 事業所設定開始`);

    // 重複チェック: 「新規追加」リンクの近くの事業所設定テーブルにデータ行があるか確認。
    // 代表事業所（ページ上部）と事業所設定（下部テーブル）は別概念。
    const officeAlreadySet = await page.evaluate((officeCd) => {
      const addLink = document.querySelector('a[href*="userOfficeSearch"]');
      if (!addLink) return false;
      // 新規追加リンクが所属するテーブルまたは直近のテーブルを探す
      const section = addLink.closest('table')?.parentElement || addLink.parentElement;
      if (!section) return false;
      const tables = section.querySelectorAll('table');
      for (const table of Array.from(tables)) {
        const rows = table.querySelectorAll('tr');
        for (const row of Array.from(rows)) {
          if (row.querySelector('th')) continue;
          const cells = row.querySelectorAll('td');
          for (const cell of Array.from(cells)) {
            if (cell.textContent?.trim() === officeCd) return true;
          }
        }
      }
      return false;
    }, this.office.cd);

    if (officeAlreadySet) {
      logger.info(`Phase2 事業所設定: ${this.office.name} (${this.office.cd}) は既に設定済み — スキップ`);
      return;
    }

    // 「新規追加」リンクをクリック → Thickbox iframe が開く
    const addOfficeLink = await page.$('a[href*="userOfficeSearch"][href*="TB_iframe"]');
    if (!addOfficeLink) {
      logger.warn('Phase2 事業所設定: 新規追加リンクが見つかりません');
      return;
    }

    await addOfficeLink.click();
    await this.sleep(2000);

    // Thickbox iframe を待つ
    const iframeEl = await page.waitForSelector('#TB_iframeContent', { timeout: 10000 });
    if (!iframeEl) {
      logger.warn('Phase2 事業所設定: Thickbox iframe が表示されません');
      return;
    }

    const iframe = await iframeEl.contentFrame();
    if (!iframe) {
      logger.warn('Phase2 事業所設定: iframe contentFrame が取得できません');
      return;
    }
    await iframe.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    await this.sleep(1000);

    // iframe 内の構造をログ出力（デバッグ用）
    const iframeDebug = await iframe.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map(
        i => `${i.type}[name=${i.name}][id=${i.id}][value=${i.value}]`
      );
      const links = Array.from(document.querySelectorAll('a')).map(
        a => `<a>${a.textContent?.trim()} onclick=${a.getAttribute('onclick')?.substring(0, 60)}`
      );
      return { inputs: inputs.slice(0, 20), links: links.slice(0, 10), bodyLen: document.body?.innerHTML?.length || 0 };
    });
    logger.debug(`Phase2 iframe 構造: inputs=${JSON.stringify(iframeDebug.inputs)}, links=${JSON.stringify(iframeDebug.links)}`);

    // iframe 内: 事業所名で検索
    const searchFieldExists = await iframe.$('input[name="queryCareofficeName"]');
    if (searchFieldExists) {
      await iframe.fill('input[name="queryCareofficeName"]', this.office.name);
    } else {
      await iframe.evaluate((officeName) => {
        const el = document.querySelector('input[name*="officeName"], input[name*="office"]') as HTMLInputElement;
        if (el) el.value = officeName;
      }, this.office.name);
    }
    logger.debug(`Phase2 事業所検索: ${this.office.name}`);

    // 検索ボタンクリック
    const searchBtn = await iframe.$('input[type="submit"][value*="検索"], input[type="button"][value*="検索"], a:has-text("検索")');
    if (searchBtn) {
      await searchBtn.click();
    } else {
      logger.warn('Phase2 事業所設定: 検索ボタンが見つかりません。フォーム送信にフォールバック');
      await iframe.evaluate(() => {
        const form = document.querySelector('form') as HTMLFormElement;
        if (form) form.submit();
      });
    }
    await this.sleep(3000);

    // 検索後の iframe 再取得
    const iframeElAfter = await page.$('#TB_iframeContent');
    const iframeAfter = iframeElAfter ? await iframeElAfter.contentFrame() : null;
    if (!iframeAfter) {
      logger.warn('Phase2 事業所設定: 検索後の iframe が取得できません');
      return;
    }
    await iframeAfter.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    await this.sleep(1000);

    // 検索結果のデバッグ情報
    const searchResultDebug = await iframeAfter.evaluate(() => {
      const cbs = Array.from(document.querySelectorAll('input[type="checkbox"]')).map(
        cb => `[name=${cb.getAttribute('name')}][id=${cb.id}][value=${(cb as HTMLInputElement).value}]`
      );
      const trs = document.querySelectorAll('table tr');
      return { checkboxes: cbs, rowCount: trs.length, bodyText: document.body?.textContent?.substring(0, 300) };
    });
    logger.debug(`Phase2 検索結果: checkboxes=${JSON.stringify(searchResultDebug.checkboxes)}, rows=${searchResultDebug.rowCount}`);

    // チェックボックスを Playwright native click で選択（evaluate よりも確実）
    let checkboxClicked = false;
    const cbSelectors = [
      '#mkbn_0',
      'input[name="mStaffServiceOffice.officeIdList"]',
      'input[type="checkbox"][name*="office"]',
      'input[type="checkbox"]',
    ];
    for (const sel of cbSelectors) {
      const cb = await iframeAfter.$(sel);
      if (cb) {
        const isChecked = await cb.isChecked().catch(() => false);
        if (!isChecked) {
          await cb.click();
        }
        checkboxClicked = true;
        logger.debug(`Phase2 チェックボックス選択: ${sel}`);
        break;
      }
    }

    if (!checkboxClicked) {
      logger.warn(`Phase2 事業所設定: チェックボックスが見つかりません。検索結果: ${searchResultDebug.bodyText?.substring(0, 200)}`);
      return;
    }

    // 「選択する」リンクを Playwright native click で実行
    // checkOffice() は parent.tb_remove() を呼んで Thickbox を閉じ、親ページにデータ送信する
    page.once('dialog', async (dialog) => {
      logger.debug(`Phase2 事業所設定ダイアログ: ${dialog.message()}`);
      await dialog.accept();
    });

    const selectLink = await iframeAfter.$('a[onclick*="checkOffice"]');
    if (selectLink) {
      logger.debug('Phase2 「選択する」リンクを Playwright click で実行');
      await selectLink.click();
    } else {
      // フォールバック: テキストで探す
      const textLink = await iframeAfter.$('a:has-text("選択"), input[type="button"][value*="選択"]');
      if (textLink) {
        logger.debug('Phase2 「選択する」をテキストマッチで Playwright click');
        await textLink.click();
      } else {
        // 最終フォールバック: evaluate で checkOffice を直接呼ぶ
        logger.warn('Phase2 「選択する」リンクが見つかりません。evaluate で checkOffice 呼び出しを試行');
        const evalResult = await iframeAfter.evaluate(() => {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          const win = window as any;
          const hasFunc = typeof win.checkOffice === 'function';
          const link = document.querySelector('a[onclick*="checkOffice"], a[onclick*="check"]');
          const allLinks = Array.from(document.querySelectorAll('a')).map(a => a.textContent?.trim()).filter(Boolean);
          if (hasFunc && link) {
            win.checkOffice(link);
            return { called: true, allLinks };
          }
          return { called: false, hasFunc, linkFound: !!link, allLinks };
          /* eslint-enable @typescript-eslint/no-explicit-any */
        });
        logger.debug(`Phase2 checkOffice evaluate 結果: ${JSON.stringify(evalResult)}`);
      }
    }

    // Thickbox が閉じるのを待つ
    await this.sleep(3000);

    // 親ページの更新を待つ（checkOffice → 親ページ再読み込み）
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await this.sleep(1000);

    // Thickbox overlay が残っている場合は手動で除去
    await page.evaluate(() => {
      const overlay = document.getElementById('TB_overlay');
      if (overlay) overlay.remove();
      const tbWindow = document.getElementById('TB_window');
      if (tbWindow) tbWindow.remove();
    });

    // 事業所が設定されたか検証
    const verifyResult = await page.evaluate((officeCd) => {
      const body = document.body?.textContent || '';
      const tables = document.querySelectorAll('table');
      let officeTableFound = false;
      for (const table of Array.from(tables)) {
        const rows = table.querySelectorAll('tr');
        for (const row of Array.from(rows)) {
          const text = row.textContent || '';
          if (text.includes('サービス種類') && text.includes('事業所名')) {
            officeTableFound = true;
          }
          if (officeTableFound && text.includes(officeCd)) {
            return { success: true };
          }
        }
      }
      return { success: false, officeTableFound };
    }, this.office.cd);

    if (verifyResult.success) {
      logger.info(`Phase2 事業所設定完了: ${this.office.name} が登録されました`);
    } else {
      logger.warn(`Phase2 事業所設定: 登録確認できず (officeTableFound=${verifyResult.officeTableFound})`);
    }
  }

  /**
   * TRITRUS スタッフ管理ページへ遷移
   */
  private async navigateToStaffIndex(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (currentUrl.includes('/tritrus/staffInfo/index')) {
      logger.debug('既にスタッフ管理ページにいます');
      return;
    }

    await page.goto(`${BASE_URL}${TRITRUS_MASTER}`, { waitUntil: 'networkidle', timeout: 30000 });
    await this.sleep(1000);

    const staffLink = await page.$(`a[href="${TRITRUS_STAFF_INDEX}"], a[href*="staffInfo"]`);
    if (staffLink) {
      await staffLink.click();
    } else {
      await page.goto(`${BASE_URL}${TRITRUS_STAFF_INDEX}`, { waitUntil: 'networkidle', timeout: 30000 });
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    await this.sleep(1000);
    logger.debug('TRITRUS スタッフ管理ページに遷移');
  }

  /**
   * 既存スタッフの氏名リストを取得
   */
  private async getExistingStaffNames(page: Page): Promise<string[]> {
    try {
      return await page.evaluate(() => {
        const rows = document.querySelectorAll('table tr');
        const names: string[] = [];
        for (const row of Array.from(rows)) {
          const cells = row.querySelectorAll('td');
          for (const cell of Array.from(cells)) {
            const text = cell.textContent?.trim() || '';
            if (/^[\u3000-\u9FFF\uFF00-\uFFEF]+[\s\u3000]+[\u3000-\u9FFF\uFF00-\uFFEF]+$/.test(text)) {
              names.push(text.replace(/\s+/g, ' ').trim());
            }
          }
        }
        return names;
      });
    } catch {
      logger.warn('既存スタッフ名の取得に失敗');
      return [];
    }
  }

  // ============================================================
  // 既存スタッフへの事業所追加
  // ============================================================

  /**
   * TRITRUS スタッフ管理ページで従業員番号を検索し、staffInfo ページに遷移する。
   *
   * 検索フォーム: 従業員番号入力 → 検索 → 結果テーブル「選択」→ staffInfo?userId=XXX
   *
   * @returns true=staffInfo ページに遷移済み, false=見つからない
   */
  /**
   * @returns { found, alreadyHasOffice } — found=staffInfo に遷移済み, alreadyHasOffice=検索結果で対象事業所が既に表示
   */
  async navigateToStaffByEmpNo(page: Page, empNo: string): Promise<{ found: boolean; alreadyHasOffice: boolean }> {
    await this.navigateToStaffIndex(page);

    // 従業員番号フィールドに入力（id で特定: q_queryEmployeeNo）
    await page.evaluate((num) => {
      const lastName = document.getElementById('q_queryUserLastName') as HTMLInputElement;
      if (lastName) lastName.value = '';
      const firstName = document.getElementById('q_queryUserFirstName') as HTMLInputElement;
      if (firstName) firstName.value = '';
      const empNoInput = document.getElementById('q_queryEmployeeNo') as HTMLInputElement;
      if (empNoInput) {
        empNoInput.value = num;
      } else {
        const byName = document.querySelector('input[name*="queryEmployeeNo"]') as HTMLInputElement;
        if (byName) byName.value = num;
      }
    }, empNo);

    // 検索実行
    const searchBtn = await page.$('img[alt*="この条件で検索"]');
    if (searchBtn) {
      await searchBtn.click();
    } else {
      await page.evaluate(() => {
        const form = document.querySelector('form') as HTMLFormElement;
        if (form) form.submit();
      });
    }
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await this.sleep(2000);

    // 検索結果テーブルから従業員番号が完全一致する行を探す
    // テーブル行: 従業員番号(td[0]) | フリガナ/氏名(td[1]) | 生年月日(td[2]) | 住所(td[3]) | 事業所名(td[4]) | 選択 | 表示
    // 事業所名セルに対象事業所が既にある場合、Phase2 をスキップできる
    const result = await page.evaluate(({ targetEmpNo, officeName }) => {
      const rows = document.querySelectorAll('table tr');
      for (const row of Array.from(rows)) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 5) continue;
        const empNoCell = cells[0]?.textContent?.trim() || '';
        if (empNoCell !== targetEmpNo) continue;

        // 事業所名セル（td[4]）に対象事業所が既にあるか
        const officeCell = cells[4]?.textContent || '';
        const hasOffice = officeCell.includes(officeName);

        // 選択ボタンをクリック
        const btn = row.querySelector('input[type="button"][value="選択"]');
        if (btn) {
          (btn as HTMLElement).click();
          return { found: true, alreadyHasOffice: hasOffice, empNo: empNoCell };
        }
      }
      return { found: false, alreadyHasOffice: false };
    }, { targetEmpNo: empNo, officeName: this.office.name });

    if (!result.found) {
      logger.warn(`navigateToStaffByEmpNo: 従業員番号 ${empNo} に完全一致する行なし`);
      return { found: false, alreadyHasOffice: false };
    }

    if (result.alreadyHasOffice) {
      logger.info(`navigateToStaffByEmpNo: ${empNo} — ${this.office.name} 既に設定済み（検索結果で確認）`);
    }
    logger.debug(`navigateToStaffByEmpNo: 従業員番号 ${result.empNo} の行を選択`);

    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await this.sleep(2000);

    const currentUrl = page.url();
    if (currentUrl.includes('staffInfo/staffInfo?userId=')) {
      logger.debug(`navigateToStaffByEmpNo: ${empNo} → ${currentUrl}`);
      return { found: true, alreadyHasOffice: result.alreadyHasOffice };
    }

    logger.warn(`navigateToStaffByEmpNo: 遷移先が想定外: ${currentUrl}`);
    return { found: false, alreadyHasOffice: false };
  }

  /**
   * 既存スタッフに事業所を追加 + 情報有効期間修正 + HAM 資格登録。
   * Phase2(TRITRUS事業所設定) → 有効期間修正 → Phase3(HAM資格) の一連のフローを実行。
   *
   * @param empNo 従業員番号
   * @param staffEntry SmartHR 由来のスタッフ情報（HAM 資格登録に使用）。null なら Phase3 スキップ。
   * @param validityStartDate 情報有効期間の開始日 "YYYY/MM/DD"。省略時は修正なし。
   */
  async addOfficeToStaff(
    page: Page,
    empNo: string,
    staffEntry?: StaffMasterEntry | null,
    validityStartDate?: string,
  ): Promise<void> {
    logger.debug(`addOfficeToStaff: 従業員番号=${empNo}`);

    const navResult = await this.navigateToStaffByEmpNo(page, empNo);
    if (!navResult.found) {
      throw new Error(`TRITRUS でスタッフが見つかりません: 従業員番号=${empNo}`);
    }

    // Phase 2: TRITRUS 事業所追加（検索結果で既にある場合はスキップ）
    if (!navResult.alreadyHasOffice) {
      const staffInfoUrl = page.url();
      await this.phase2_setOffice(page, staffInfoUrl);
    } else {
      logger.info(`Phase2 スキップ: ${empNo} — ${this.office.name} 既に設定済み`);
    }

    // 情報有効期間を修正（事業所の有無に関わらず常にチェック）
    if (validityStartDate) {
      await this.ensureStaffInfoPage(page);
      await this.updateOfficeValidityPeriod(page, validityStartDate);
    }

    // Phase 3: HAM 資格登録
    if (staffEntry && staffEntry.qualifications.length > 0) {
      try {
        const nav = this.auth.navigator;
        await this.phase3_registerQualificationsInHam(nav, staffEntry);
      } catch (error) {
        logger.warn(`Phase3 HAM 資格登録失敗 (${empNo}): ${(error as Error).message}`);
      }
    } else {
      logger.debug(`Phase3 スキップ: ${empNo} — 資格情報なし`);
    }

    await this.tryRecoverToStaffIndex(page);
  }

  /**
   * 既に staffInfo ページにいる状態で事業所追加 + 有効期間修正 + HAM 資格登録を実行する。
   */
  async addOfficeToStaffFromCurrentPage(
    page: Page,
    staffInfoUrl: string,
    staffEntry?: StaffMasterEntry | null,
    validityStartDate?: string,
  ): Promise<void> {
    await this.phase2_setOffice(page, staffInfoUrl);

    if (validityStartDate) {
      await this.ensureStaffInfoPage(page);
      await this.updateOfficeValidityPeriod(page, validityStartDate);
    }

    if (staffEntry && staffEntry.qualifications.length > 0) {
      try {
        const nav = this.auth.navigator;
        await this.phase3_registerQualificationsInHam(nav, staffEntry);
      } catch (error) {
        logger.warn(`Phase3 HAM 資格登録失敗 (${staffEntry.staffNumber}): ${(error as Error).message}`);
      }
    }

    await this.tryRecoverToStaffIndex(page);
  }

  /**
   * 指定スタッフの情報有効期間のみを修正する。
   *
   * 新規登録成功後、registerSpecificStaff() とは別経路で
   * staffInfoEdit に入り、開始月を 2 月へ補正するために使用する。
   */
  async updateValidityPeriodForStaff(
    page: Page,
    empNo: string,
    validityStartDate: string,
  ): Promise<void> {
    logger.debug(`updateValidityPeriodForStaff: 従業員番号=${empNo}, 開始日=${validityStartDate}`);

    const navResult = await this.navigateToStaffByEmpNo(page, empNo);
    if (!navResult.found) {
      throw new Error(`有効期間修正対象が見つかりません: 従業員番号=${empNo}`);
    }

    await this.ensureStaffInfoPage(page);
    await this.updateOfficeValidityPeriod(page, validityStartDate);
    await this.tryRecoverToStaffIndex(page);
  }

  /**
   * スタッフ基本情報の情報有効期間の開始月を更新する。
   *
   * staffInfo ページの基本情報セクションの「編集」リンク (staffInfoEdit) に遷移し、
   * 開始月テキストボックス (#dateFromMonth / name=mStaffInfo.dateFromMonth) を変更して
   * 「更新する」をクリック。
   *
   * @param validityStartDate "YYYY/MM/DD" 形式 (例: "2026/02/01")
   */
  private async updateOfficeValidityPeriod(page: Page, validityStartDate: string): Promise<void> {
    const parts = validityStartDate.split('/');
    const targetMonth = parts[1]; // "02"

    logger.debug(`updateOfficeValidityPeriod: 開始月を ${targetMonth} に変更`);

    // Step 1: ページをリロードして最新 DOM を確保 → staffInfoEdit リンクを取得
    await page.reload({ waitUntil: 'load', timeout: 15000 }).catch(() => {});
    await this.sleep(1500);

    const editHref = await page.evaluate(() => {
      // staffInfoEdit?...&flg=update（基本情報・編集）を探す
      const links = Array.from(document.querySelectorAll('a[href*="staffInfoEdit"][href*="flg=update"]'));
      if (links.length > 0) return links[0].getAttribute('href');
      return null;
    });

    if (!editHref) {
      logger.warn('updateOfficeValidityPeriod: staffInfoEdit リンクが見つかりません — スキップ');
      return;
    }

    // Step 2: スタッフ基本情報・編集ページへ遷移
    const editUrl = new URL(editHref, page.url()).href;
    logger.debug(`updateOfficeValidityPeriod: ${editUrl}`);
    await page.goto(editUrl, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
    await this.sleep(1500);

    // Step 3: 現在の開始月を確認（#dateFromMonth = mStaffInfo.dateFromMonth）
    const currentMonth = await page.evaluate(() => {
      const el = document.getElementById('dateFromMonth') as HTMLInputElement;
      return el?.value || '';
    });

    const targetMonthNum = parseInt(targetMonth, 10);
    const currentMonthNum = parseInt(currentMonth, 10);
    logger.debug(`updateOfficeValidityPeriod: 現在=${currentMonthNum}月, 目標=${targetMonthNum}月`);

    if (!currentMonth || currentMonthNum <= targetMonthNum) {
      logger.info(`updateOfficeValidityPeriod: 開始月は既に ${currentMonth || '?'} 月 — 変更不要`);
      // staffInfo ページに戻る
      const backLink = await page.$('a[href*="staffInfo?userId="]');
      if (backLink) await backLink.click();
      else await page.goBack();
      await this.sleep(1000);
      return;
    }

    // Step 4: 開始月を変更
    await page.evaluate((month) => {
      const el = document.getElementById('dateFromMonth') as HTMLInputElement;
      if (el) el.value = month;
    }, String(targetMonthNum));
    logger.debug(`updateOfficeValidityPeriod: dateFromMonth = ${targetMonthNum}`);

    // Step 5: 「更新する」クリック（datacheck('staffInfo')）
    page.once('dialog', async (dialog) => {
      logger.debug(`updateOfficeValidityPeriod ダイアログ: ${dialog.message()}`);
      await dialog.accept();
    });

    const updateLink = await page.$('a[onclick*="datacheck"]');
    if (updateLink) {
      await updateLink.click();
    } else {
      await page.evaluate(() => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const win = window as any;
        if (typeof win.datacheck === 'function') win.datacheck('staffInfo');
        /* eslint-enable @typescript-eslint/no-explicit-any */
      });
    }

    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await this.sleep(1500);
    logger.info(`updateOfficeValidityPeriod: 情報有効期間の開始月を ${targetMonthNum} 月に更新`);
  }

  /**
   * エラー後のリカバリー: スタッフ一覧に戻る
   */
  private async tryRecoverToStaffIndex(page: Page): Promise<void> {
    try {
      await page.goto(`${BASE_URL}${TRITRUS_STAFF_INDEX}`, { waitUntil: 'networkidle', timeout: 15000 });
      await this.sleep(1000);
    } catch {
      logger.warn('スタッフ一覧への復帰に失敗');
    }
  }

  /**
   * 氏名を姓と名に分割
   */
  private splitName(fullName: string): { lastName: string; firstName: string } {
    const trimmed = fullName.trim();
    const spaceIdx = trimmed.indexOf(' ');
    const fullWidthSpaceIdx = trimmed.indexOf('\u3000');

    let splitIdx = -1;
    if (spaceIdx >= 0 && fullWidthSpaceIdx >= 0) {
      splitIdx = Math.min(spaceIdx, fullWidthSpaceIdx);
    } else if (spaceIdx >= 0) {
      splitIdx = spaceIdx;
    } else if (fullWidthSpaceIdx >= 0) {
      splitIdx = fullWidthSpaceIdx;
    }

    if (splitIdx >= 0) {
      return {
        lastName: trimmed.substring(0, splitIdx).trim(),
        firstName: trimmed.substring(splitIdx + 1).trim(),
      };
    }

    return { lastName: trimmed, firstName: '' };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
