import { logger } from './logger.js';

/**
 * Simple in-memory metrics tracker for the AI PR Review tool.
 * Tracks review counts, timing, model usage, and accuracy metrics.
 */

interface MetricRecord {
  tag: string;
  value: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface ReviewMetrics {
  totalProcessed: number;
  totalSucceeded: number;
  totalFailed: number;
  averageDurationMs: number;
  byModel: Record<string, { count: number; avgDuration: number }>;
  byAction: Record<string, number>;
  tokensUsed: { input: number; output: number; total: number };
  suggestionsGenerated: number;
  issuesDetected: number;
  criticalIssues: number;
  cacheHits: number;
  feedbackEntries: number;
  feedbackAcceptanceRate: number;
  lastProcessed?: string;
}

class MetricsCollector {
  private records: MetricRecord[] = [];
  private reviewStats: ReviewMetrics;

  constructor() {
    this.reviewStats = this.createEmptyStats();
  }

  private createEmptyStats(): ReviewMetrics {
    return {
      totalProcessed: 0,
      totalSucceeded: 0,
      totalFailed: 0,
      averageDurationMs: 0,
      byModel: {},
      byAction: {},
      tokensUsed: { input: 0, output: 0, total: 0 },
      suggestionsGenerated: 0,
      issuesDetected: 0,
      criticalIssues: 0,
      cacheHits: 0,
      feedbackEntries: 0,
      feedbackAcceptanceRate: 0,
    };
  }

  recordEvent(tag: string, value: number, metadata?: Record<string, unknown>): void {
    this.records.push({
      tag,
      value,
      timestamp: Date.now(),
      metadata,
    });
  }

  recordReviewCompletion(
    data: {
      success: boolean;
      durationMs: number;
      model: string;
      action: string;
      tokensInput?: number;
      tokensOutput?: number;
      suggestions?: number;
      issues?: number;
      critical?: number;
      cached?: boolean;
    },
  ): void {
    this.reviewStats.totalProcessed++;

    if (data.success) {
      this.reviewStats.totalSucceeded++;
    } else {
      this.reviewStats.totalFailed++;
    }

    // Update average duration
    const prevCount = this.reviewStats.totalProcessed - 1;
    const prevAvg = this.reviewStats.averageDurationMs;
    this.reviewStats.averageDurationMs =
      (prevAvg * prevCount + data.durationMs) / this.reviewStats.totalProcessed;

    // Update model stats
    if (!this.reviewStats.byModel[data.model]) {
      this.reviewStats.byModel[data.model] = { count: 0, avgDuration: 0 };
    }
    const modelStats = this.reviewStats.byModel[data.model];
    modelStats.avgDuration =
      (modelStats.avgDuration * modelStats.count + data.durationMs) / (modelStats.count + 1);
    modelStats.count++;

    // Update action stats
    this.reviewStats.byAction[data.action] =
      (this.reviewStats.byAction[data.action] || 0) + 1;

    // Update token usage
    if (data.tokensInput) this.reviewStats.tokensUsed.input += data.tokensInput;
    if (data.tokensOutput) this.reviewStats.tokensUsed.output += data.tokensOutput;
    this.reviewStats.tokensUsed.total =
      this.reviewStats.tokensUsed.input + this.reviewStats.tokensUsed.output;

    // Update suggestions and issues
    if (data.suggestions) this.reviewStats.suggestionsGenerated += data.suggestions;
    if (data.issues) this.reviewStats.issuesDetected += data.issues;
    if (data.critical) this.reviewStats.criticalIssues += data.critical;

    if (data.cached) this.reviewStats.cacheHits++;

    this.reviewStats.lastProcessed = new Date().toISOString();

    this.recordEvent('review_completion', 1, {
      success: data.success,
      durationMs: data.durationMs,
      model: data.model,
    });
  }

  recordFeedback(accepted: boolean, category: string, model: string): void {
    this.reviewStats.feedbackEntries++;
    const total = this.reviewStats.feedbackEntries;
    const acceptCount = this.reviewStats.feedbackAcceptanceRate * (total - 1) + (accepted ? 1 : 0);
    this.reviewStats.feedbackAcceptanceRate = acceptCount / total;

    this.recordEvent('feedback', accepted ? 1 : 0, { category, model });
  }

  getStats(): ReviewMetrics {
    return { ...this.reviewStats };
  }

  printReport(): void {
    const stats = this.getStats();
    logger.info('='.repeat(50));
    logger.info('AI PR Review - Metrics Report');
    logger.info('='.repeat(50));
    logger.info(`Total PRs processed: ${stats.totalProcessed}`);
    logger.info(`Succeeded: ${stats.totalSucceeded} | Failed: ${stats.totalFailed}`);
    logger.info(`Average duration: ${Math.round(stats.averageDurationMs / 1000)}s`);
    logger.info(`Total tokens used: ${stats.tokensUsed.total.toLocaleString()}`);
    logger.info(`Issues detected: ${stats.issuesDetected} (${stats.criticalIssues} critical)`);
    logger.info(`Suggestions generated: ${stats.suggestionsGenerated}`);
    logger.info(`Cache hit rate: ${stats.cacheHits}/${stats.totalProcessed}`);
    logger.info(`Feedback acceptance rate: ${(stats.feedbackAcceptanceRate * 100).toFixed(1)}%`);
    logger.info('');
    logger.info('By model:');
    for (const [model, data] of Object.entries(stats.byModel)) {
      logger.info(`  ${model}: ${data.count} reviews, avg ${Math.round(data.avgDuration / 1000)}s`);
    }
    logger.info('By action:');
    for (const [action, count] of Object.entries(stats.byAction)) {
      logger.info(`  ${action}: ${count}`);
    }
    logger.info('='.repeat(50));
  }

  reset(): void {
    this.records = [];
    this.reviewStats = this.createEmptyStats();
  }

  getRecords(tag?: string): MetricRecord[] {
    if (tag) {
      return this.records.filter((r) => r.tag === tag);
    }
    return [...this.records];
  }
}

/** Singleton metrics collector instance */
export const metrics = new MetricsCollector();

export default metrics;
