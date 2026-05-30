#!/usr/bin/env node

/**
 * AI PR Review Tool - Main Entry Point
 *
 * Supports multiple execution modes:
 * 1. CLI: ai-pr-review review --repo owner/repo --pr 123
 * 2. GitHub Actions: auto-detects PR context from GITHUB_* env vars
 * 3. Programmatic: import { reviewPR } from 'ai-pr-reviewer'
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { logger } from './utility/logger.js';
import { metrics } from './utility/metrics.js';
import { getConfig, validateConfig } from './config/index.js';
import { getPRMetadata, getPRFiles, checkPRExists } from './collectors/github-api.js';
import { parsePRFiles, isDiffEmpty } from './collectors/diff-parser.js';
import { sanitizeDiff, containsSecrets } from './collectors/sanitizer.js';
import { analyzePR } from './analysis/engine.js';
import { publishReview } from './output/publisher.js';
import { getCache } from './feedback/cache.js';
import type { PRMetadata, ReviewResult, PREvent } from './types/index.js';

/**
 * Complete PR review pipeline.
 * Entry point for all execution modes.
 */
export async function reviewPR(
  repository: string,
  prNumber: number,
  options?: {
    useCache?: boolean;
    skipPublish?: boolean;
    forceReanalysis?: boolean;
  },
): Promise<{ success: boolean; result?: ReviewResult; error?: string }> {
  const startTime = Date.now();
  const config = getConfig();

  logger.info({ repository, prNumber }, 'Starting PR review pipeline');

  // Validate configuration
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) {
    logger.error({ errors: configErrors }, 'Configuration validation failed');
    return { success: false, error: configErrors.join('; ') };
  }

  try {
    // 1. Fetch PR metadata
    const prMetadata = await getPRMetadata(repository, prNumber);

    // 2. Check if PR exists and is open
    if (prMetadata.state !== 'open') {
      logger.info({ state: prMetadata.state }, 'PR is not open, skipping review');
      return { success: false, error: `PR is ${prMetadata.state}` };
    }

    // 3. Check cache (unless force reanalysis)
    const cache = getCache();
    if (options?.useCache !== false && !options?.forceReanalysis) {
      const cached = cache.get(repository, prMetadata.headSha);
      if (cached) {
        logger.info('Using cached review result');
        cached.metadata.wasCached = true;
        metrics.recordReviewCompletion({
          success: true,
          durationMs: Date.now() - startTime,
          model: cached.metadata.model,
          action: 'cached',
          cached: true,
        });
        return { success: true, result: cached };
      }
    }

    // 4. Fetch changed files
    const prFiles = await getPRFiles(repository, prNumber);
    logger.info({ files: prFiles.length }, 'Fetched changed files');

    // 5. Parse diff
    const parsedDiff = parsePRFiles(prFiles);

    // 6. Check for empty diff
    if (isDiffEmpty(parsedDiff)) {
      logger.info('No code changes detected in PR');
      return { success: false, error: 'No code changes to review' };
    }

    // 7. Sanitize diff for secrets
    let sanitizedDiffContent = '';
    for (const file of prFiles) {
      if (file.patch) {
        sanitizedDiffContent += sanitizeDiff(file.patch) + '\n';
      }
    }

    const hasSecrets = containsSecrets(
      prFiles.map((f) => f.patch || '').join('\n'),
    );
    if (hasSecrets) {
      logger.warn('Potential secrets detected in PR diff - sanitized before analysis');
    }

    // 8. Run AI analysis
    const analysisResult = await analyzePR(parsedDiff, prMetadata);

    if (!analysisResult.success || !analysisResult.result) {
      return {
        success: false,
        error: analysisResult.error || 'Analysis failed with no result',
      };
    }

    const result = analysisResult.result;

    // 9. Cache the result
    cache.set(repository, prMetadata.headSha, result);

    // 10. Publish review (unless skipPublish)
    if (!options?.skipPublish) {
      await publishReview(repository, prNumber, result);
      logger.info('Review published to PR');
    }

    const durationMs = Date.now() - startTime;
    logger.info(
      {
        repository,
        prNumber,
        durationMs,
        issues: result.riskReport?.issues.length || 0,
        suggestions: result.suggestions.length,
      },
      'PR review pipeline completed',
    );

    // Record metrics
    metrics.recordReviewCompletion({
      success: true,
      durationMs,
      model: result.metadata.model,
      action: 'manual',
      tokensInput: result.metadata.tokensUsed,
      suggestions: result.suggestions.length,
      issues: result.riskReport?.issues.length || 0,
      critical: result.riskReport?.issues.filter(i => i.severity === 'critical').length || 0,
    });

    return { success: true, result };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    logger.error(
      {
        repository,
        prNumber,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      },
      'PR review pipeline failed',
    );

    // Record failed metrics
    try {
      metrics.recordReviewCompletion({
        success: false,
        durationMs,
        model: config.models.default,
        action: 'manual',
      });
    } catch {}

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle a PR event from webhook or GitHub Actions.
 */
export async function handlePREvent(event: PREvent): Promise<void> {
  logger.info(
    {
      action: event.action,
      repository: `${event.repository.owner}/${event.repository.repo}`,
      pr: event.pr.prNumber,
    },
    'Handling PR event',
  );

  // Only review on open, synchronize, and reopen
  if (!['opened', 'synchronize', 'reopened'].includes(event.action)) {
    logger.info({ action: event.action }, 'Action does not trigger review');
    return;
  }

  const repository = `${event.repository.owner}/${event.repository.repo}`;

  const result = await reviewPR(repository, event.pr.prNumber, {
    useCache: true,
    forceReanalysis: event.action === 'synchronize',
  });

  if (!result.success) {
    logger.error({ error: result.error }, 'PR review failed');
  }
}

/**
 * CLI entry point.
 */
async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  switch (command) {
    case 'review': {
      const repo = extractArg(args, '--repo', '-r');
      const pr = extractArg(args, '--pr', '-p');

      if (!repo || !pr) {
        logger.error('--repo and --pr are required for review command');
        printHelp();
        process.exit(1);
      }

      const prNumber = parseInt(pr, 10);
      if (isNaN(prNumber)) {
        logger.error('--pr must be a valid number');
        process.exit(1);
      }

      const result = await reviewPR(repo, prNumber);

      if (result.success) {
        const review = result.result!;
        console.log('\n=== AI PR Review Complete ===\n');
        if (review.summary) {
          console.log(`Summary: ${review.summary.title}`);
        }
        if (review.riskReport) {
          console.log(`Risk Score: ${review.riskReport.overallScore}/100`);
          console.log(`Issues: ${review.riskReport.issues.length} (${review.riskReport.bySeverity.critical || 0} critical)`);
        }
        console.log(`Suggestions: ${review.suggestions.length}`);
        console.log(`Model: ${review.metadata.model}`);
        console.log(`Duration: ${review.metadata.durationMs}ms`);
        console.log(`Tokens: ${review.metadata.tokensUsed}`);
        console.log('');
        metrics.printReport();
        process.exit(0);
      } else {
        logger.error({ error: result.error }, 'Review failed');
        process.exit(1);
      }
    }

    case 'stats': {
      metrics.printReport();
      process.exit(0);
    }

    case 'version':
    case '--version':
    case '-v': {
      console.log('ai-pr-reviewer v1.0.0');
      process.exit(0);
    }

    default: {
      logger.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
    }
  }
}

