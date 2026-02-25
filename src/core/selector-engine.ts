import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';
import { logger } from './logger';
import { AIHealingService } from './ai-healing-service';
import type { SelectorMap, SelectorConfig } from '../types/selector.types';

export class SelectorEngine {
  private selectorMaps: Map<string, SelectorMap> = new Map();
  private aiHealingService: AIHealingService | null = null;
  private selectorsDir: string;

  constructor(aiHealingService?: AIHealingService) {
    this.aiHealingService = aiHealingService || null;
    this.selectorsDir = path.resolve(__dirname, '../config/selectors');
  }

  static register(): void {
    // Playwright custom engine registration (no-op for CSS selectors)
  }

  private loadSelectorMap(workflowName: string): SelectorMap {
    if (this.selectorMaps.has(workflowName)) {
      return this.selectorMaps.get(workflowName)!;
    }
    const filePath = path.join(this.selectorsDir, `${workflowName}.selectors.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`セレクタファイルが見つかりません: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const map = JSON.parse(content) as SelectorMap;
    this.selectorMaps.set(workflowName, map);
    return map;
  }

  private saveSelectorMap(workflowName: string, map: SelectorMap): void {
    const filePath = path.join(this.selectorsDir, `${workflowName}.selectors.json`);
    map.lastUpdated = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(map, null, 2), 'utf-8');
    this.selectorMaps.set(workflowName, map);
  }

  async resolve(selectorId: string, workflowName: string, page: Page): Promise<string> {
    const map = this.loadSelectorMap(workflowName);
    const config = map.selectors[selectorId];
    if (!config) {
      throw new Error(`セレクタIDが見つかりません: ${selectorId} (workflow: ${workflowName})`);
    }

    // 1. AI修復済みセレクタを試す
    if (config.aiHealed) {
      const el = await page.$(config.aiHealed).catch(() => null);
      if (el) {
        logger.debug(`AI修復済みセレクタ使用: ${selectorId} → ${config.aiHealed}`);
        return config.aiHealed;
      }
    }

    // 2. プライマリセレクタを試す
    const primaryEl = await page.$(config.primary).catch(() => null);
    if (primaryEl) {
      return config.primary;
    }

    // 3. フォールバックセレクタを試す
    for (const fallback of config.fallbacks) {
      const el = await page.$(fallback).catch(() => null);
      if (el) {
        logger.debug(`フォールバックセレクタ使用: ${selectorId} → ${fallback}`);
        return fallback;
      }
    }

    // 4. AI自愈
    if (this.aiHealingService) {
      logger.warn(`セレクタ解決失敗、AI自愈を試みます: ${selectorId}`);
      const result = await this.aiHealingService.healSelector(
        page, selectorId, config.primary, config.context
      );
      if (result && result.confidence >= 0.5) {
        // 検証
        const el = await page.$(result.selector).catch(() => null);
        if (el) {
          // 永続化
          config.aiHealed = result.selector;
          config.lastHealed = new Date().toISOString();
          config.confidence = result.confidence;
          this.saveSelectorMap(workflowName, map);
          logger.info(`AI自愈成功・永続化: ${selectorId} → ${result.selector}`);
          return result.selector;
        }
      }
    }

    throw new Error(`セレクタ解決失敗: ${selectorId} (workflow: ${workflowName})`);
  }

  /** キャッシュをクリア（テスト用） */
  clearCache(): void {
    this.selectorMaps.clear();
  }
}
