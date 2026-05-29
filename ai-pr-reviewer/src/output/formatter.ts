import type {
  ReviewResult,
  ReviewOutput,
  InlineComment,
  PRSummary,
  RiskReport,
  RiskIssue,
  ReviewSuggestion,
  SuggestionType,
} from '../types/index.js';
import { logger } from '../utility/logger.js';

/**
 * Output Formatter
 *
 * Converts structured review results into:
 * 1. Formatted Markdown PR comments
 * 2. Inline file-level comments
 * 3. Structured review summaries
 */

const AI_REVIEW_MARKER = '<!-- AI-PR-REVIEW -->';

/**
 * Format a complete review result into publishable output.
 */
export function formatReviewOutput(
  result: ReviewResult,
  previousCommentId?: number,
): ReviewOutput {
  const prComment = formatPRComment(result);
  const inlineComments = formatInlineComments(result);
  const reviewSummary = formatReviewSummary(result);
  const reviewEvent = determineReviewEvent(result);

  return {
    prComment,
    inlineComments,
    reviewSummary,
    reviewEvent,
    metadata: {
      model: result.metadata.model,
      contextLevel: result.metadata.contextLevel,
      tokensUsed: result.metadata.tokensUsed,
    },
  };
}

/**
 * Format the main PR comment (summary + overview).
 */
export function formatPRComment(result: ReviewResult): string {
  const parts: string[] = [];

  parts.push(AI_REVIEW_MARKER);
  parts.push('');
  parts.push('# AI Code Review');
  parts.push('');

  if (result.metadata.wasModelDowngraded) {
    parts.push(`> :warning: **Note:** Review was processed using fallback model \`${result.metadata.fallbackModel || result.metadata.model}\` due to primary model unavailability.`);
    parts.push('');
  }

  if (result.metadata.wasCached) {
    parts.push(`> :information_source: **Note:** This review was served from cache. Last updated: ${result.metadata.timestamp}`);
    parts.push('');
  }

  // Summary section
  if (result.summary) {
    parts.push(formatSummarySection(result.summary));
  }

  // Risk overview section
  if (result.riskReport && result.riskReport.issues.length > 0) {
    parts.push(formatRiskOverviewSection(result.riskReport));
  }

  // Key suggestions section
  const mustFixSuggestions = result.suggestions.filter((s) => s.type === 'must_fix');
  if (mustFixSuggestions.length > 0) {
    parts.push(formatMustFixSection(mustFixSuggestions));
  }

  const recommendedSuggestions = result.suggestions.filter((s) => s.type === 'recommended');
  if (recommendedSuggestions.length > 0) {
    parts.push(formatRecommendedSection(recommendedSuggestions));
  }

  // Footer
  parts.push(formatFooter(result));

  return parts.join('\n');
}

/**
 * Format the summary section.
 */
function formatSummarySection(summary: PRSummary): string {
  const parts: string[] = [];

  parts.push('## Summary');
  parts.push('');

  const changeTypeEmoji = {
    feature: 'sparkles',
    bugfix: 'bug',
    refactor: 'recycle',
    performance: 'zap',
    docs: 'book',
    test: 'white_check_mark',
    chore: 'wrench',
    mixed: 'package',
  }[summary.changeType] || 'package';

  parts.push(`:${changeTypeEmoji}: **${summary.title}**`);
  parts.push('');
  parts.push(summary.description);
  parts.push('');

  // Change type badges
  parts.push(`**Change Type:** \`${summary.changeType}\` | **Impact:** \`${summary.impact.level}\``);
  parts.push('');

  // Affected modules
  if (summary.affectedModules.length > 0) {
    parts.push('**Affected Modules:** ' + summary.affectedModules.map((m) => `\`${m}\``).join(', '));
    parts.push('');
  }

  // Key files
  if (summary.keyFiles.length > 0) {
    parts.push('### Key Files to Review');
    parts.push('');
    parts.push('| File | Complexity | Changes | Reason |');
    parts.push('|------|-----------|---------|--------|');
    for (const kf of summary.keyFiles.slice(0, 10)) {
      const complexityBar = formatComplexityBar(kf.complexity);
      parts.push(`| \`${kf.filename}\` | ${complexityBar} | ${kf.changes} | ${kf.reason} |`);
    }
    parts.push('');
  }

  // Dependency changes
  if (summary.dependencyChanges.length > 0) {
    parts.push('### Dependency Changes');
    parts.push('');
    for (const dc of summary.dependencyChanges) {
      const versionInfo = dc.newVersion
        ? `: \`${dc.oldVersion || '—'}\` -> \`${dc.newVersion}\``
        : '';
      parts.push(`- ${formatDependencyType(dc.type)} \`${dc.name}\`${versionInfo}`);
    }
    parts.push('');
  }

  // Impact notes
  const impactFlags: string[] = [];
  if (summary.impact.hasDatabaseChanges) impactFlags.push(':warning: Database changes');
  if (summary.impact.hasAPIChanges) impactFlags.push(':warning: API contract changes');
  if (summary.impact.hasConfigChanges) impactFlags.push(':gear: Configuration changes');
  if (impactFlags.length > 0) {
    parts.push('### Impact Notes');
    for (const flag of impactFlags) {
      parts.push(`- ${flag}`);
    }
    if (summary.impact.migrationNotes) {
      parts.push('');
      parts.push(`**Migration Notes:** ${summary.impact.migrationNotes}`);
    }
    parts.push('');
  }

  // Statistics
  parts.push('### Statistics');
  parts.push(`- Files: \`${summary.statistics.filesChanged}\` | Additions: \`+${summary.statistics.additions}\` | Deletions: \`-${summary.statistics.deletions}\``);
  if (Object.keys(summary.statistics.byLanguage).length > 0) {
    const langStats = Object.entries(summary.statistics.byLanguage)
      .map(([lang, count]) => `${lang}: ${count}`)
      .join(', ');
    parts.push(`- Languages: ${langStats}`);
  }
  parts.push('');

  return parts.join('\n');
}

