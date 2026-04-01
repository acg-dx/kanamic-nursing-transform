import { describe, it, expect } from 'vitest';
import { normalizeCjkName, extractPlainName, resolveStaffAlias } from '../cjk-normalize';

describe('normalizeCjkName', () => {
  it('ひらがな→カタカナ統一: 水口とも子 → 水口トモ子', () => {
    expect(normalizeCjkName('水口とも子')).toBe('水口トモ子');
  });

  it('ひらがな→カタカナ統一: 水口トモ子 → 水口トモ子 (カタカナはそのまま)', () => {
    expect(normalizeCjkName('水口トモ子')).toBe('水口トモ子');
  });

  it('表記揺れ統一: 水口とも子 と 水口トモ子 は同一キーになる', () => {
    expect(normalizeCjkName('水口とも子')).toBe(normalizeCjkName('水口トモ子'));
  });

  it('旧字体→新字体: 白澤英幸 → 白沢英幸', () => {
    expect(normalizeCjkName('白澤英幸')).toBe('白沢英幸');
  });

  it('旧字体+ひらがな複合: 髙橋ゆきこ → 高橋ユキコ', () => {
    expect(normalizeCjkName('髙橋ゆきこ')).toBe('高橋ユキコ');
  });

  it('空白除去', () => {
    expect(normalizeCjkName('山田　太郎')).toBe('山田太郎');
  });

  it('カタカナのみの名前はそのまま', () => {
    expect(normalizeCjkName('ヤマダタロウ')).toBe('ヤマダタロウ');
  });

  it('ひらがなのみの名前はカタカナに変換', () => {
    expect(normalizeCjkName('やまだたろう')).toBe('ヤマダタロウ');
  });

  it('ヲ→オ統一: 菊地しをり → 菊地シオリ (を→ヲ→オ)', () => {
    expect(normalizeCjkName('菊地しをり')).toBe('菊地シオリ');
  });

  it('ヲ→オ統一: しをり と しおり は同一キーになる', () => {
    expect(normalizeCjkName('菊地しをり')).toBe(normalizeCjkName('菊地しおり'));
  });

  it('Variation Selector 除去: 榊󠄀陽子 → 榊陽子', () => {
    expect(normalizeCjkName('榊\u{E0100}陽子')).toBe('榊陽子');
  });

  // === ヱ→エ 統一 ===
  it('ヱ→エ統一: 諸井スミヱ → 諸井スミエ', () => {
    expect(normalizeCjkName('諸井スミヱ')).toBe('諸井スミエ');
  });

  it('ヱ→エ統一: ゑ→エ (ひらがな経由)', () => {
    // ゑ(U+3091) → ヱ(U+30F1) via hiragana→katakana → エ(U+30A8) via ヱ→エ
    expect(normalizeCjkName('すゑ子')).toBe('スエ子');
  });

  // === ゼロ幅文字除去 ===
  it('ゼロ幅文字除去: Zero-Width Space', () => {
    expect(normalizeCjkName('持留\u200B宏昭')).toBe('持留宏昭');
  });

  it('ゼロ幅文字除去: Zero-Width Joiner', () => {
    expect(normalizeCjkName('池田\u200D清志')).toBe('池田清志');
  });

  it('ゼロ幅文字除去: BOM (U+FEFF)', () => {
    expect(normalizeCjkName('\uFEFF森洋')).toBe('森洋');
  });

  // === 実運用で検出された追加異体字 ===
  it('覺→覚: 覺堂五枝 → 覚堂五枝', () => {
    expect(normalizeCjkName('覺堂五枝')).toBe('覚堂五枝');
  });

  it('冨→富: 冨田政治 → 富田政治', () => {
    expect(normalizeCjkName('冨田政治')).toBe('富田政治');
  });

  it('滿→満: 鎌倉滿子 → 鎌倉満子', () => {
    expect(normalizeCjkName('鎌倉滿子')).toBe('鎌倉満子');
  });

  it('晧→皓: 笹川晧子 → 笹川皓子', () => {
    expect(normalizeCjkName('笹川晧子')).toBe('笹川皓子');
  });

  it('塲→場: 木塲英明 → 木場英明', () => {
    expect(normalizeCjkName('木塲英明')).toBe('木場英明');
  });

  it('當→当: 部當一喜 → 部当一喜', () => {
    expect(normalizeCjkName('部當一喜')).toBe('部当一喜');
  });

  it('簑→蓑: 簑島輝美 → 蓑島輝美', () => {
    expect(normalizeCjkName('簑島輝美')).toBe('蓑島輝美');
  });
});

