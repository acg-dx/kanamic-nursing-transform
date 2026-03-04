/**
 * 同一建物管理 カナミック登録ワークフロー
 *
 * 連携スプレッドシートの月度タブからレコードを読み込み、
 * TRITRUS 同一建物管理画面に自動登録する。
 *
 * フロー:
 *   1. 連携シートから月度タブのレコード読み込み + フィルタ（新規 & 未登録）
 *   2. TRITRUS にログイン（既存 auth.login() の JOSSO 認証）
 *   3. 施設一覧ページへ遷移 → premisesId マッピング取得
 *   4. 施設ループ:
 *     4a. 施設詳細ページへ遷移（premisesId）
 *     4b. 利用者追加弾窗を開く
 *     4c. 利用者を名前+事業所名でマッチ → チェック
 *     4d. 入居日・退去日を設定
 *     4e. 追加確定（addCareuserToMain）
 *     4f. ステータス書き戻し（登録済み or エラー）
 *     4g. 施設一覧に戻る
 *   5. 結果レポート
 *
 * 注意:
 *   - TRITRUS ポータルページ（Tab 0）で直接操作（HAM iframe ではない）
 *   - auth.login() で JOSSO 認証は完了するが、HAM タブは不要
 *   - 弾窗は施設詳細ページ内のモーダル（window.open ではない想定）
 *   - 連続3件エラーで熔断停止（転記ワークフローと同様）
 */
import { logger } from '../../core/logger';
import { withRetry } from '../../core/retry-manager';
import { PremisesNavigator } from '../../core/premises-navigator';
import { SpreadsheetService } from '../../services/spreadsheet.service';
import { KanamickAuthService } from '../../services/kanamick-auth.service';
import type { WorkflowResult, WorkflowError } from '../../types/workflow.types';
import type { BuildingManagementRecord } from '../../types/spreadsheet.types';

const WORKFLOW_NAME = 'building';
const MAX_CONSECUTIVE_ERRORS = 3;

export interface BuildingWorkflowConfig {
  /** 連携スプレッドシートID */
  buildingMgmtSheetId: string;
  /** 月度タブ名（例: "2026/02"） */
  tab: string;
  /** ドライランモード */
  dryRun: boolean;
  /** 処理件数上限（テスト用） */
  limit?: number;
  /** 施設名フィルタ（テスト用、部分一致） */
  facility?: string;
  /** 事業所名フィルタ（部分一致） */
  nursingOffice?: string;
}

export class BuildingManagementWorkflow {
  private sheets: SpreadsheetService;
  private auth: KanamickAuthService;
  private config: BuildingWorkflowConfig;

  constructor(
    sheets: SpreadsheetService,
    auth: KanamickAuthService,
    config: BuildingWorkflowConfig,
  ) {
    this.sheets = sheets;
    this.auth = auth;
    this.config = config;
  }