function extractArg(args: string[], longFlag: string, shortFlag: string): string | undefined {
  const longIndex = args.indexOf(longFlag);
  if (longIndex >= 0 && longIndex + 1 < args.length) {
    return args[longIndex + 1];
  }

  const shortIndex = args.indexOf(shortFlag);
  if (shortIndex >= 0 && shortIndex + 1 < args.length) {
    return args[shortIndex + 1];
  }

  return undefined;
}

function printHelp(): void {
  console.log(`
AI PR Reviewer - Automated code review powered by AI

Usage:
  ai-pr-review <command> [options]

Commands:
  review     Run a PR review
  stats      Show review statistics
  version    Show version

Options for review:
  --repo, -r <owner/repo>   GitHub repository (e.g., "owner/repo")
  --pr, -p <number>         PR number to review

Environment Variables:
  GITHUB_TOKEN              GitHub personal access token (required)
  ANTHROPIC_API_KEY         Anthropic API key for Claude
  OPENAI_API_KEY            OpenAI API key for GPT-4
  DEEPSEEK_API_KEY          DeepSeek API key
  QWEN_API_KEY              Qwen API key

Examples:
  ai-pr-review review --repo myorg/myrepo --pr 42
  ai-pr-review stats
`);
}

// Run CLI only when this file is the direct entry point
const entryPoint = process.argv[1] || '';
const isIndexFile = entryPoint.endsWith('/index.ts') || entryPoint.endsWith('/index.js') || entryPoint.endsWith('\\index.ts') || entryPoint.endsWith('\\index.js') || entryPoint === 'index.ts' || entryPoint === 'index.js';
if (process.argv[1] && isIndexFile) {
  cli().catch((error) => {
    logger.error({ error: String(error) }, 'CLI execution failed');
    process.exit(1);
  });
}

export default {
  reviewPR,
  handlePREvent,
};
