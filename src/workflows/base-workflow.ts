import { BrowserManager } from '../core/browser-manager';
import { SelectorEngine } from '../core/selector-engine';
import { SpreadsheetService } from '../services/spreadsheet.service';
import { KanamickAuthService } from '../services/kanamick-auth.service';
import type { WorkflowContext, WorkflowResult } from '../types/workflow.types';

export abstract class BaseWorkflow {
  protected browser: BrowserManager;
  protected selectors: SelectorEngine;
  protected sheets: SpreadsheetService;
  protected auth: KanamickAuthService;

  constructor(
    browser: BrowserManager,
    selectors: SelectorEngine,
    sheets: SpreadsheetService,
    auth: KanamickAuthService
  ) {
    this.browser = browser;
    this.selectors = selectors;
    this.sheets = sheets;
    this.auth = auth;
  }

  abstract run(context: WorkflowContext): Promise<WorkflowResult[]>;

  protected async executeWithTiming(fn: () => Promise<WorkflowResult>): Promise<WorkflowResult> {
    const start = Date.now();
    const result = await fn();
    return { ...result, duration: Date.now() - start };
  }
}
