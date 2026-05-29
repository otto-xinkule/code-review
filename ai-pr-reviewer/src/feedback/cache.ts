import type { ReviewResult, CacheEntry } from '../types/index.js';
import { logger } from '../utility/logger.js';
import { getConfig } from '../config/index.js';

/**
 * Analysis Cache Module
 *
 * Provides in-memory caching for analysis results.
 * Reduces redundant API calls for identical PR states.
 * Uses commit SHA as the primary cache key.
 */

class AnalysisCache {
  private cache: Map<string, CacheEntry<ReviewResult>>;
  private cleanupInterval: NodeJS.Timeout | null;

  constructor() {
    this.cache = new Map();
    this.cleanupInterval = null;
    this.startCleanup();
  }

  /**
   * Generate a cache key from repository and head commit SHA.
   */
  private generateKey(repository: string, headSha: string): string {
    return `${repository}:${headSha}`;
  }

  /**
   * Get a cached review result.
   */
  get(repository: string, headSha: string): ReviewResult | null {
    const key = this.generateKey(repository, headSha);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if entry has expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      logger.debug({ key }, 'Cache entry expired');
      return null;
    }

    logger.info({ key }, 'Cache hit');
    return entry.data;
  }

  /**
   * Store a review result in the cache.
   */
  set(repository: string, headSha: string, result: ReviewResult): void {
    const config = getConfig();
    const key = this.generateKey(repository, headSha);

    const ttlMs = config.advanced.cacheTtlSeconds * 1000;

    const entry: CacheEntry<ReviewResult> = {
      data: result,
      key,
      expiresAt: Date.now() + ttlMs,
      createdAt: Date.now(),
    };

    this.cache.set(key, entry);
    logger.debug({ key, ttlMs }, 'Cached review result');
  }

  /**
   * Remove a specific cached entry.
   */
  delete(repository: string, headSha: string): void {
    const key = this.generateKey(repository, headSha);
    this.cache.delete(key);
    logger.debug({ key }, 'Cache entry deleted');
  }

  /**
   * Check if a result is cached for the given PR state.
   */
  has(repository: string, headSha: string): boolean {
    const key = this.generateKey(repository, headSha);
    const entry = this.cache.get(key);

    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Get cache statistics.
   */
  getStats(): { size: number; entries: Array<{ key: string; age: number; ttl: number }> } {
    const now = Date.now();
    const entries: Array<{ key: string; age: number; ttl: number }> = [];

    for (const [key, entry] of this.cache.entries()) {
      entries.push({
        key,
        age: now - entry.createdAt,
        ttl: entry.expiresAt - now,
      });
    }

    return {
      size: this.cache.size,
      entries,
    };
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    logger.info({ cleared: size }, 'Cache cleared');
  }

  /**
   * Start periodic cleanup of expired entries.
   */
  private startCleanup(): void {
    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [key, entry] of this.cache.entries()) {
        if (now > entry.expiresAt) {
          this.cache.delete(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.debug({ cleaned, remaining: this.cache.size }, 'Cache cleanup completed');
      }
    }, 5 * 60 * 1000);
  }

  /**
   * Stop the cleanup interval (for graceful shutdown).
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/** Singleton instance */
let _cache: AnalysisCache | null = null;

export function getCache(): AnalysisCache {
  if (!_cache) {
    _cache = new AnalysisCache();
  }
  return _cache;
}

export { AnalysisCache };
export default AnalysisCache;
