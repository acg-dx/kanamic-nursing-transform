/**
 * 資格修正マニフェスト生成サービス
 *
 * HAM 8-1 CSV と SmartHR 資格データを突合し、
 * 看護医療の資格誤登録を検出して修正マニフェストを生成する。
 *
 * 検出対象:
 * - 看護師等 ↔ 准看護師 の誤登録
 * - 理学療法士等 が 看護師等/准看護師 で誤登録されているケース
 * - 看護師等/准看護師 が 理学療法士等 で誤登録されているケース
 *
 * ビジネスルール:
 * - 看護医療のみ対象（介護保険・予防訪問看護は対象外）
 * - 資格優先度: 看護師 > 准看護師 > 理学療法士等（上位を優先適用）
 * - CSV 判定: サービス内容の「・准」有無 + 「理学療法士等」有無
 * - CSV 開始時刻=終了時刻のレコードは突合対象外
 */

import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import { SmartHRService } from './smarthr.service';
import { normalizeCjkName } from '../core/cjk-normalize';
import dotenv from 'dotenv';

dotenv.config();

export interface CorrectionRecord {
  patientName: string;
  date: string;        // YYYY-MM-DD (from CSV: YYYY/MM/DD)
  startTime: string;   // HH:MM
  endTime: string;     // HH:MM
  staffName: string;   // plain name (no qualification prefix)
  currentService: string;  // current service content in HAM
  targetQualification: '看護師等' | '准看護師' | '理学療法士等';
  searchKbn: '1' | '2' | '3';  // 1=看護師等, 2=准看護師, 3=理学療法士等
}

interface CsvRecord {
  date: string;
  startTime: string;
  endTime: string;
  patientName: string;
  staffName: string;
  empCode: string;
  serviceType: string;   // サービス種類
  serviceContent: string; // サービス内容
}

function normalize(s: string): string {
  return normalizeCjkName(s.normalize('NFKC').replace(/[\s\u3000\u00a0]+/g, '').trim());
}

function parseCsv(text: string): CsvRecord[] {
  const lines = text.split('\n');
  const records: CsvRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // CSV パース（クォート対応）
    const cols: string[] = [];
    let cur = '';
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cols.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cols.push(cur);

    if (cols.length < 17) continue;

    const serviceType = (cols[11] || '').trim(); // サービス種類
    if (serviceType !== '看護医療') continue; // 看護医療のみ

    const patientName = (cols[4] || '').trim();
    const staffName = (cols[7] || '').trim();
    if (!staffName || !patientName) continue;

    // テスト患者を除外
    if (['青空太郎', '練習七郎', 'テスト'].some(t => patientName.includes(t))) continue;

    // 開始時刻=終了時刻のレコードは突合対象外（無効データ）
    const startTime = (cols[2] || '').trim();
    const endTime = (cols[3] || '').trim();
    if (startTime === endTime) continue;

    const serviceContent = (cols[12] || '').trim();

    records.push({
      date: (cols[0] || '').trim(),
      startTime,
      endTime,
      patientName,
      staffName,
      empCode: (cols[8] || '').trim(),
      serviceType,
      serviceContent,
    });
  }

  return records;
}

export class QualificationCorrectionService {
  private smarthr: SmartHRService;
  private csvPath: string;
  private checkpointPath: string;

  constructor(csvPath?: string) {
    this.smarthr = new SmartHRService({
      baseUrl: process.env.SMARTHR_BASE_URL || 'https://acg.smarthr.jp/api/v1',
      accessToken: process.env.SMARTHR_ACCESS_TOKEN || '',
    });
    this.csvPath = csvPath || path.join(process.cwd(), 'downloads', 'schedule_8-1_202602.csv');
    this.checkpointPath = path.join(process.cwd(), 'tmp', 'correction-checkpoint.json');
  }

