/**
 * Step 2: HAM スタッフ無重複記録削除スクリプト
 *
 * full-reconciliation C類で検出された21件のスタッフ無重複記録を削除する。
 * 各グループにおいて、正規スタッフが割り当てられたレコードは保持し、
 * スタッフ無のレコードのみを削除する。
 *
 * 10グループ・21件:
 *  1. 山岸雄二 02-01 13:00 → 2件スタッフ無 (杉田流星を保持)
 *  2. 有田勉 02-01 18:00 → 1件スタッフ無 (冨迫広美を保持)
 *  3. 溝口己喜男 02-02 14:00 → 2件スタッフ無 (冨迫広美を保持)
 *  4. 小濵士郎 02-03 16:00 → 1件スタッフ無 (冨迫広美を保持)
 *  5. 有田勉 02-03 18:00 → 1件スタッフ無 (冨迫広美を保持)
 *  6. 川涯利雄 02-04 16:30 → 3件スタッフ無 (永松アケミを保持)
 *  7. 溝口己喜男 02-04 16:30 → 3件スタッフ無 (冨迫広美を保持)
 *  8. 窪田正浩 02-04 17:30 → 3件スタッフ無 (永松アケミを保持)
 *  9. 小濵士郎 02-05 16:00 → 4件スタッフ無 (永松アケミを保持)
 * 10. 川涯利雄 02-05 17:00 → 1件スタッフ無 (永松アケミを保持)
 *
 * スタッフ無の判定方法:
 *   k2_2 の各行の td[bgcolor="#DDEEFF"] がスタッフ名セル。
 *   textContent が空 → スタッフ無。
 *   (findNewAssignId@transcription.workflow.ts:1530 と同一ロジック)
 *
 * 実行:
 *   npx tsx src/scripts/delete-staff-null-records.ts --dry-run
 *   npx tsx src/scripts/delete-staff-null-records.ts
 */

import { chromium } from 'playwright';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { logger } from '../core/logger';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

interface DeleteGroup {
  patientName: string;
  visitDate: string;     // YYYY/MM/DD
  startTime: string;     // HH:MM
  keepStaffName: string;  // この名前のスタッフは保持
  expectedDeleteCount: number;
}

