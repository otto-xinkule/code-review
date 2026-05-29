import type {
  PRMetadata,
  ParsedDiff,
  PRSummary,
  RiskReport,
  ReviewSuggestion,
  ReviewResult,
  AnalysisConfig,
  AnalysisChunk,
  RiskCategory,
  Severity,
  Confidence,
  AggregatedContext,
} from '../types/index.js';
import { logger } from '../utility/logger.js';
import { metrics } from '../utility/metrics.js';
import { getConfig } from '../config/index.js';
import { getRouter } from '../models/router.js';
import { chunkDiff, shouldChunk } from '../strategies/token-budget.js';
import { buildContext } from '../collectors/context-aggregator.js';

import {
  SUMMARY_SYSTEM_PROMPT,
  renderSummaryPrompt,
} from './prompts/summary.js';
import {
  RISK_SYSTEM_PROMPT,
  renderRiskPrompt,
} from './prompts/risk.js';
import {
  SUGGESTION_SYSTEM_PROMPT,
  renderSuggestionPrompt,
} from './prompts/suggestion.js';

/**
 * Analysis Engine
 *
 * Orchestrates the end-to-end AI code review process:
 * 1. PR change summary generation
 * 2. Risk detection
 * 3. Review suggestion generation
 *
 * Supports chunking for large PRs and aggregates results.
 */

export interface AnalysisResult {
  success: boolean;
  result?: ReviewResult;
  error?: string;
}

/**
 * Run the complete PR analysis pipeline.
 */
