import { logger } from '../core/logger';
import { BrowserManager } from '../core/browser-manager';
import { withRetry } from '../core/retry-manager';

export class KanamickAuthService {
  private browser: BrowserManager;
  private baseUrl: string;
  private username: string;
  private password: string;
  private isLoggedIn = false;

  constructor(
    browser: BrowserManager,
    baseUrl: string,
    username: string,
    password: string
  ) {
    this.browser = browser;
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
  }

  async login(workflowName: string): Promise<void> {
    if (this.isLoggedIn) {
      logger.info('已登录，跳过登录步骤');
      return;
    }

    await withRetry(
      async () => {
        logger.info('登录 Kanamick...');
        await this.browser.navigate(this.baseUrl);
        await this.browser.safeType('login_username', this.username, workflowName);
        await this.browser.safeType('login_password', this.password, workflowName);
        await this.browser.safeClick('login_submit', workflowName);

        // 等待登录成功（检测主页面元素）
        await this.browser.waitForElement('main_dashboard', workflowName, 15000);
        this.isLoggedIn = true;
        logger.info('Kanamick 登录成功');
      },
      '登录',
      { maxAttempts: 3, baseDelay: 2000 }
    );
  }

  async ensureLoggedIn(workflowName: string): Promise<void> {
    try {
      await this.browser.waitForElement('main_dashboard', workflowName, 3000);
    } catch {
      logger.info('会话可能已过期，重新登录...');
      this.isLoggedIn = false;
      await this.login(workflowName);
    }
  }
}