describe('実運用利用者名の正規化（全161名）', () => {
  // 正規化後に特殊文字が残らないことを検証
  const problemNames = [
    '持留宏昭','榊\u{E0100}陽子','嶺山吉弘','池田清志','岡積直樹','今村美智子',
    '小吉孝子','森洋','西村竜二','大重スミ子','池田真理子','田原啓子','菱田行雄',
    '福永雅代','面髙ソヨ子','濵田浩三','坂元悠子','弓場千鶴子','三園孝一','坂光弘',
    '宮内敬久','枦山美智代','吉永良子','益田一三','久保勝久','古賀和馬','集美奈代',
    '有馬隆男','相良和子','藤川玲子','丸尾俊明','川崎安世','木塲英明','小倉孝子',
    '諸井スミヱ','山下マリ子','小園公雄','上山雅彦','福増安彦','塩川敏子','谷口豊子',
    '宮里正','下田平道雄','関山吉忠','菊永順子','安山明子','伊㔟慶国','柳俊隆',
    '堀ノ内エミ子','山田朋世','川畑宏樹','水口トモ子','厚地知子','東山政和',
    '楠元康弘','栗下泰馬','面髙正則','田島實','永松敏之','冨田政治','牧和',
    '大河タズ子','笹川晧子','肥後順子','原口歌子','敖涛','射場初子','渡部誠一',
    '春山輝明','荒木きぬ子','加治屋彰三郎','濵田博子','大橋建夫','福重康雄',
    '西輝秋','田中チエ子','椎井竜二','永山クメ子','尾立孝子','榎本宏','羽田紀雄',
    '菊地順一郎','東福光治','日髙達朗','関秀三','中原一美','鹿島竹子',
    '日笠山さえ子','貴島ミチ子','篠崎良子','前田アイ子','阿久根泰宗','窪園祝子',
    '原成穂','高橋和男','黒木哲志','大山直昭','脇田由美','伊東光子','有村零子',
    '末吉隆','岩永詞貴','塩田敏文','森美奈子','下村裕子','奥忠光','田村ヒロ子',
    '岩下了子','山野一孝','部當一喜','奥篤子','永江甲一','奥いつ子','覺堂五枝',
    '古藤イリ子','岡﨑敬長','佐藤三千子','簑島輝美','牧ミチ子','竹之内淳子',
    '出口治子','久保正光','鍛治貞良','新井輝夫','九万田一巳','中村德子',
    '竹之下享也','中島光明','榎元光一','竹田榮和','永田由美子','末永瑠璃子',
    '境田妙子','有村ミチ子','加藤ユミ','鎌倉滿子','松村美文','中村博一',
    '米倉健一郎','髙野久江','赤﨑和子','菊浦浩美','中村マサ子','山宮恒臣',
    '丸鶴笑子','瀨戸口美智子','伊東歳郎','濵田勇次','山下玲子','平尾泰享',
    '安藤カズエ','木佐貫美佐子','福永辰巳','野上陽子','桑野敏弘','波呂清美',
    '德永文子','長村直樹','小島和義','古賀正之','河野雄一',
  ];

  it.each(problemNames)('"%s" は正規化後に不可見文字を含まない', (name) => {
    const normalized = normalizeCjkName(name);
    // 不可見文字が残っていないか検証
    expect(normalized).not.toMatch(/[\uFE00-\uFE0F]/); // VS1-16
    expect(normalized).not.toMatch(/\uDB40[\uDD00-\uDDEF]/); // VS17-256
    expect(normalized).not.toMatch(/[\u200B-\u200F]/); // zero-width
    expect(normalized).not.toMatch(/\uFEFF/); // BOM
    expect(normalized).not.toMatch(/\s/); // whitespace
    // 結果が空でないこと
    expect(normalized.length).toBeGreaterThan(0);
  });

  it('特殊文字を含む名前が正しく正規化される', () => {
    // 代表的な特殊文字ケースを具体的に検証
    expect(normalizeCjkName('面髙ソヨ子')).toBe('面高ソヨ子');
    expect(normalizeCjkName('濵田浩三')).toBe('浜田浩三');
    expect(normalizeCjkName('伊㔟慶国')).toBe('伊勢慶国');
    expect(normalizeCjkName('田島實')).toBe('田島実');
    expect(normalizeCjkName('日髙達朗')).toBe('日高達朗');
    expect(normalizeCjkName('岡﨑敬長')).toBe('岡崎敬長');
    expect(normalizeCjkName('中村德子')).toBe('中村徳子');
    expect(normalizeCjkName('竹田榮和')).toBe('竹田栄和');
    expect(normalizeCjkName('瀨戸口美智子')).toBe('瀬戸口美智子');
    expect(normalizeCjkName('德永文子')).toBe('徳永文子');
    expect(normalizeCjkName('髙野久江')).toBe('高野久江');
    expect(normalizeCjkName('赤﨑和子')).toBe('赤崎和子');
  });

  it('ひらがなを含む名前がカタカナに統一される', () => {
    expect(normalizeCjkName('荒木きぬ子')).toBe('荒木キヌ子');
    expect(normalizeCjkName('日笠山さえ子')).toBe('日笠山サエ子');
    expect(normalizeCjkName('奥いつ子')).toBe('奥イツ子');
  });
});