export async function analyzePR(
  parsedDiff: ParsedDiff,
  prMetadata: PRMetadata,
  config?: Partial<AnalysisConfig>,
): Promise<AnalysisResult> {
  const startTime = Date.now();
  const appConfig = getConfig();

  const effectiveConfig: AnalysisConfig = {
    generateSummary: config?.generateSummary ?? appConfig.review.enabledFeatures.summary,
    detectRisks: config?.detectRisks ?? appConfig.review.enabledFeatures.riskDetection,
    generateSuggestions: config?.generateSuggestions ?? appConfig.review.enabledFeatures.suggestions,
    riskCategories: config?.riskCategories ?? getEnabledRiskCategories(),
    minSeverity: config?.minSeverity ?? appConfig.review.riskFilters.minSeverity,
    minConfidence: config?.minConfidence ?? 'low',
    maxInlineCommentsPerFile: config?.maxInlineCommentsPerFile ?? appConfig.review.maxInlineCommentsPerFile,
    useFeedbackLearning: config?.useFeedbackLearning ?? appConfig.review.enabledFeatures.feedbackLearning,
  };

  logger.info(
    {
      prNumber: prMetadata.prNumber,
      files: parsedDiff.stats.filesChanged,
      config: {
        summary: effectiveConfig.generateSummary,
        risks: effectiveConfig.detectRisks,
        suggestions: effectiveConfig.generateSuggestions,
      },
    },
    'Starting PR analysis',
  );

  try {
    // Check if chunking is needed
    const needsChunking = shouldChunk(parsedDiff);

    if (needsChunking) {
      logger.info('Large PR detected, using chunked analysis');
      return await analyzeWithChunks(parsedDiff, prMetadata, effectiveConfig, startTime);
    }

    return await analyzeSinglePass(parsedDiff, prMetadata, effectiveConfig, startTime);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error({ error: String(error), durationMs }, 'PR analysis failed');
    metrics.recordReviewCompletion({
      success: false,
      durationMs,
      model: 'unknown',
      action: prMetadata.isUpdate ? 'synchronize' : 'opened',
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Single-pass analysis for small/medium PRs.
 */
async function analyzeSinglePass(
  parsedDiff: ParsedDiff,
  prMetadata: PRMetadata,
  config: AnalysisConfig,
  startTime: number,
): Promise<AnalysisResult> {
  // Build context
  const context = await buildContext(
    parsedDiff,
    prMetadata,
    undefined,
    undefined,
    undefined,
  );

  const router = getRouter();
  const modelProvider = router.selectByPR(parsedDiff, prMetadata);
  const modelName = modelProvider?.getModelName() || 'unknown';

  // Run analyses in parallel if all are enabled
  const [summary, riskReport, suggestions] = await Promise.all([
    config.generateSummary
      ? generateSummary(context, prMetadata)
      : Promise.resolve(null),
    config.detectRisks
      ? detectRisks(context, parsedDiff, config)
      : Promise.resolve(null),
    config.generateSuggestions
      ? generateSuggestions(context, null, config)
      : Promise.resolve([]),
  ]);

  // Filter and post-process results
  const filteredSuggestions = filterSuggestions(
    suggestions,
    config,
    parsedDiff.stats.filesChanged,
  );

  const durationMs = Date.now() - startTime;
  const tokensUsed = calculateTotalTokens(context, summary, riskReport, filteredSuggestions);

  const result: ReviewResult = {
    pr: prMetadata,
    summary,
    riskReport,
    suggestions: filteredSuggestions,
    metadata: {
      model: modelName,
      contextLevel: context.level,
      tokensUsed,
      durationMs,
      timestamp: new Date().toISOString(),
      wasModelDowngraded: false,
      wasCached: false,
    },
  };

  metrics.recordReviewCompletion({
    success: true,
    durationMs,
    model: modelName,
    action: prMetadata.isUpdate ? 'synchronize' : 'opened',
    tokensInput: tokensUsed,
    suggestions: filteredSuggestions.length,
    issues: riskReport?.issues.length || 0,
    critical: riskReport?.bySeverity.critical || 0,
  });

  logger.info(
    {
      durationMs,
      tokensUsed,
      issues: riskReport?.issues.length || 0,
      suggestions: filteredSuggestions.length,
    },
    'PR analysis complete',
  );

  return { success: true, result };
}

/**
 * Chunked analysis for large PRs.
 */
async function analyzeWithChunks(
  parsedDiff: ParsedDiff,
  prMetadata: PRMetadata,
  config: AnalysisConfig,
  startTime: number,
): Promise<AnalysisResult> {
  const chunks = chunkDiff(parsedDiff);
  const router = getRouter();
  const modelProvider = router.selectByPR(parsedDiff, prMetadata);
  const modelName = modelProvider?.getModelName() || 'unknown';

  logger.info({ chunks: chunks.length }, 'Processing chunks');

  let allSummary: PRSummary | null = null;
  let allRisks: RiskReport | null = null;
  let allSuggestions: ReviewSuggestion[] = [];

  for (const chunk of chunks) {
    // Build context for this chunk
    const context = await buildContext(
      { raw: parsedDiff.raw, files: chunk.files.map((f) => f.diff), stats: parsedDiff.stats },
      prMetadata,
      undefined,
      undefined,
      undefined,
    );

    // First chunk gets full summary
    const isFirstChunk = chunk.index === 0;

    const [summary, riskReport, suggestions] = await Promise.all([
      isFirstChunk && config.generateSummary
        ? generateSummary(context, prMetadata)
        : Promise.resolve(null),
      config.detectRisks
        ? detectRisks(context, parsedDiff, config)
        : Promise.resolve(null),
      config.generateSuggestions
        ? generateSuggestions(context, allRisks, config)
        : Promise.resolve([]),
    ]);

    if (summary) allSummary = summary;

    if (riskReport) {
      if (!allRisks) {
        allRisks = riskReport;
      } else {
        // Merge risk reports
        allRisks.issues = [...allRisks.issues, ...riskReport.issues];
        allRisks.overallScore = Math.max(allRisks.overallScore, riskReport.overallScore);
        allRisks.highRiskFiles = [...new Set([...allRisks.highRiskFiles, ...riskReport.highRiskFiles])];
        for (const cat of Object.keys(riskReport.byCategory) as RiskCategory[]) {
          allRisks.byCategory[cat] = (allRisks.byCategory[cat] || 0) + (riskReport.byCategory[cat] || 0);
        }
        for (const sev of Object.keys(riskReport.bySeverity) as Severity[]) {
          allRisks.bySeverity[sev] = (allRisks.bySeverity[sev] || 0) + (riskReport.bySeverity[sev] || 0);
        }
      }
    }

    allSuggestions = [...allSuggestions, ...suggestions];
  }

  // Filter and deduplicate
  const filteredSuggestions = filterSuggestions(
    deduplicateReviewSuggestions(allSuggestions),
    config,
    parsedDiff.stats.filesChanged,
  );

  // Filter risk issues
  if (allRisks) {
    allRisks.issues = deduplicateRiskIssues(allRisks.issues);
  }

  const durationMs = Date.now() - startTime;
  const tokensUsed = chunks.reduce((sum, c) => sum + c.tokenCount, 0);

  const result: ReviewResult = {
    pr: prMetadata,
    summary: allSummary,
    riskReport: allRisks,
    suggestions: filteredSuggestions,
    metadata: {
      model: modelName,
      contextLevel: 'L4', // Chunking implies complex PR
      tokensUsed,
      durationMs,
      timestamp: new Date().toISOString(),
      wasModelDowngraded: false,
      wasCached: false,
    },
  };

  metrics.recordReviewCompletion({
    success: true,
    durationMs,
    model: modelName,
    action: prMetadata.isUpdate ? 'synchronize' : 'opened',
    tokensInput: tokensUsed,
    suggestions: filteredSuggestions.length,
    issues: allRisks?.issues.length || 0,
    critical: allRisks?.bySeverity.critical || 0,
  });

  return { success: true, result };
}

/**
 * Generate PR change summary.
 */
async function generateSummary(
  context: AggregatedContext,
  prMetadata: PRMetadata,
): Promise<PRSummary | null> {
  const router = getRouter();
  const modelProvider = router.selectByPR(
    { raw: '', files: [], stats: { filesChanged: 0, additions: 0, deletions: 0, byStatus: {}, byLanguage: {} } } as ParsedDiff,
    prMetadata,
  );

  try {
    const userPrompt = renderSummaryPrompt({
      PR_TITLE: prMetadata.title,
      PR_BODY: prMetadata.body || 'No description provided',
      PR_AUTHOR: prMetadata.author,
      FILE_COUNT: prMetadata.changedFiles,
      ADDITIONS: prMetadata.additions,
      DELETIONS: prMetadata.deletions,
      CONTEXT: context.content,
    });

    const response = await router.sendWithFallback({
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      userPrompt,
      responseFormat: 'json_object',
      temperature: 0.1,
    });

    const summary = response.json as PRSummary | null;

    if (!summary) {
      logger.warn('Failed to parse summary response');
      return null;
    }

    return summary;
  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to generate summary');
    return null;
  }
}

/**
 * Detect risks in code changes.
 */
async function detectRisks(
  context: AggregatedContext,
  parsedDiff: ParsedDiff,
  config: AnalysisConfig,
): Promise<RiskReport | null> {
  const router = getRouter();

  const enabledCategories = config.riskCategories.filter((cat) => {
    const filters = getConfig().review.riskFilters;
    const map: Record<RiskCategory, boolean> = {
      security: filters.security,
      performance: filters.performance,
      bug: filters.bugs,
      logic: filters.logic,
      maintainability: filters.maintainability,
    };
    return map[cat] !== false;
  });

  if (enabledCategories.length === 0) {
    logger.info('No risk categories enabled, skipping risk detection');
    return null;
  }

  try {
    const userPrompt = renderRiskPrompt({
      CONTEXT: context.content,
      RISK_CATEGORIES: enabledCategories.join(', '),
      MIN_SEVERITY: config.minSeverity,
    });

    const response = await router.sendWithFallback({
      systemPrompt: RISK_SYSTEM_PROMPT,
      userPrompt,
      responseFormat: 'json_object',
      temperature: 0.1,
    });

    const riskReport = response.json as RiskReport | null;

    if (!riskReport) {
      logger.warn('Failed to parse risk report response');
      return null;
    }

    // Filter by confidence and severity
    riskReport.issues = riskReport.issues.filter((issue) => {
      const severityOk = severityMeetsThreshold(issue.severity, config.minSeverity);
      const confidenceOk = confidenceMeetsThreshold(issue.confidence, config.minConfidence);
      return severityOk && confidenceOk;
    });

    // Recalculate stats
    recalculateRiskStats(riskReport);

    return riskReport;
  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to detect risks');
    return null;
  }
}

/**
 * Generate review suggestions.
 */
async function generateSuggestions(
  context: AggregatedContext,
  existingRiskReport: RiskReport | null,
  config: AnalysisConfig,
): Promise<ReviewSuggestion[]> {
  const router = getRouter();

  try {
    const existingIssuesSummary = existingRiskReport
      ? existingRiskReport.issues
          .map((i) => `- ${i.title} (${i.severity}, ${i.file}:${i.lineRange.start})`)
          .join('\n')
      : 'No existing issues found';

    const userPrompt = renderSuggestionPrompt({
      CONTEXT: context.content,
      EXISTING_ISSUES: existingIssuesSummary,
    });

    const response = await router.sendWithFallback({
      systemPrompt: SUGGESTION_SYSTEM_PROMPT,
      userPrompt,
      responseFormat: 'json_object',
      temperature: 0.3,
    });

    const data = response.json as { suggestions?: ReviewSuggestion[] } | null;

    if (!data?.suggestions) {
      logger.warn('Failed to parse suggestions response');
      return [];
    }

    return data.suggestions;
  } catch (error) {
    logger.error({ error: String(error) }, 'Failed to generate suggestions');
    return [];
  }
}

/**
 * Filter suggestions by type and file limits.
 */
function filterSuggestions(
  suggestions: ReviewSuggestion[],
  config: AnalysisConfig,
  totalFiles: number,
): ReviewSuggestion[] {
  // Group by file
  const byFile = new Map<string, ReviewSuggestion[]>();
  for (const s of suggestions) {
    const existing = byFile.get(s.file) || [];
    existing.push(s);
    byFile.set(s.file, existing);
  }

  // Apply file-level limits
  const filtered: ReviewSuggestion[] = [];
  for (const [, fileSuggestions] of byFile) {
    // Sort: must_fix first, then recommended, then optional
    const sorted = fileSuggestions.sort((a, b) => {
      const order = { must_fix: 0, recommended: 1, optional: 2 };
      return (order[a.type] || 2) - (order[b.type] || 2);
    });

    filtered.push(...sorted.slice(0, config.maxInlineCommentsPerFile));
  }

  return filtered;
}

/**
 * Deduplicate risk issues by semantic similarity.
 */
function deduplicateRiskIssues(issues: typeof originalIssues): typeof originalIssues {
  const originalIssues = issues;
  const deduped: typeof originalIssues = [];
  const seen = new Set<string>();

  for (const issue of originalIssues) {
    // Create a key from category + file + approximate location
    const key = `${issue.category}:${issue.file}:${Math.floor(issue.lineRange.start / 10)}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(issue);
    }
  }

  return deduped;
}

/**
 * Deduplicate review suggestions.
 */
function deduplicateReviewSuggestions(
  suggestions: ReviewSuggestion[],
): ReviewSuggestion[] {
  const deduped: ReviewSuggestion[] = [];
  const seen = new Set<string>();

  for (const s of suggestions) {
    const key = `${s.category}:${s.file}:${s.lineRange.start}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(s);
    }
  }

  return deduped;
}

/**
 * Check if severity meets the minimum threshold.
 */
function severityMeetsThreshold(severity: Severity, minSeverity: Severity): boolean {
  const order: Record<Severity, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  return order[severity] >= order[minSeverity];
}

/**
 * Check if confidence meets the minimum threshold.
 */
function confidenceMeetsThreshold(confidence: Confidence, minConfidence: Confidence): boolean {
  const order: Record<Confidence, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };
  return order[confidence] >= order[minConfidence];
}

/**
 * Recalculate risk report statistics after filtering.
 */
function recalculateRiskStats(report: RiskReport): void {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const highRiskFiles = new Set<string>();

  for (const issue of report.issues) {
    byCategory[issue.category] = (byCategory[issue.category] || 0) + 1;
    bySeverity[issue.severity] = (bySeverity[issue.severity] || 0) + 1;
    if (issue.severity === 'critical' || issue.severity === 'high') {
      highRiskFiles.add(issue.file);
    }
  }

  report.byCategory = byCategory as RiskReport['byCategory'];
  report.bySeverity = bySeverity as RiskReport['bySeverity'];
  report.highRiskFiles = Array.from(highRiskFiles);
}

/**
 * Get enabled risk categories from config.
 */
function getEnabledRiskCategories(): RiskCategory[] {
  const config = getConfig();
  const categories: RiskCategory[] = [];
  if (config.review.riskFilters.security) categories.push('security');
  if (config.review.riskFilters.performance) categories.push('performance');
  if (config.review.riskFilters.bugs) categories.push('bug');
  if (config.review.riskFilters.logic) categories.push('logic');
  if (config.review.riskFilters.maintainability) categories.push('maintainability');
  return categories;
}

/**
 * Calculate total tokens used for analysis.
 */
function calculateTotalTokens(
  context: AggregatedContext,
  summary: PRSummary | null,
  riskReport: RiskReport | null,
  suggestions: ReviewSuggestion[],
): number {
  let total = context.tokenCount;
  // Rough estimates for output tokens
  total += summary ? 500 : 0;
  total += riskReport ? riskReport.issues.length * 200 : 0;
  total += suggestions.length * 150;
  return total;
}

export default { analyzePR };
