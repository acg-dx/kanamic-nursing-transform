import type { Page } from 'playwright';

export class SelectorEngine {
  static register() {}
  
  async resolve(selectorId: string, workflowName: string, page: Page): Promise<string> {
    return '';
  }
}