const DELETE_GROUPS: DeleteGroup[] = [
  { patientName: '山岸雄二', visitDate: '2026/02/01', startTime: '13:00', keepStaffName: '杉田', expectedDeleteCount: 2 },
  { patientName: '有田勉', visitDate: '2026/02/01', startTime: '18:00', keepStaffName: '冨迫', expectedDeleteCount: 1 },
  { patientName: '有田勉', visitDate: '2026/02/03', startTime: '18:00', keepStaffName: '冨迫', expectedDeleteCount: 1 },
  { patientName: '溝口己喜男', visitDate: '2026/02/02', startTime: '14:00', keepStaffName: '冨迫', expectedDeleteCount: 2 },
  { patientName: '溝口己喜男', visitDate: '2026/02/04', startTime: '16:30', keepStaffName: '冨迫', expectedDeleteCount: 3 },
  { patientName: '小濵士郎', visitDate: '2026/02/03', startTime: '16:00', keepStaffName: '冨迫', expectedDeleteCount: 1 },
  { patientName: '小濵士郎', visitDate: '2026/02/05', startTime: '16:00', keepStaffName: '永松', expectedDeleteCount: 4 },
  { patientName: '川涯利雄', visitDate: '2026/02/04', startTime: '16:30', keepStaffName: '永松', expectedDeleteCount: 3 },
  { patientName: '川涯利雄', visitDate: '2026/02/05', startTime: '17:00', keepStaffName: '永松', expectedDeleteCount: 1 },
  { patientName: '窪田正浩', visitDate: '2026/02/04', startTime: '17:30', keepStaffName: '永松', expectedDeleteCount: 3 },
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * k2_2 フレームから、指定日+時刻に一致するスタッフ無行の assignid を1件取得して返す。
 * 削除ボタン (confirmDelete) を持つ行のみ対象。
 *
 * スタッフ有無の判定:
 *   td[bgcolor="#DDEEFF"] のテキストが空 → スタッフ無
 *   (transcription.workflow.ts:1530 の findNewAssignId と同一ロジック)
 */
async function findOneStaffNullRow(
  nav: Awaited<ReturnType<KanamickAuthService['ensureLoggedIn']>>,
  dayDisplay: string,
  startTime: string,
): Promise<{ assignid: string; record2flag: string; staffText: string; rowText: string } | null> {
  const frame = await nav.getMainFrame('k2_2');
  return frame.evaluate(({ dd, st }: { dd: string; st: string }) => {
    const rows = Array.from(document.querySelectorAll('tr'));
    for (const row of rows) {
      const rowText = row.textContent || '';
      if (!rowText.includes(dd)) continue;
      if (!rowText.includes(st)) continue;

      // 削除ボタンがあるか
      const delBtn = row.querySelector('input[name="act_delete"][value="削除"]') as HTMLInputElement | null;
      if (!delBtn) continue;

      const onclick = delBtn.getAttribute('onclick') || '';
      const m = onclick.match(/confirmDelete\(\s*'(\d+)'\s*,\s*'(\d+)'\s*\)/);
      if (!m) continue;

      // スタッフ有無判定: bgcolor="#DDEEFF" セルのテキスト
      const staffCell = row.querySelector('td[bgcolor="#DDEEFF"]');
      const staffText = (staffCell?.textContent || '').trim();

      if (staffText.length > 0) {
        // スタッフ有 → スキップ
        continue;
      }

      // スタッフ無 → 削除対象
      return {
        assignid: m[1],
        record2flag: m[2],
        staffText: '(スタッフ無)',
        rowText: rowText.replace(/\s+/g, ' ').trim().substring(0, 150),
      };
    }
    return null;
  }, { dd: dayDisplay, st: startTime });
}

/**
 * k2_2 フレームから、指定日+時刻に一致する全行の概要を取得（dry-run 用）。
 */
async function listAllRowsForSlot(
  nav: Awaited<ReturnType<KanamickAuthService['ensureLoggedIn']>>,
  dayDisplay: string,
  startTime: string,
): Promise<Array<{ assignid: string; staffText: string; hasStaff: boolean }>> {
  const frame = await nav.getMainFrame('k2_2');
  return frame.evaluate(({ dd, st }: { dd: string; st: string }) => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const results: { assignid: string; staffText: string; hasStaff: boolean }[] = [];

    for (const row of rows) {
      const rowText = row.textContent || '';
      if (!rowText.includes(dd)) continue;
      if (!rowText.includes(st)) continue;

      // 削除ボタンまたは配置ボタンからassignidを取得
      const delBtn = row.querySelector('input[name="act_delete"][value="削除"]') as HTMLInputElement | null;
      const modBtn = row.querySelector('input[name="act_modify"][value="配置"]') as HTMLInputElement | null;

      let assignid = '';
      if (delBtn) {
        const onclick = delBtn.getAttribute('onclick') || '';
        const m = onclick.match(/confirmDelete\(\s*'(\d+)'/);
        if (m) assignid = m[1];
      } else if (modBtn) {
        const onclick = modBtn.getAttribute('onclick') || '';
        const m = onclick.match(/'(\d+)'/);
        if (m) assignid = m[1];
      }
      if (!assignid) continue;

      const staffCell = row.querySelector('td[bgcolor="#DDEEFF"]');
      const staffText = (staffCell?.textContent || '').trim();

      results.push({
        assignid,
        staffText: staffText || '(スタッフ無)',
        hasStaff: staffText.length > 0,
      });
    }
    return results;
  }, { dd: dayDisplay, st: startTime });
}

/**
 * 1件の削除を実行する。
 * confirmDelete ボタンクリック → act_update で保存。
 * (deletion.workflow.ts:283-308 と同一パターン)
 */
async function executeDelete(
  nav: Awaited<ReturnType<KanamickAuthService['ensureLoggedIn']>>,
  assignid: string,
): Promise<void> {
  const frame = await nav.getMainFrame('k2_2');

  // confirmDelete を Playwright native click で実行
  const delBtn = await frame.$(`input[name="act_delete"][onclick*="confirmDelete('${assignid}'"]`);
  if (delBtn) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await frame.evaluate(() => { (window as any).submited = 0; });
    await delBtn.click();
    await sleep(2000);
  } else {
    // フォールバック: evaluate で confirmDelete 直接呼び出し
    await frame.evaluate((aid: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = window as any;
      win.submited = 0;
      if (typeof win.confirmDelete === 'function') {
        win.confirmDelete(aid, '0');
      }
    }, assignid);
    await sleep(2000);
  }

  // 上書き保存（削除反映に必須）
  await nav.submitForm({
    action: 'act_update',
    setLockCheck: true,
    waitForPageId: 'k2_2',
  });
  await sleep(2000);
}

