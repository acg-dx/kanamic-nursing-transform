/**
 * staff_info.csv パーサー
 *
 * TRITRUS からエクスポートされた Shift-JIS エンコードの CSV ファイルを読み込み、
 * 従業員番号 → スタッフ情報のマッピングを返す。
 *
 * CSV 構造 (25列):
 *   [0] 氏名(フリガナ)  [1] 氏名(漢字)  [18] 従業員番号  [19] 事業所名  [14] 代表事業所名称
 */
import fs from 'fs';
import iconv from 'iconv-lite';

export interface StaffCSVRecord {
  empNo: string;           // CSV上の生値（先頭ゼロ含む）
  normalizedEmpNo: string; // 先頭ゼロ除去済み
  name: string;            // 氏名(漢字) col[1]
  kana: string;            // 氏名(フリガナ) col[0]
  mainOffice: string;      // 代表事業所名称 col[14]
  offices: string[];       // 事業所名 col[19] をカンマ分割
}

/**
 * マルチライン対応の引用符付き CSV パーサー。
 * TRITRUS エクスポートの CSV は col[22]–[24] に改行を含むフィールドがあるため、
 * 単純な split('\n') では行が壊れる。
 */
function parseQuotedCSV(text: string): string[][] {
  const records: string[][] = [];
  let i = 0;
  while (i < text.length) {
    const row: string[] = [];
    while (i < text.length) {
      if (text[i] === '"') {
        // 引用符付きフィールド
        i++; // opening quote をスキップ
        let field = '';
        while (i < text.length) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              // エスケープされた引用符
              field += '"';
              i += 2;
            } else {
              // フィールド終了
              i++;
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
        row.push(field);
      } else {
        // 引用符なしフィールド
        let field = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i];
          i++;
        }
        row.push(field);
      }
      // 区切り判定
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === '\r') i++;
      if (text[i] === '\n') {
        i++;
        break;
      }
      break;
    }
    if (row.length > 1 || (row.length === 1 && row[0])) {
      records.push(row);
    }
  }
  return records;
}

/** 先頭ゼロ除去: "00001482" → "1482", "78" → "78" */
export function normalizeEmpNo(empNo: string): string {
  const stripped = empNo.replace(/^0+/, '');
  return stripped || '0';
}

/**
 * staff_info.csv (Shift-JIS) をパースし、正規化した従業員番号をキーとする Map を返す。
 *
 * @param csvPath staff_info.csv のファイルパス
 * @returns Map<normalizedEmpNo, StaffCSVRecord>
 */
export function parseStaffInfoCSV(csvPath: string): Map<string, StaffCSVRecord> {
  const buf = fs.readFileSync(csvPath);
  const text = iconv.decode(buf, 'Shift_JIS');
  const rows = parseQuotedCSV(text);

  const map = new Map<string, StaffCSVRecord>();
  // ヘッダー (row 0) をスキップ
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const empNo = (r[18] || '').trim();
    if (!empNo) continue;

    const normalized = normalizeEmpNo(empNo);
    const officesRaw = (r[19] || '').trim();

    map.set(normalized, {
      empNo,
      normalizedEmpNo: normalized,
      name: (r[1] || '').trim(),
      kana: (r[0] || '').trim(),
      mainOffice: (r[14] || '').trim(),
      offices: officesRaw
        ? officesRaw.split(',').map(s => s.trim()).filter(Boolean)
        : [],
    });
  }

  return map;
}