  async run(): Promise<WorkflowResult> {
    const startTime = Date.now();
    const { buildingMgmtSheetId: sheetId, tab, dryRun } = this.config;

    logger.info(`同一建物管理 カナミック登録開始 (タブ: ${tab}${dryRun ? ', DRY RUN' : ''})`);

    // 1. 連携シートからレコード読み込み
    const records = await this.sheets.getBuildingManagementRecords(sheetId, tab);
    let targets = records.filter(r => r.isNew && r.status !== '登録済み');
    if (this.config.facility) {
      const facilityFilter = this.config.facility;
      targets = targets.filter(r => r.facilityName.includes(facilityFilter));
      logger.info(`同一建物管理: 施設フィルタ "${facilityFilter}" → ${targets.length}件`);
    }
    if (this.config.nursingOffice) {
      const nursingOfficeFilter = this.config.nursingOffice;
      targets = targets.filter(r => r.nursingOfficeName.includes(nursingOfficeFilter));
      logger.info(`同一建物管理: 事業所フィルタ "${nursingOfficeFilter}" → ${targets.length}件`);
    }
    if (this.config.limit && this.config.limit > 0) {
      targets = targets.slice(0, this.config.limit);
      logger.info(`同一建物管理: 対象 ${targets.length}件に制限 (--limit=${this.config.limit})`);
    }
    logger.info(`同一建物管理: 対象 ${targets.length}/${records.length}件 (新規 & 未登録)`);

    if (targets.length === 0) {
      logger.info('登録対象なし — 完了');
      return this.buildResult(records.length, 0, [], Date.now() - startTime);
    }

    // 施設名でグループ化
    const byFacility = this.groupByFacility(targets);
    const facilityNames = [...byFacility.keys()];
    logger.info(`対象施設: ${facilityNames.length}件 — ${facilityNames.join(', ')}`);

    if (dryRun) {
      return this.executeDryRun(records.length, targets, byFacility, startTime);
    }

    // 2. TRITRUS ポータルにログイン（HAM 不要 — 同一建物管理は TRITRUS 上で完結）
    const tritrusPage = await this.auth.loginTritrusOnly();
    const premisesNav = new PremisesNavigator(tritrusPage);

    // 3. 施設一覧ページ → premisesId マッピング取得
    await premisesNav.navigateToPremisesList();
    const allMappings = await premisesNav.scrapePremisesMapping();

    const { matched: facilityMap, unmatched } = premisesNav.buildFacilityToPremisesMap(
      allMappings,
      facilityNames,
    );

    if (unmatched.length > 0) {
      logger.warn(`施設マッピング不能: ${unmatched.join(', ')}`);
    }

    for (const [name, id] of facilityMap) {
      logger.debug(`  ${name} → premisesId=${id}`);
    }

    // 4. 施設ループ
    const errors: WorkflowError[] = [];
    let processedRecords = 0;
    let consecutiveErrors = 0;

    for (const [facilityName, facilityRecords] of byFacility) {
      // 熔断チェック
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        logger.error(`連続${MAX_CONSECUTIVE_ERRORS}件エラー — システム障害と判断し処理を中止します`);
        // 残りのレコードをエラーマーク
        for (const record of facilityRecords) {
          errors.push({
            recordId: record.aozoraId,
            message: '連続エラーによる処理中止',
            category: 'system',
            recoverable: true,
            timestamp: new Date().toISOString(),
          });
        }
        continue;
      }

      const premisesId = facilityMap.get(facilityName);
      if (premisesId === undefined) {
        // マッピング不能 → エラー
        for (const record of facilityRecords) {
          await this.updateStatus(sheetId, tab, record.rowIndex, 'エラー', `施設マッピング不能: ${facilityName}`);
          errors.push({
            recordId: record.aozoraId,
            message: `TRITRUS 施設マッピング不能: ${facilityName}`,
            category: 'master',
            recoverable: false,
            timestamp: new Date().toISOString(),
          });
        }
        continue;
      }

      try {
        const count = await withRetry(
          () => this.processFacility(premisesNav, premisesId, facilityName, facilityRecords, sheetId, tab),
          `建物管理[${facilityName}]`,
          {
            maxAttempts: 2,
            baseDelay: 3000,
            maxDelay: 10000,
            backoffMultiplier: 2,
            onRetry: async () => {
              // リトライ前に施設一覧に戻る
              logger.info('リトライ: 施設一覧へ戻ります');
              await premisesNav.navigateToPremisesList();
            },
          },
        );
        processedRecords += count;
        consecutiveErrors = 0;
      } catch (error) {
        const err = error as Error;
        logger.error(`建物管理エラー [${facilityName}]: ${err.message}`);
        consecutiveErrors++;

        for (const record of facilityRecords) {
          await this.updateStatus(sheetId, tab, record.rowIndex, 'エラー', err.message);
          errors.push({
            recordId: record.aozoraId,
            message: err.message,
            category: 'system',
            recoverable: true,
            timestamp: new Date().toISOString(),
          });
        }

        // エラー後に施設一覧に戻る
        try { await premisesNav.navigateToPremisesList(); } catch { /* ignore */ }
      }
    }