async function main() {
  const totalExpected = DELETE_GROUPS.reduce((sum, g) => sum + g.expectedDeleteCount, 0);
  console.log(`=== Step 2: HAM スタッフ無重複記録削除 ===`);
  console.log(`モード: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);
  console.log(`対象グループ: ${DELETE_GROUPS.length}, 削除予定: ${totalExpected}件\n`);

  DELETE_GROUPS.forEach((g, i) => {
    console.log(`  ${i + 1}. ${g.patientName} ${g.visitDate} ${g.startTime} → ${g.expectedDeleteCount}件削除 (${g.keepStaffName}を保持)`);
  });
  console.log('');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  // confirm ダイアログを自動承認（confirmDelete 内の confirm() 呼び出し用）
  context.on('page', page => {
    page.on('dialog', dialog => dialog.accept());
  });
  // 既存ページにも適用
  for (const page of context.pages()) {
    page.on('dialog', dialog => dialog.accept());
  }

  const authService = new KanamickAuthService({
    url: process.env.KANAMICK_URL!,
    username: process.env.KANAMICK_USERNAME!,
    password: process.env.KANAMICK_PASSWORD!,
    stationName: process.env.KANAMICK_STATION_NAME || '訪問看護ステーションあおぞら姶良',
    hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
  });
  authService.setContext(context);

  const evidenceLines: string[] = [
    `=== Step 2: HAM スタッフ無重複記録削除 ===`,
    `Date: ${new Date().toISOString()}`,
    `Mode: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`,
    `Total groups: ${DELETE_GROUPS.length}, Expected deletions: ${totalExpected}`,
    '',
  ];

  let totalDeleted = 0;
  let totalBlocked = 0;
  let totalSkipped = 0;

  try {
    const nav = await authService.ensureLoggedIn();
    logger.info('HAM ログイン完了');
    evidenceLines.push('HAM ログイン完了');

    // 新しいページ (HAM タブ) にもダイアログハンドラを設定
    for (const page of context.pages()) {
      page.on('dialog', dialog => dialog.accept());
    }

    // 患者ごとにグループ化（同一患者は1回のナビゲーションで処理）
    const patientGroups: Record<string, DeleteGroup[]> = {};
    const patientOrder: string[] = [];
    for (const g of DELETE_GROUPS) {
      if (!patientGroups[g.patientName]) {
        patientGroups[g.patientName] = [];
        patientOrder.push(g.patientName);
      }
      patientGroups[g.patientName].push(g);
    }

    for (const patientName of patientOrder) {
      const groups = patientGroups[patientName];
      console.log(`\n========== 患者: ${patientName} (${groups.length}グループ) ==========`);
      evidenceLines.push(`\n========== 患者: ${patientName} (${groups.length}グループ) ==========`);

      try {
        // メインメニュー → 業務ガイド → 利用者検索
        await authService.navigateToMainMenu();
        await authService.navigateToBusinessGuide();
        await authService.navigateToUserSearch();
        await sleep(2000);

        // 年月設定 + 患者名検索
        await nav.setSelectValue('searchdate', '20260201');
        const k2_1Frame = await nav.getMainFrame('k2_1');
        await k2_1Frame.evaluate((name: string) => {
          const form = document.forms[0];
          const nameInput = form.querySelector('input[name="name"]') as HTMLInputElement;
          if (nameInput) nameInput.value = name;
        }, patientName);

        await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_1' });
        await sleep(2000);

        // 患者IDを取得 (deletion.workflow.ts:314 の findPatientId と同等)
        const k2_1FrameAfter = await nav.getMainFrame('k2_1');
        const patientId = await k2_1FrameAfter.evaluate((name: string) => {
          const rows = Array.from(document.querySelectorAll('tr'));
          for (const row of rows) {
            if (!(row.textContent || '').includes(name)) continue;
            const el = row.querySelector('[onclick*="submitTargetFormEx"]') ||
                       row.querySelector('[onclick*="careuserid"]');
            if (!el) continue;
            const onclick = el.getAttribute('onclick') || '';
            const m = onclick.match(/['"](\d+)['"]\s*\)$/);
            if (m) return m[1];
          }
          return null;
        }, patientName);

        if (!patientId) {
          const msg = `患者が見つかりません: ${patientName}`;
          logger.warn(msg);
          evidenceLines.push(`  SKIP: ${msg}`);
          totalSkipped += groups.reduce((s, g) => s + g.expectedDeleteCount, 0);
          continue;
        }

        console.log(`  患者ID: ${patientId}`);

        // k2_2 へ遷移
        await k2_1FrameAfter.evaluate((pid: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const win = window as any;
          const form = document.forms[0];
          if (typeof win.submitTargetFormEx === 'function') {
            win.submitTargetFormEx(form, 'k2_2', form.careuserid, pid);
          } else {
            win.submited = 0;
            form.careuserid.value = pid;
            form.doAction.value = 'k2_2';
            form.target = 'mainFrame';
            form.submit();
          }
        }, patientId);
        await sleep(3000);

        // 各時間グループを処理
        for (const group of groups) {
          const dayNum = parseInt(group.visitDate.substring(8, 10));
          const dayDisplay = `${dayNum}日`;

          console.log(`\n  --- ${dayDisplay} ${group.startTime} (期待: ${group.expectedDeleteCount}件削除) ---`);
          evidenceLines.push(`\n  --- ${dayDisplay} ${group.startTime} (期待: ${group.expectedDeleteCount}件削除) ---`);

          if (DRY_RUN) {
            // Dry-run: 全行をリストアップ
            const allRows = await listAllRowsForSlot(nav, dayDisplay, group.startTime);
            const staffNull = allRows.filter(r => !r.hasStaff);
            const staffAssigned = allRows.filter(r => r.hasStaff);

            console.log(`    全行: ${allRows.length}件 (スタッフ有: ${staffAssigned.length}, スタッフ無: ${staffNull.length})`);
            evidenceLines.push(`    全行: ${allRows.length}件 (スタッフ有: ${staffAssigned.length}, スタッフ無: ${staffNull.length})`);

            for (const r of staffAssigned) {
              console.log(`      ✅ KEEP: assignid=${r.assignid} staff="${r.staffText}"`);
              evidenceLines.push(`      ✅ KEEP: assignid=${r.assignid} staff="${r.staffText}"`);
            }
            for (const r of staffNull) {
              console.log(`      🗑️  DELETE: assignid=${r.assignid} staff="${r.staffText}"`);
              evidenceLines.push(`      🗑️  DELETE: assignid=${r.assignid} staff="${r.staffText}"`);
            }

            if (staffNull.length !== group.expectedDeleteCount) {
              console.log(`    ⚠️  期待${group.expectedDeleteCount}件 vs 実際${staffNull.length}件`);
              evidenceLines.push(`    ⚠️  期待${group.expectedDeleteCount}件 vs 実際${staffNull.length}件`);
            }
            continue;
          }

          // 実行モード: 1件ずつ削除（削除後ページが更新されるので毎回再検索）
          let deletedInGroup = 0;
          for (let attempt = 0; attempt < group.expectedDeleteCount + 3; attempt++) {
            // 安全弁: 期待数+3回以上は試行しない
            const row = await findOneStaffNullRow(nav, dayDisplay, group.startTime);

            if (!row) {
              if (deletedInGroup < group.expectedDeleteCount) {
                console.log(`    ⚠️ スタッフ無が見つからない (${deletedInGroup}/${group.expectedDeleteCount}件削除済み)`);
                evidenceLines.push(`    ⚠️ スタッフ無が見つからない (${deletedInGroup}/${group.expectedDeleteCount}件削除済み)`);
              }
              break;
            }

            if (row.record2flag === '1') {
              const msg = `BLOCKED: record2flag=1 (assignid=${row.assignid})`;
              console.log(`    ❌ ${msg}`);
              evidenceLines.push(`    ❌ ${msg}`);
              totalBlocked++;
              break; // この行は削除できないので次グループへ
            }

            console.log(`    削除 [${deletedInGroup + 1}]: assignid=${row.assignid}`);
            evidenceLines.push(`    削除: assignid=${row.assignid} — ${row.rowText.substring(0, 80)}`);

            await executeDelete(nav, row.assignid);

            console.log(`    ✅ 削除完了: assignid=${row.assignid}`);
            evidenceLines.push(`    ✅ 削除完了`);
            totalDeleted++;
            deletedInGroup++;
          }

          console.log(`    グループ結果: ${deletedInGroup}/${group.expectedDeleteCount}件削除`);
          evidenceLines.push(`    グループ結果: ${deletedInGroup}/${group.expectedDeleteCount}件削除`);
        }

      } catch (err) {
        const msg = `患者処理エラー: ${patientName} — ${(err as Error).message}`;
        console.error(msg);
        evidenceLines.push(`  ERROR: ${msg}`);
      }
    }

  } finally {
    await browser.close();
  }

  // サマリー
  const summary = [
    '',
    '=== サマリー ===',
    `削除成功: ${totalDeleted}/${totalExpected}件`,
    `ブロック(record2flag=1): ${totalBlocked}件`,
    `スキップ: ${totalSkipped}件`,
  ];
  summary.forEach(line => console.log(line));
  evidenceLines.push(...summary);

  fs.mkdirSync('.sisyphus/evidence', { recursive: true });
  fs.writeFileSync('.sisyphus/evidence/step2-ham-deletions.txt', evidenceLines.join('\n'));
  console.log('\n証拠ファイル: .sisyphus/evidence/step2-ham-deletions.txt');
  console.log('\n=== 完了 ===');
}

main().catch(err => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
