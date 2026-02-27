import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';
import { logger } from './logger';
import type { AIHealingResult } from '../types/selector.types';

export class AIHealingService {
  private client: OpenAI;
  private model: string;
  private screenshotDir: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.screenshotDir = process.env.SCREENSHOT_DIR || './screenshots';
  }

  async healSelector(
    page: Page,
    selectorId: string,
    failedSelector: string,
    context: string
  ): Promise<AIHealingResult | null> {
    let screenshotPath: string | null = null;

    try {
      // スクリーンショット取得
      const safeName = `heal_${selectorId}_${Date.now()}`;
      screenshotPath = path.resolve(this.screenshotDir, `${safeName}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });

      // ページHTML取得（最初の10000文字）
      const html = await page.content();
      const truncatedHtml = html.substring(0, 10000);

      // スクリーンショットをbase64エンコード
      const imageData = fs.readFileSync(screenshotPath);
      const base64Image = imageData.toString('base64');

      const prompt = `You are a CSS selector expert for a Japanese healthcare RPA system (Kanamick).

A CSS selector has failed and needs to be fixed.

Failed selector ID: ${selectorId}
Failed selector: ${failedSelector}
Context: ${context}

Page HTML (truncated):
${truncatedHtml}

Please analyze the page HTML and provide a new CSS selector that would correctly identify the element.

Respond with ONLY a JSON object in this exact format:
{
  "selector": "the new CSS selector",
  "confidence": 0.85,
  "reasoning": "brief explanation of why this selector works"
}

Requirements:
- The selector must be valid CSS
- Confidence should be between 0 and 1
- If you cannot find a suitable selector, set confidence to 0`;

      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${base64Image}`,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        logger.warn('AI自愈: レスポンスが空です');
        return null;
      }

      // JSONパース
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn(`AI自愈: JSONが見つかりません: ${content}`);
        return null;
      }

      const result = JSON.parse(jsonMatch[0]) as AIHealingResult;

      if (result.confidence < 0.5) {
        logger.warn(`AI自愈: 信頼度が低すぎます (${result.confidence}): ${selectorId}`);
        return null;
      }

      // CSSセレクタの安全性検証
      if (!this.isValidCSSSelector(result.selector)) {
        logger.warn(`AI自愈: 無効なCSSセレクタ: ${result.selector}`);
        return null;
      }

      logger.info(`AI自愈成功: ${selectorId} → ${result.selector} (信頼度: ${result.confidence})`);
      return result;
    } catch (error) {
      logger.error(`AI自愈エラー: ${selectorId}: ${(error as Error).message}`);
      return null;
    } finally {
      // スクリーンショット削除（PHI保護）
      if (screenshotPath && fs.existsSync(screenshotPath)) {
        try {
          fs.unlinkSync(screenshotPath);
        } catch {
          // 削除失敗は無視
        }
      }
    }
  }

  private isValidCSSSelector(selector: string): boolean {
    // 基本的な安全性チェック
    if (!selector || selector.trim().length === 0) return false;
    // スクリプトインジェクション防止
    if (selector.includes('<') || selector.includes('>') || selector.includes('javascript:')) {
      return false;
    }
    // 長さ制限
    if (selector.length > 500) return false;
    return true;
  }
}
