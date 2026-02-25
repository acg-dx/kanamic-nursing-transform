import { logger } from './logger';

export interface RetryOptions {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      logger.warn(`[${label}] 第${attempt}/${opts.maxAttempts}次尝试失败: ${lastError.message}`);

      if (attempt < opts.maxAttempts) {
        const delay = Math.min(
          opts.baseDelay * Math.pow(opts.backoffMultiplier, attempt - 1),
          opts.maxDelay
        );
        logger.info(`[${label}] ${delay}ms 后重试...`);
        await sleep(delay);
      }
    }
  }

  if (!lastError) throw new Error(`[${label}] 未执行任何重试 (maxAttempts=${opts.maxAttempts})`);
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
