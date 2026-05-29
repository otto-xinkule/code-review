import { logger } from './logger.js';

/**
 * Retry utility for API calls and other transient operations.
 * Supports exponential backoff with jitter.
 */

export interface RetryOptions {
  /** Maximum number of retries */
  maxRetries: number;
  /** Base delay in ms */
  baseDelayMs?: number;
  /** Maximum delay in ms */
  maxDelayMs?: number;
  /** Backoff multiplier */
  backoffMultiplier?: number;
  /** Whether to add jitter */
  jitter?: boolean;
  /** Custom retry condition (return true to retry) */
  retryCondition?: (error: unknown) => boolean;
  /** Callback before each retry */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'retryCondition' | 'onRetry'>> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

/**
 * Check if an error looks like a rate limit / transient error.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('rate limit') || msg.includes('rate_limit')) return true;
    if (msg.includes('too many requests')) return true;
    if (msg.includes('timeout')) return true;
    if (msg.includes('econnreset') || msg.includes('econnrefused')) return true;
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
    if (msg.includes('429')) return true;
  }
  // Check for object with status
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.status === 'number' && obj.status >= 500) return true;
    if (obj.status === 429) return true;
  }
  return false;
}

/**
 * Calculate delay with exponential backoff and optional jitter.
 */
function calculateDelay(attempt: number, baseDelay: number, maxDelay: number, multiplier: number, jitter: boolean): number {
  const exponential = baseDelay * Math.pow(multiplier, attempt - 1);
  const capped = Math.min(exponential, maxDelay);
  if (jitter) {
    return capped * (0.5 + Math.random() * 0.5);
  }
  return capped;
}

/**
 * Execute a function with retry logic.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = { maxRetries: DEFAULT_OPTIONS.maxRetries },
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const retryCondition = opts.retryCondition || isRetryableError;

  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt > opts.maxRetries || !retryCondition(error)) {
        throw error;
      }

      const delay = calculateDelay(
        attempt,
        opts.baseDelayMs,
        opts.maxDelayMs,
        opts.backoffMultiplier,
        opts.jitter,
      );

      logger.warn(
        { attempt, maxRetries: opts.maxRetries, delayMs: Math.round(delay), error: String(error) },
        `Retry attempt ${attempt}/${opts.maxRetries} after ${Math.round(delay)}ms`,
      );

      if (opts.onRetry) {
        opts.onRetry(attempt, error, delay);
      }

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Sleep utility.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with timeout.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage = 'Operation timed out',
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs),
    ),
  ]);
}
