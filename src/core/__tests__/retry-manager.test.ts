import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry } from '../retry-manager';

// Mock the logger module
vi.mock('../logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

describe('withRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should succeed on first attempt', async () => {
    const fn = vi.fn().mockResolvedValueOnce('success');
    const result = await withRetry(fn, 'test-label');
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and eventually succeed', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('attempt 1 failed'))
      .mockRejectedValueOnce(new Error('attempt 2 failed'))
      .mockResolvedValueOnce('success on attempt 3');
    
    const result = await withRetry(fn, 'test-label', { baseDelay: 10 });
    
    expect(result).toBe('success on attempt 3');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after maxAttempts exhausted', async () => {
    const testError = new Error('persistent failure');
    const fn = vi.fn().mockRejectedValue(testError);
    
    await expect(
      withRetry(fn, 'test-label', { maxAttempts: 2, baseDelay: 10 })
    ).rejects.toThrow('persistent failure');
    
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
