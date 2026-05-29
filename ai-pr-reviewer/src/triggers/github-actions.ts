#!/usr/bin/env node

/**
 * GitHub Actions Trigger
 *
 * Entry point for GitHub Actions workflows.
 * Reads PR context from GITHUB_* environment variables
 * and triggers the review pipeline.
 *
 * Used in .github/workflows/ai-review.yml
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { reviewPR } from '../index.js';
import { logger } from '../utility/logger.js';
import { metrics } from '../utility/metrics.js';

interface GitHubActionsContext {
  repository: string;
  prNumber: number;
  eventName: string;
  eventAction: string;
  sha: string;
  ref: string;
  baseRef: string;
  workspace: string;
  actor: string;
  runId: string;
}

/**
 * Extract PR context from GitHub Actions environment variables.
 */
function getGitHubActionsContext(): GitHubActionsContext | null {
  const requiredVars = {
    repository: process.env.GITHUB_REPOSITORY,
    eventName: process.env.GITHUB_EVENT_NAME,
    workspace: process.env.GITHUB_WORKSPACE,
  };

  // Check required variables
  for (const [name, value] of Object.entries(requiredVars)) {
    if (!value) {
      logger.error(`Missing required environment variable: GITHUB_${name.toUpperCase()}`);
      return null;
    }
  }

  // Extract PR number from event payload
  const eventPath = process.env.GITHUB_EVENT_PATH;
  let prNumber = 0;

  if (eventPath) {
    try {
      const fs = await import('fs');
      const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));

      // PR number can be in different places depending on event
      prNumber = eventData.pull_request?.number ||
                 eventData.issue?.number ||
                 eventData.number ||
                 0;
    } catch (error) {
      logger.warn({ error: String(error) }, 'Failed to read event payload, trying PR_NUMBER env');
    }
  }

  // Fallback to PR_NUMBER env var (if set manually in workflow)
  if (!prNumber) {
    const prNumberEnv = process.env.PR_NUMBER;
    if (prNumberEnv) {
      prNumber = parseInt(prNumberEnv, 10);
    }
  }

  if (!prNumber || isNaN(prNumber)) {
    logger.error('Could not determine PR number from event payload or PR_NUMBER env var');
    return null;
  }

  return {
    repository: requiredVars.repository!,
    prNumber,
    eventName: requiredVars.eventName!,
    eventAction: process.env.GITHUB_EVENT_ACTION || '',
    sha: process.env.GITHUB_SHA || '',
    ref: process.env.GITHUB_REF || '',
    baseRef: process.env.GITHUB_BASE_REF || '',
    workspace: requiredVars.workspace!,
    actor: process.env.GITHUB_ACTOR || 'unknown',
    runId: process.env.GITHUB_RUN_ID || '0',
  };
}

/**
 * Main function for GitHub Actions execution.
 */
async function main(): Promise<void> {
  logger.info('Starting AI PR Review in GitHub Actions mode');

  const context = getGitHubActionsContext();

  if (!context) {
    logger.error('Failed to extract GitHub Actions context. Make sure the workflow is triggered by a PR event.');
    process.exit(1);
  }

  logger.info(
    {
      repository: context.repository,
      prNumber: context.prNumber,
      event: context.eventName,
      action: context.eventAction,
      actor: context.actor,
      runId: context.runId,
    },
    'GitHub Actions context',
  );

  // Check if this is a pull_request event
  if (context.eventName !== 'pull_request' && context.eventName !== 'pull_request_target') {
    logger.warn(
      { eventName: context.eventName },
      'Event is not a pull_request event. The review may not have full PR context.',
    );
  }

  try {
    const result = await reviewPR(context.repository, context.prNumber, {
      useCache: true,
      forceReanalysis: context.eventAction === 'synchronize',
    });

    if (result.success) {
      logger.info('AI PR review completed successfully');

      // Set GitHub Actions outputs for downstream steps
      const review = result.result!;
      setGitHubOutput('review_status', 'success');
      setGitHubOutput('risk_score', String(review.riskReport?.overallScore || 0));
      setGitHubOutput('critical_issues', String(review.riskReport?.bySeverity.critical || 0));
      setGitHubOutput('high_issues', String(review.riskReport?.bySeverity.high || 0));
      setGitHubOutput('total_issues', String(review.riskReport?.issues.length || 0));
      setGitHubOutput('suggestions', String(review.suggestions.length));
      setGitHubOutput('model', review.metadata.model);
      setGitHubOutput('duration_ms', String(review.metadata.durationMs));

      // Print a summary to the GitHub Actions step
      printGitHubSummary(review);

      process.exit(0);
    } else {
      logger.error({ error: result.error }, 'AI PR review failed');

      setGitHubOutput('review_status', 'failed');
      setGitHubOutput('error', result.error || 'Unknown error');

      process.exit(1);
    }
  } catch (error) {
    logger.error({ error: String(error) }, 'Unexpected error during GitHub Actions execution');

    setGitHubOutput('review_status', 'error');
    setGitHubOutput('error', String(error));

    process.exit(1);
  } finally {
    // Print metrics report
    metrics.printReport();
  }
}