describe('extractPlainName + normalizeCjkName (staffSurname extraction)', () => {
  it('看護師-白澤英幸 → normalizeCjkName → 白沢英幸 → substring(0,3) → 白沢英', () => {
    const plain = extractPlainName('看護師-白澤英幸');
    const normalized = normalizeCjkName(plain);
    expect(normalized).toBe('白沢英幸');
    expect(normalized.substring(0, 3)).toBe('白沢英');
  });

  it('看護師-水口とも子 → normalizeCjkName → 水口トモ子 → substring(0,3) → 水口ト', () => {
    const plain = extractPlainName('看護師-水口とも子');
    const normalized = normalizeCjkName(plain);
    expect(normalized).toBe('水口トモ子');
    expect(normalized.substring(0, 3)).toBe('水口ト');
  });

  it('准看護師-福留ゆかり → 福留ユカリ', () => {
    const plain = extractPlainName('准看護師-福留ゆかり');
    expect(normalizeCjkName(plain)).toBe('福留ユカリ');
  });

  it('看護師-菊地しをり → 菊地シオリ', () => {
    const plain = extractPlainName('看護師-菊地しをり');
    expect(normalizeCjkName(plain)).toBe('菊地シオリ');
  });
});

describe('resolveStaffAlias', () => {
  it('木村利愛 → 高山利愛', () => {
    expect(resolveStaffAlias('木村利愛')).toBe('高山利愛');
  });

  it('新盛裕望 → 落合裕望', () => {
    expect(resolveStaffAlias('新盛裕望')).toBe('落合裕望');
  });

  it('エイリアスなしの名前はそのまま返す', () => {
    expect(resolveStaffAlias('山田太郎')).toBe('山田太郎');
  });

  it('空白を含む名前も正規化してエイリアス解決', () => {
    expect(resolveStaffAlias('木村　利愛')).toBe('高山利愛');
  });

  it('上畝地葉月 → 竹崎葉月', () => {
    expect(resolveStaffAlias('上畝地葉月')).toBe('竹崎葉月');
  });
});