/**
 * Format the risk overview section.
 */
function formatRiskOverviewSection(report: RiskReport): string {
  const parts: string[] = [];

  parts.push('## Risk Analysis');
  parts.push('');

  // Risk score gauge
  const gauge = formatRiskGauge(report.overallScore);
  parts.push(`**Overall Risk Score:** ${gauge} ${report.overallScore}/100`);
  parts.push('');

  // Summary
  parts.push(report.summary);
  parts.push('');

  // Distribution
  parts.push('### Issue Distribution');
  parts.push('');

  // By severity
  parts.push('**By Severity:**');
  for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
    const count = report.bySeverity[sev] || 0;
    if (count > 0) {
      const emoji = severityEmoji(sev);
      parts.push(`- ${emoji} ${capitalize(sev)}: ${count}`);
    }
  }
  parts.push('');

  // By category
  parts.push('**By Category:**');
  for (const cat of ['security', 'performance', 'bug', 'logic', 'maintainability'] as const) {
    const count = report.byCategory[cat] || 0;
    if (count > 0) {
      parts.push(`- :${categoryEmoji(cat)}: ${capitalize(cat)}: ${count}`);
    }
  }
  parts.push('');

  // High risk files
  if (report.highRiskFiles.length > 0) {
    parts.push('### :red_circle: High Risk Files');
    for (const file of report.highRiskFiles) {
      parts.push(`- \`${file}\``);
    }
    parts.push('');
  }

  // Detailed issues (if not too many)
  if (report.issues.length > 0) {
    parts.push('### All Issues');
    parts.push('');

    const sortedIssues = [...report.issues].sort(
      (a, b) => severityOrder(b.severity) - severityOrder(a.severity),
    );

    for (const issue of sortedIssues.slice(0, 15)) {
      parts.push(formatIssueDetail(issue));
    }

    if (sortedIssues.length > 15) {
      parts.push(`*... and ${sortedIssues.length - 15} more issues (see inline comments for details)*`);
      parts.push('');
    }
  }

  return parts.join('\n');
}

/**
 * Format a single issue for the PR comment.
 */