/**
 * Set a GitHub Actions step output.
 * Uses the GITHUB_OUTPUT file if available.
 */
function setGitHubOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    try {
      const fs = require('fs');
      fs.appendFileSync(outputFile, `${name}=${value}\n`);
    } catch {
      // Fallback to echo (deprecated but still works)
      console.log(`::set-output name=${name}::${value}`);
    }
  } else {
    // Running outside GitHub Actions, just log
    logger.info({ output: { [name]: value } });
  }
}

/**
 * Print a formatted summary to the GitHub Actions step.
 */
function printGitHubSummary(review: any): void {
  const summary: string[] = [];

  summary.push('');
  summary.push('=== AI PR Review Summary ===');
  summary.push('');

  if (review.summary) {
    summary.push(`Title: ${review.summary.title}`);
    summary.push(`Type: ${review.summary.changeType}`);
    summary.push(`Impact: ${review.summary.impact.level}`);
    summary.push('');
  }

  if (review.riskReport) {
    summary.push(`Risk Score: ${review.riskReport.overallScore}/100`);

    const sev = review.riskReport.bySeverity;
    summary.push(`Issues: ${sev.critical || 0} critical, ${sev.high || 0} high, ${sev.medium || 0} medium, ${sev.low || 0} low`);
    summary.push('');
  }

  summary.push(`Suggestions: ${review.suggestions.length}`);
  summary.push(`Model: ${review.metadata.model}`);
  summary.push(`Duration: ${review.metadata.durationMs}ms`);
  summary.push(`Tokens: ${review.metadata.tokensUsed}`);
  summary.push('');

  console.log(summary.join('\n'));

  // Also write to GITHUB_STEP_SUMMARY if available
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      const fs = require('fs');
      const markdownSummary = formatGitHubMarkdownSummary(review);
      fs.appendFileSync(summaryFile, markdownSummary);
    } catch {
      // Silently fail
    }
  }
}

/**
 * Format a GitHub-flavored Markdown summary for the workflow run page.
 */
function formatGitHubMarkdownSummary(review: any): string {
  const lines: string[] = [];

  lines.push('# AI PR Review Results');
  lines.push('');

  if (review.summary) {
    lines.push('## Summary');
    lines.push(`**${review.summary.title}**`);
    lines.push('');
    lines.push(review.summary.description);
    lines.push('');
  }

  if (review.riskReport) {
    lines.push('## Risk Analysis');
    lines.push('');
    lines.push('| Severity | Count |');
    lines.push('|----------|-------|');

    const sev = review.riskReport.bySeverity;
    if (sev.critical) lines.push(`| :red_circle: Critical | ${sev.critical} |`);
    if (sev.high) lines.push(`| :orange_circle: High | ${sev.high} |`);
    if (sev.medium) lines.push(`| :yellow_circle: Medium | ${sev.medium} |`);
    if (sev.low) lines.push(`| :white_circle: Low | ${sev.low} |`);
    lines.push('');
    lines.push(`**Overall Risk Score:** ${review.riskReport.overallScore}/100`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Review by \`${review.metadata.model}\` in ${review.metadata.durationMs}ms*`);
  lines.push('');

  return lines.join('\n');
}

// Execute
main();