  /**
   * 修正マニフェストを生成する
   */
  async generateManifest(): Promise<CorrectionRecord[]> {
    // CSV を読み込む（Shift-JIS）
    const buf = fs.readFileSync(this.csvPath);
    const text = iconv.decode(buf, 'Shift_JIS');
    const csvRecords = parseCsv(text);

    console.log(`CSV 看護医療レコード: ${csvRecords.length} 件`);

    // SmartHR から全従業員の資格を取得
    const allCrews = await this.smarthr.getAllCrews();
    console.log(`SmartHR 従業員: ${allCrews.length} 名`);

    // 従業員名 → 資格マップを構築
    const qualMap = new Map<string, string[]>(); // normName → qualifications[]
    for (const crew of allCrews) {
      const quals = this.smarthr.getQualifications(crew);
      const fullName = normalize(`${crew.last_name}${crew.first_name}`);
      qualMap.set(fullName, quals);
      if (crew.business_last_name) {
        const bizName = normalize(`${crew.business_last_name}${crew.business_first_name || ''}`);
        qualMap.set(bizName, quals);
      }
    }

    // 修正マニフェストを生成
    const manifest: CorrectionRecord[] = [];
    let unmatched = 0;

    for (const rec of csvRecords) {
      const normStaff = normalize(rec.staffName);
      const quals = qualMap.get(normStaff);

      if (!quals) {
        unmatched++;
        continue;
      }

      // 資格優先度ルール: 看護師 > 准看護師 > 理学療法士等
      const hasKangoshi = quals.some(q => q === '看護師' || q === '正看護師');
      const hasJunKangoshi = quals.some(q => q === '准看護師');
      const hasRigaku = quals.some(q =>
        q.includes('理学療法士') || q.includes('作業療法士') || q.includes('言語聴覚士')
      );

      // 正しい searchKbn を決定（優先度順）
      let correctQual: CorrectionRecord['targetQualification'];
      let correctKbn: CorrectionRecord['searchKbn'];
      if (hasKangoshi)        { correctQual = '看護師等';     correctKbn = '1'; }
      else if (hasJunKangoshi) { correctQual = '准看護師';     correctKbn = '2'; }
      else if (hasRigaku)      { correctQual = '理学療法士等'; correctKbn = '3'; }
      else continue; // 看護師系・理学療法士系いずれの資格もなし → スキップ

      // CSV サービス内容から現在の登録 searchKbn を判定
      let currentKbn: '1' | '2' | '3';
      if (rec.serviceContent.includes('理学療法士等')) { currentKbn = '3'; }
      else if (rec.serviceContent.endsWith('・准'))    { currentKbn = '2'; }
      else                                             { currentKbn = '1'; }

      // 不一致を検出
      if (correctKbn !== currentKbn) {
        manifest.push({
          patientName: rec.patientName,
          date: rec.date.replace(/\//g, '-'), // YYYY/MM/DD → YYYY-MM-DD
          startTime: rec.startTime,
          endTime: rec.endTime,
          staffName: rec.staffName,
          currentService: rec.serviceContent,
          targetQualification: correctQual,
          searchKbn: correctKbn,
        });
      }
    }

    if (unmatched > 0) {
      console.warn(`SmartHR 未照合スタッフ: ${unmatched} 件（スキップ）`);
    }

    return manifest;
  }

  /**
   * チェックポイントを読み込む（完了済みレコードキーのセット）
   */
  async loadCheckpoint(): Promise<Set<string>> {
    try {
      if (!fs.existsSync(this.checkpointPath)) return new Set();
      const data = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf-8'));
      return new Set(data.completed || []);
    } catch {
      return new Set();
    }
  }

  /**
   * チェックポイントを保存する
   */
  async saveCheckpoint(completedKeys: Set<string>): Promise<void> {
    const dir = path.dirname(this.checkpointPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.checkpointPath, JSON.stringify({
      completed: Array.from(completedKeys),
      updatedAt: new Date().toISOString(),
    }, null, 2));
  }

  /**
   * レコードの一意キーを生成
   */
  static recordKey(rec: CorrectionRecord): string {
    return `${rec.patientName}|${rec.date}|${rec.startTime}|${rec.staffName}`;
  }
}