function formatIssueDetail(issue: RiskIssue): string {
  const lines: string[] = [];
  const emoji = severityEmoji(issue.severity);
  const confBadge = confidenceBadge(issue.confidence);

  lines.push(`<details>`);
  lines.push(`<summary>${emoji} **${issue.title}** — \`${issue.severity}\` ${confBadge}</summary>`);
  lines.push('');
  lines.push(`**File:** \`${issue.file}\` | **Lines:** ${issue.lineRange.start}-${issue.lineRange.end}`);
  lines.push('');
  lines.push(issue.description);
  lines.push('');

  if (issue.codeSnippet) {
    lines.push('```' + detectLanguageFromFile(issue.file));
    lines.push(issue.codeSnippet);
    lines.push('```');
    lines.push('');
  }

  if (issue.suggestion) {
    lines.push(`**Suggestion:** ${issue.suggestion}`);
    lines.push('');
  }

  if (issue.ruleIds && issue.ruleIds.length > 0) {
    lines.push(`**References:** ${issue.ruleIds.join(', ')}`);
    lines.push('');
  }

  lines.push('</details>');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format must-fix suggestions section.
 */
function formatMustFixSection(suggestions: ReviewSuggestion[]): string {
  const parts: string[] = [];

  parts.push('## :exclamation: Must Fix');
  parts.push('');
  parts.push('The following items should be addressed before merging:');
  parts.push('');

  for (const s of suggestions) {
    parts.push(`- **\`${s.file}:${s.lineRange.start}\`** — ${s.title}`);
  }
  parts.push('');

  return parts.join('\n');
}

/**
 * Format recommended suggestions section.
 */
function formatRecommendedSection(suggestions: ReviewSuggestion[]): string {
  const parts: string[] = [];

  parts.push('## :bulb: Recommended Improvements');
  parts.push('');

  for (const s of suggestions.slice(0, 10)) {
    parts.push(formatSuggestionDetail(s));
  }

  if (suggestions.length > 10) {
    parts.push(`*... and ${suggestions.length - 10} more suggestions*`);
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Format a single suggestion detail.
 */
function formatSuggestionDetail(suggestion: ReviewSuggestion): string {
  const lines: string[] = [];

  const emoji = {
    style: ':art:',
    performance: ':zap:',
    security: ':lock:',
    logic: ':bulb:',
    testing: ':test_tube:',
    documentation: ':book:',
    architecture: ':building_construction:',
  }[suggestion.category] || ':pencil:';

  lines.push(`<details>`);
  lines.push(`<summary>${emoji} ${suggestion.title} — \`${suggestion.file}:${suggestion.lineRange.start}\`</summary>`);
  lines.push('');
  lines.push(`**${capitalize(suggestion.type.replace('_', ' '))}** | Category: ${suggestion.category}`);
  lines.push('');
  lines.push(suggestion.description);
  lines.push('');

  if (suggestion.currentCode && suggestion.suggestedCode) {
    lines.push('**Suggested change:**');
    lines.push('');
    lines.push('```diff');
    lines.push(`- ${suggestion.currentCode}`);
    lines.push(`+ ${suggestion.suggestedCode}`);
    lines.push('```');
    lines.push('');
  }

  if (suggestion.reasoning) {
    lines.push(`**Reasoning:** ${suggestion.reasoning}`);
    lines.push('');
  }

  if (suggestion.references && suggestion.references.length > 0) {
    lines.push('**References:**');
    for (const ref of suggestion.references) {
      lines.push(`- ${ref}`);
    }
    lines.push('');
  }

  lines.push('</details>');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format inline comments for GitHub PR review.
 */
export function formatInlineComments(result: ReviewResult): InlineComment[] {
  const comments: InlineComment[] = [];

  // Add inline comments for high severity issues
  if (result.riskReport) {
    for (const issue of result.riskReport.issues) {
      if (issue.severity === 'critical' || issue.severity === 'high') {
        comments.push({
          path: issue.file,
          line: issue.lineRange.start,
          body: formatInlineIssueComment(issue),
          side: 'RIGHT',
          startLine: issue.lineRange.start !== issue.lineRange.end ? issue.lineRange.start : undefined,
          startSide: issue.lineRange.start !== issue.lineRange.end ? 'RIGHT' : undefined,
        });
      }
    }
  }

  // Add inline comments for must-fix suggestions
  for (const suggestion of result.suggestions) {
    if (suggestion.type === 'must_fix') {
      // Check if we already have a comment for this file+line
      const exists = comments.some(
        (c) => c.path === suggestion.file && c.line === suggestion.lineRange.start,
      );

      if (!exists) {
        comments.push({
          path: suggestion.file,
          line: suggestion.lineRange.start,
          body: formatInlineSuggestionComment(suggestion),
          side: 'RIGHT',
        });
      }
    }
  }

  return comments;
}

/**
 * Format an inline comment for a risk issue.
 */
function formatInlineIssueComment(issue: RiskIssue): string {
  const emoji = severityEmoji(issue.severity);
  const confBadge = confidenceBadge(issue.confidence);

  return [
    `${emoji} **${issue.title}** — ${configSeverity(issue.severity)} ${confBadge}`,
    '',
    issue.description,
    '',
    issue.suggestion ? `> **Suggestion:** ${issue.suggestion}` : '',
    issue.ruleIds?.length ? `> Ref: ${issue.ruleIds.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Format an inline comment for a suggestion.
 */
function formatInlineSuggestionComment(suggestion: ReviewSuggestion): string {
  const lines: string[] = [
    `:exclamation: **${suggestion.title}**`,
    '',
    suggestion.description,
    '',
  ];

  if (suggestion.suggestedCode) {
    lines.push('```suggestion');
    lines.push(suggestion.suggestedCode);
    lines.push('```');
  }

  if (suggestion.reasoning) {
    lines.push('');
    lines.push(`*Reasoning: ${suggestion.reasoning}*`);
  }

  return lines.join('\n');
}

/**
 * Format the review summary that appears atop the PR review.
 */
function formatReviewSummary(result: ReviewResult): string {
  const parts: string[] = [];

  parts.push(AI_REVIEW_MARKER);

  if (result.summary) {
    parts.push(`**AI Review:** ${result.summary.title}`);
  } else {
    parts.push('**AI Code Review Results**');
  }

  parts.push('');

  // Quick stats
  const issues = result.riskReport?.issues || [];
  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const highCount = issues.filter((i) => i.severity === 'high').length;
  const mustFixCount = result.suggestions.filter((s) => s.type === 'must_fix').length;

  if (criticalCount > 0 || highCount > 0) {
    parts.push(`:warning: **${criticalCount} critical**, **${highCount} high** severity issues found.`);
  }

  if (mustFixCount > 0) {
    parts.push(`:exclamation: **${mustFixCount}** items require attention before merging.`);
  }

  if (result.riskReport) {
    parts.push(`Risk score: **${result.riskReport.overallScore}/100**`);
  }

  parts.push('');
  parts.push(`*Review by AI using \`${result.metadata.model}\` |
    Context: \`${result.metadata.contextLevel}\` |
    Time: ${formatDuration(result.metadata.durationMs)} |
    Tokens: ${result.metadata.tokensUsed.toLocaleString()}*`);
  parts.push('');

  // Detailed results are in the PR comment
  parts.push('See the PR comment below for detailed analysis.');
  parts.push('');

  return parts.join('\n');
}

/**
 * Format the footer with metadata.
 */
function formatFooter(result: ReviewResult): string {
  const parts: string[] = [];

  parts.push('---');
  parts.push('');
  parts.push(
    `*AI code review by **${result.metadata.model}** | ` +
    `Context: \`${result.metadata.contextLevel}\` | ` +
    `Processed in ${formatDuration(result.metadata.durationMs)} | ` +
    `${result.metadata.tokensUsed.toLocaleString()} tokens used*`,
  );
  parts.push('');
  parts.push(
    `> :robot: This is an automated review. ` +
    `Please verify the suggestions before applying. ` +
    `Provide feedback by reacting to this comment.`,
  );

  return parts.join('\n');
}

/**
 * Determine the review event type based on results.
 */
function determineReviewEvent(result: ReviewResult): 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' {
  const issues = result.riskReport?.issues || [];
  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const mustFixCount = result.suggestions.filter((s) => s.type === 'must_fix').length;

  if (criticalCount > 0) {
    return 'REQUEST_CHANGES';
  }

  if (mustFixCount > 1) {
    return 'REQUEST_CHANGES';
  }

  if (mustFixCount === 0 && issues.length === 0) {
    return 'APPROVE';
  }

  return 'COMMENT';
}

// ============================================================
// Formatting utilities
// ============================================================

function formatRiskGauge(score: number): string {
  if (score >= 80) return ':red_circle:';
  if (score >= 60) return ':orange_circle:';
  if (score >= 40) return ':yellow_circle:';
  if (score >= 20) return ':green_circle:';
  return ':white_circle:';
}

function formatComplexityBar(complexity: number): string {
  if (complexity >= 80) return `:red_circle: ${complexity}`;
  if (complexity >= 60) return `:orange_circle: ${complexity}`;
  if (complexity >= 40) return `:yellow_circle: ${complexity}`;
  if (complexity >= 20) return `:green_circle: ${complexity}`;
  return `:white_circle: ${complexity}`;
}

function formatDependencyType(type: string): string {
  const map: Record<string, string> = {
    added: ':heavy_plus_sign: Added',
    removed: ':heavy_minus_sign: Removed',
    updated: ':arrow_up: Updated',
    replaced: ':arrows_counterclockwise: Replaced',
  };
  return map[type] || type;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function severityEmoji(severity: string): string {
  const map: Record<string, string> = {
    critical: ':red_circle:',
    high: ':orange_circle:',
    medium: ':yellow_circle:',
    low: ':white_circle:',
  };
  return map[severity] || ':white_circle:';
}

function severityOrder(severity: string): number {
  const order: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  return order[severity] || 0;
}

function confidenceBadge(confidence: string): string {
  const map: Record<string, string> = {
    high: '`High confidence`',
    medium: '`Med confidence`',
    low: '`Low confidence`',
  };
  return map[confidence] || '';
}

function categoryEmoji(category: string): string {
  const map: Record<string, string> = {
    security: 'lock',
    performance: 'zap',
    bug: 'beetle',
    logic: 'brain',
    maintainability: 'broom',
  };
  return map[category] || 'question';
}

function configSeverity(severity: string): string {
  return `\`${severity.toUpperCase()}\``;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function detectLanguageFromFile(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.py': 'python',
    '.java': 'java',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.php': 'php',
    '.cs': 'csharp',
    '.cpp': 'cpp',
    '.c': 'c',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.sql': 'sql',
    '.sh': 'bash',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.json': 'json',
    '.xml': 'xml',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.md': 'markdown',
    '.dockerfile': 'dockerfile',
  };
  return map[ext] || '';
}

export default {
  formatReviewOutput,
  formatPRComment,
  formatInlineComments,
};
