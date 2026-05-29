import type { FeedbackEntry, FeedbackStats, RiskCategory } from '../types/index.js';
import { logger } from '../utility/logger.js';
import { metrics } from '../utility/metrics.js';

/**
 * Feedback Learner Module
 *
 * Collects developer feedback on AI review suggestions,
 * computes acceptance rates, and provides insights for
 * continuous improvement of the review system.
 *
 * Inspired by the Cursor BugBot feedback loop approach.
 */

interface FeedbackStore {
  entries: FeedbackEntry[];
  stats: FeedbackStats;
}

class FeedbackLearner {
  private store: FeedbackStore;

  constructor() {
    this.store = {
      entries: [],
      stats: this.createEmptyStats(),
    };
  }

  private createEmptyStats(): FeedbackStats {
    return {
      totalEntries: 0,
      acceptanceRate: 0,
      byCategory: {},
      byModel: {},
      falsePositiveRate: 0,
      commonRejections: [],
    };
  }

  /**
   * Record feedback from a developer on an AI suggestion.
   */
  recordFeedback(
    issueId: string,
    accepted: boolean,
    rejectionReason: string | undefined,
    category: RiskCategory,
    model: string,
    context: {
      repository: string;
      prNumber: number;
      file: string;
      language: string;
    },
  ): FeedbackEntry {
    const entry: FeedbackEntry = {
      issueId,
      accepted,
      rejectionReason,
      category,
      model,
      timestamp: new Date().toISOString(),
      context,
    };

    this.store.entries.push(entry);
    this.updateStats();

    // Record metrics
    metrics.recordFeedback(accepted, category, model);

    logger.info(
      {
        issueId,
        accepted,
        category,
        model,
        reason: rejectionReason,
      },
      'Feedback recorded',
    );

    return entry;
  }

  /**
   * Update statistics from stored entries.
   */
  private updateStats(): void {
    const entries = this.store.entries;
    const total = entries.length;

    if (total === 0) {
      this.store.stats = this.createEmptyStats();
      return;
    }

    const accepted = entries.filter((e) => e.accepted).length;
    const rejected = entries.filter((e) => !e.accepted).length;

    // By category
    const byCategory: Record<string, { total: number; accepted: number }> = {};
    for (const entry of entries) {
      if (!byCategory[entry.category]) {
        byCategory[entry.category] = { total: 0, accepted: 0 };
      }
      byCategory[entry.category].total++;
      if (entry.accepted) {
        byCategory[entry.category].accepted++;
      }
    }

    const byCategoryRates: Record<string, number> = {};
    for (const [cat, data] of Object.entries(byCategory)) {
      byCategoryRates[cat] = data.accepted / data.total;
    }

    // By model
    const byModel: Record<string, { total: number; accepted: number }> = {};
    for (const entry of entries) {
      if (!byModel[entry.model]) {
        byModel[entry.model] = { total: 0, accepted: 0 };
      }
      byModel[entry.model].total++;
      if (entry.accepted) {
        byModel[entry.model].accepted++;
      }
    }

    const byModelRates: Record<string, number> = {};
    for (const [model, data] of Object.entries(byModel)) {
      byModelRates[model] = data.accepted / data.total;
    }

    // Common rejection reasons
    const rejectionReasons = entries
      .filter((e) => !e.accepted && e.rejectionReason)
      .map((e) => e.rejectionReason!);

    const reasonCounts: Record<string, number> = {};
    for (const reason of rejectionReasons) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }

    const commonRejections = Object.entries(reasonCounts)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    this.store.stats = {
      totalEntries: total,
      acceptanceRate: accepted / total,
      byCategory: byCategoryRates,
      byModel: byModelRates,
      falsePositiveRate: rejected / total,
      commonRejections,
    };
  }

  /**
   * Get current feedback statistics.
   */
  getStats(): FeedbackStats {
    return { ...this.store.stats };
  }

  /**
   * Get feedback entries, optionally filtered.
   */
  getEntries(filter?: {
    category?: RiskCategory;
    model?: string;
    accepted?: boolean;
    since?: string;
  }): FeedbackEntry[] {
    let entries = this.store.entries;

    if (filter?.category) {
      entries = entries.filter((e) => e.category === filter.category);
    }
    if (filter?.model) {
      entries = entries.filter((e) => e.model === filter.model);
    }
    if (filter?.accepted !== undefined) {
      entries = entries.filter((e) => e.accepted === filter.accepted);
    }
    if (filter?.since) {
      const sinceDate = new Date(filter.since).getTime();
      entries = entries.filter((e) => new Date(e.timestamp).getTime() >= sinceDate);
    }

    return entries;
  }

  /**
   * Get the acceptance rate for a specific issue pattern.
   * Used to identify high-false-positive patterns.
   */
  getAcceptanceRate(category: RiskCategory): number {
    return this.store.stats.byCategory[category] || 0;
  }

  /**
   * Check if we should suppress a type of issue based on past feedback.
   * Returns true if the issue type has a consistently low acceptance rate.
   */
  shouldSuppress(category: RiskCategory, threshold: number = 0.3): boolean {
    const rate = this.getAcceptanceRate(category);
    const count = this.store.entries.filter((e) => e.category === category).length;

    // Need at least 5 data points to make a decision
    if (count < 5) return false;

    return rate < threshold;
  }

  /**
   * Export all feedback data for external analysis.
   */
  exportData(): { entries: FeedbackEntry[]; stats: FeedbackStats } {
    return {
      entries: [...this.store.entries],
      stats: { ...this.store.stats },
    };
  }

  /**
   * Reset all feedback data.
   */
  reset(): void {
    this.store = {
      entries: [],
      stats: this.createEmptyStats(),
    };
    logger.info('Feedback data reset');
  }

  /**
   * Print a summary report of feedback statistics.
   */
  printReport(): void {
    const stats = this.getStats();
    logger.info('=== Feedback Learning Report ===');
    logger.info(`Total entries: ${stats.totalEntries}`);
    logger.info(`Acceptance rate: ${(stats.acceptanceRate * 100).toFixed(1)}%`);
    logger.info(`False positive rate: ${(stats.falsePositiveRate * 100).toFixed(1)}%`);
    logger.info('');
    logger.info('By category:');
    for (const [cat, rate] of Object.entries(stats.byCategory)) {
      logger.info(`  ${cat}: ${(rate * 100).toFixed(1)}%`);
    }
    logger.info('');
    logger.info('By model:');
    for (const [model, rate] of Object.entries(stats.byModel)) {
      logger.info(`  ${model}: ${(rate * 100).toFixed(1)}%`);
    }
    if (stats.commonRejections.length > 0) {
      logger.info('');
      logger.info('Common rejection reasons:');
      for (const reason of stats.commonRejections) {
        logger.info(`  ${reason.count}x: ${reason.reason}`);
      }
    }
    logger.info('================================');
  }
}

/** Singleton instance */
let _learner: FeedbackLearner | null = null;

export function getFeedbackLearner(): FeedbackLearner {
  if (!_learner) {
    _learner = new FeedbackLearner();
  }
  return _learner;
}

export { FeedbackLearner };
export default FeedbackLearner;