    return this.buildResult(records.length, processedRecords, errors, Date.now() - startTime);
  }

  // ─── 施設内処理 ────────────────────────────────────────

  /**
   * 1施設分の利用者登録処理
   *
   * @returns 登録成功した件数
   */
  private async processFacility(
    premisesNav: PremisesNavigator,
    premisesId: number,
    facilityName: string,
    records: BuildingManagementRecord[],
    sheetId: string,
    tab: string,
  ): Promise<number> {
    logger.info(`施設処理: ${facilityName} (premisesId=${premisesId}, ${records.length}件)`);

    // 施設詳細ページへ遷移
    await premisesNav.openFacilityDetail(premisesId);

    // 登録済みの利用者名を取得（重複防止）
    const registeredUsers = await premisesNav.getRegisteredUsers();
    logger.debug(`登録済み利用者: ${registeredUsers.length}件`);

    // 弾窗を開く
    await premisesNav.openAddUserDialog();

    // 弾窗内の全利用者を取得（デバッグ用）
    const dialogUsers = await premisesNav.getDialogUsers();
    logger.debug(`弾窗内利用者: ${dialogUsers.length}件`);

    let selectedCount = 0;
    const alreadyRegisteredCount = { count: 0 };
    const failedRecords: { record: BuildingManagementRecord; reason: string }[] = [];
    // 弾窗でチェックした利用者のレコード（入居日・退去日設定用）
    const checkedRecords: BuildingManagementRecord[] = [];

    for (const record of records) {
      // 既に登録済みかチェック（名前のスペース除去で比較）
      const normalizedRecordName = record.userName.replace(/[\s\u3000]/g, '');
      const alreadyRegistered = registeredUsers.some(
        name => name === normalizedRecordName,
      );
      if (alreadyRegistered) {
        logger.info(`スキップ（登録済み）: ${record.userName} @ ${facilityName}`);
        await this.updateStatus(sheetId, tab, record.rowIndex, '登録済み（既存）');
        alreadyRegisteredCount.count++;
        selectedCount++;
        continue;
      }

      // 弾窗内でマッチしてチェック
      const matchResult = await premisesNav.selectUserInDialog(
        record.userName,
        record.nursingOfficeName,
      );

      if (!matchResult) {
        const reason = `弾窗内に利用者が見つかりません: ${record.userName} (事業所: ${record.nursingOfficeName})`;
        logger.warn(reason);
        failedRecords.push({ record, reason });
        continue;
      }

      if (matchResult.multipleMatches) {
        logger.warn(`複数マッチ: ${record.userName} @ ${facilityName} → 最初の未チェック行を選択`);
      }

      checkedRecords.push(record);
      selectedCount++;
      logger.debug(`チェック: ${record.userName} (dialogIndex=${matchResult.matchedIndex})`);
    }

    // ── Phase 2: 弾窗確定 → 施設詳細で入居日設定 → 保存 ──

    const newlySelected = selectedCount - alreadyRegisteredCount.count;
    if (newlySelected > 0) {
      // 弾窗の「追加する」ボタン → 弾窗閉じ、利用者テーブルに追加
      // ※ 既存保存済み利用者はテキスト表示のみ（#applydateStart_N input なし）
      //   新規追加された利用者だけが #applydateStart_N input を持つ
      //   → confirmAddUsers 前の input 数が新規分のベースインデックス
      const inputCountBefore = await premisesNav.getDetailUserCount();
      await premisesNav.confirmAddUsers();
      logger.info(`施設 ${facilityName}: ${newlySelected}件の利用者を弾窗から追加`);

      // 施設詳細ページの利用者テーブルで入居日・退去日を設定
      // 新規 input は inputCountBefore から始まる（通常は 0）
      for (let i = 0; i < checkedRecords.length; i++) {
        const record = checkedRecords[i];
        const detailRowIndex = inputCountBefore + i;

        if (record.moveInDate) {
          await premisesNav.setMoveInDate(detailRowIndex, record.moveInDate);
        }
        if (record.moveOutDate) {
          await premisesNav.setMoveOutDate(detailRowIndex, record.moveOutDate);
        }
      }

      // 「保存して戻る」→ 保存＋施設一覧に遷移
      await premisesNav.saveAndReturn();
      logger.info(`施設 ${facilityName}: 保存完了`);
    } else if (failedRecords.length === 0) {
      logger.info(`施設 ${facilityName}: 追加対象なし（全て登録済み）`);
      await premisesNav.closeDialog();
      await premisesNav.returnWithoutSave();
    } else {
      await premisesNav.closeDialog();
      await premisesNav.returnWithoutSave();
    }

    // ステータス書き戻し
    for (const record of records) {
      const failed = failedRecords.find(f => f.record === record);
      if (failed) {
        await this.updateStatus(sheetId, tab, record.rowIndex, 'エラー', failed.reason);
      } else {
        const normalizedName = record.userName.replace(/[\s\u3000]/g, '');
        const wasAlreadyRegistered = registeredUsers.some(name => name === normalizedName);
        if (!wasAlreadyRegistered) {
          // 新規登録成功
          await this.updateStatus(sheetId, tab, record.rowIndex, '登録済み');
        }
      }
    }

    // 失敗があった場合、エラーをスロー（ただし部分成功は許容）
    if (failedRecords.length > 0 && selectedCount === 0) {
      throw new Error(`施設 ${facilityName}: 全${failedRecords.length}件マッチ失敗`);
    }

    return selectedCount;
  }

  // ─── ドライラン ────────────────────────────────────────

  private executeDryRun(
    totalRecords: number,
    targets: BuildingManagementRecord[],
    byFacility: Map<string, BuildingManagementRecord[]>,
    startTime: number,
  ): WorkflowResult {
    logger.info('[DRY RUN] 登録処理をスキップします');

    for (const [facilityName, recs] of byFacility) {
      logger.info(`  施設: ${facilityName} (${recs.length}件)`);
      for (const r of recs.slice(0, 5)) {
        logger.info(`    ${r.aozoraId} | ${r.userName} | ${r.nursingOfficeName} | ${r.moveInDate}`);
      }
      if (recs.length > 5) {
        logger.info(`    ... 他 ${recs.length - 5}件`);
      }
    }

    return this.buildResult(totalRecords, targets.length, [], Date.now() - startTime);
  }

  // ─── ヘルパー ────────────────────────────────────────

  private groupByFacility(records: BuildingManagementRecord[]): Map<string, BuildingManagementRecord[]> {
    const map = new Map<string, BuildingManagementRecord[]>();
    for (const record of records) {
      const existing = map.get(record.facilityName) || [];
      existing.push(record);
      map.set(record.facilityName, existing);
    }
    return map;
  }

  private async updateStatus(
    sheetId: string,
    tab: string,
    rowIndex: number,
    status: string,
    errorDetail?: string,
  ): Promise<void> {
    try {
      await this.sheets.updateBuildingManagementStatus(sheetId, rowIndex, status, tab, errorDetail);
    } catch (e) {
      logger.error(`ステータス更新失敗 (行${rowIndex}): ${(e as Error).message}`);
    }
  }

  private buildResult(
    totalRecords: number,
    processedRecords: number,
    errors: WorkflowError[],
    duration: number,
  ): WorkflowResult {
    return {
      workflowName: WORKFLOW_NAME,
      success: errors.length === 0,
      totalRecords,
      processedRecords,
      errorRecords: errors.length,
      errors,
      duration,
    };
  }
}
