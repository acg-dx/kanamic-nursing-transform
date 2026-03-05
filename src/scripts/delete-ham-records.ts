/**
 * B1: HAM 不要記録削除スクリプト
 *
 * シートに存在しないが HAM に存在する 4 件の不要記録を削除する。
 *
 * 削除対象:
 * 1. 窪田正浩 2026/02/06 17:30-17:59 川口千尋
 * 2. 窪田正浩 2026/02/08 16:20-16:49 川口千尋
 * 3. 生野由美子 2026/02/21 12:00-12:59
 * 4. 有田勉 2026/02/08 16:00-16:29 (重複2件中1件のみ削除)
 *
 * 使用方法:
 *   npx tsx src/scripts/delete-ham-records.ts --dry-run
 *   npx tsx src/scripts/delete-ham-records.ts
 */

import { chromium } from 'playwright';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import { logger } from '../core/logger';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

interface DeleteTarget {
  patientName: string;
  visitDate: string;   // YYYY/MM/DD
  startTime: string;   // HH:MM
  endTime: string;     // HH:MM
  staffName: string;
  note: string;
}

const DELETE_TARGETS: DeleteTarget[] = [
  {
    patientName: '窪田正浩',
    visitDate: '2026/02/06',
    startTime: '17:30',
    endTime: '17:59',
    staffName: '川口千尋',
    note: '手動登録、シート無',
  },
  {
    patientName: '窪田正浩',
    visitDate: '2026/02/08',
    startTime: '16:20',
    endTime: '16:49',
    staffName: '川口千尋',
    note: '手動登録、シート無',
  },
  {
    patientName: '生野由美子',
    visitDate: '2026/02/21',
    startTime: '12:00',
    endTime: '12:59',
    staffName: '',
    note: '手動登録、シート無',
  },
  {
    patientName: '有田勉',
    visitDate: '2026/02/08',
    startTime: '16:00',
    endTime: '16:29',
    staffName: '',
    note: '重複2件中1件のみ削除',
  },
];

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log(`=== B1: HAM 不要記録削除 ===`);
  console.log(`モード: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);
  console.log(`削除対象: ${DELETE_TARGETS.length} 件\n`);

  DELETE_TARGETS.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.patientName} ${t.visitDate} ${t.startTime}-${t.endTime} ${t.staffName ? `(${t.staffName})` : ''} — ${t.note}`);
  });
  console.log('');

  if (DRY_RUN) {
    console.log('[DRY-RUN] 実際の削除は行いません。');
    fs.writeFileSync('.sisyphus/evidence/B1-deletions.txt',
      `=== B1 Dry-Run ===\nDate: ${new Date().toISOString()}\n\nTargets:\n` +
      DELETE_TARGETS.map((t, i) => `${i+1}. ${t.patientName} ${t.visitDate} ${t.startTime}-${t.endTime} — ${t.note}`).join('\n')
    );
    return;
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  const authService = new KanamickAuthService({
    url: process.env.KANAMICK_URL!,
    username: process.env.KANAMICK_USERNAME!,
    password: process.env.KANAMICK_PASSWORD!,
    stationName: process.env.KANAMICK_STATION_NAME || '訪問看護ステーションあおぞら姶良',
    hamOfficeKey: process.env.KANAMICK_HAM_OFFICE_KEY || '6',
  });
  authService.setContext(context);

  const evidenceLines: string[] = [
    `=== B1: HAM 不要記録削除 ===`,
    `Date: ${new Date().toISOString()}`,
    `Mode: EXECUTE`,
    '',
  ];

  try {
    const nav = await authService.ensureLoggedIn();
    logger.info('HAM ログイン完了');

    for (const target of DELETE_TARGETS) {
      console.log(`\n--- 処理中: ${target.patientName} ${target.visitDate} ${target.startTime} ---`);
      evidenceLines.push(`\n--- ${target.patientName} ${target.visitDate} ${target.startTime} ---`);

      try {
        // メインメニュー → 業務ガイド → 利用者検索 (k2_1)
        await authService.navigateToMainMenu();
        await authService.navigateToBusinessGuide();
        await authService.navigateToUserSearch();
        await sleep(2000);

        // 年月設定 (2026年02月) + 患者名で検索
        await nav.setSelectValue('searchdate', '20260201');
        const k2_1Frame = await nav.getMainFrame('k2_1');
        await k2_1Frame.evaluate((name) => {
          const form = document.forms[0];
          const nameInput = form.querySelector('input[name="name"]') as HTMLInputElement;
          if (nameInput) nameInput.value = name;
        }, target.patientName);

        await nav.submitForm({ action: 'act_search', waitForPageId: 'k2_1' });
        await sleep(2000);

        // 患者を特定して k2_2 へ遷移
        const k2_1FrameAfter = await nav.getMainFrame('k2_1');
        const patientId = await k2_1FrameAfter.evaluate((name) => {
          const rows = Array.from(document.querySelectorAll('tr'));
          for (const row of rows) {
            if (!(row.textContent || '').includes(name)) continue;
            const onclick = row.querySelector('[onclick*="submitTargetFormEx"]')?.getAttribute('onclick') || '';
            const m = onclick.match(/'(\d+)'\s*\)$/);
            if (m) return m[1];
          }
          return null;
        }, target.patientName);

        if (!patientId) {
          const msg = `患者が見つかりません: ${target.patientName}`;
          logger.warn(msg);
          evidenceLines.push(`  SKIP: ${msg}`);
          continue;
        }

        // submitTargetFormEx で k2_2 へ遷移
        await k2_1FrameAfter.evaluate((pid) => {
          /* eslint-disable @typescript-eslint/no-explicit-any */
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
          /* eslint-enable @typescript-eslint/no-explicit-any */
        }, patientId);
        await sleep(3000);

        await sleep(3000);

        // k2_2 で対象レコードを削除
        const k2_2Frame = await nav.getMainFrame('k2_2');
        const dayNum = parseInt(target.visitDate.substring(8, 10));
        const dayDisplay = `${dayNum}日`;

        const deleteInfo = await k2_2Frame.evaluate(({ dd, st }) => {
          const rows = Array.from(document.querySelectorAll('tr'));
          const matches: { assignid: string; record2flag: string; rowText: string }[] = [];

          for (const row of rows) {
            const rowText = row.textContent || '';
            if (!rowText.includes(dd)) continue;
            if (!rowText.includes(st)) continue;

            const delBtn = row.querySelector('input[name="act_delete"][value="削除"]') as HTMLInputElement | null;
            if (!delBtn) continue;

            const onclick = delBtn.getAttribute('onclick') || '';
            const m = onclick.match(/confirmDelete\(\s*'(\d+)'\s*,\s*'(\d+)'\s*\)/);
            if (!m) continue;

            matches.push({
              assignid: m[1],
              record2flag: m[2],
              rowText: rowText.replace(/\s+/g, ' ').trim().substring(0, 120),
            });
          }
          return matches;
        }, { dd: dayDisplay, st: target.startTime });

        if (deleteInfo.length === 0) {
          const msg = `削除対象なし: ${target.patientName} ${dayDisplay} ${target.startTime}`;
          logger.warn(msg);
          evidenceLines.push(`  SKIP: ${msg}`);
          continue;
        }

        // 有田勉の場合は重複2件中1件のみ削除
        const toDelete = target.note.includes('重複') ? [deleteInfo[0]] : deleteInfo;

        for (const info of toDelete) {
          if (info.record2flag === '1') {
            const msg = `record2flag=1: 削除不可 (assignid=${info.assignid})`;
            logger.warn(msg);
            evidenceLines.push(`  BLOCKED: ${msg}`);
            continue;
          }

          logger.info(`削除実行: ${info.rowText} (assignid=${info.assignid})`);
          evidenceLines.push(`  DELETE: ${info.rowText} (assignid=${info.assignid})`);

          // 削除ボタンをクリック
          const delBtn = await k2_2Frame.$(`input[name="act_delete"][onclick*="confirmDelete('${info.assignid}'"]`);
          if (delBtn) {
            await k2_2Frame.evaluate(() => {
              /* eslint-disable @typescript-eslint/no-explicit-any */
              (window as any).submited = 0;
              /* eslint-enable @typescript-eslint/no-explicit-any */
            });
            await delBtn.click();
            await sleep(2000);
          } else {
            await k2_2Frame.evaluate((aid) => {
              /* eslint-disable @typescript-eslint/no-explicit-any */
              const win = window as any;
              win.submited = 0;
              if (typeof win.confirmDelete === 'function') {
                win.confirmDelete(aid, '0');
              }
              /* eslint-enable @typescript-eslint/no-explicit-any */
            }, info.assignid);
            await sleep(2000);
          }

          // 上書き保存
          await nav.submitForm({
            action: 'act_update',
            setLockCheck: true,
            waitForPageId: 'k2_2',
          });
          await sleep(2000);

          logger.info(`削除完了: ${target.patientName} ${target.visitDate} ${target.startTime}`);
          evidenceLines.push(`  DONE: 削除完了`);
        }

      } catch (err) {
        const msg = `エラー: ${(err as Error).message}`;
        logger.error(msg);
        evidenceLines.push(`  ERROR: ${msg}`);
      }
    }

  } finally {
    await browser.close();
  }

  const evidenceText = evidenceLines.join('\n');
  fs.writeFileSync('.sisyphus/evidence/B1-deletions.txt', evidenceText);
  console.log('\n証拠ファイル保存: .sisyphus/evidence/B1-deletions.txt');
  console.log('\n=== 完了 ===');
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
