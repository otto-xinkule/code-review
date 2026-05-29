import { logger } from '../utility/logger.js';
import {
  PRSummarySchema,
  RiskReportSchema,
  ReviewSuggestionSchema,
  contentSafetyValidator,
  validate,
  validateSafe,
} from './schemas/review.js';
import type {
  PRSummary,
  RiskReport,
  ReviewSuggestion,
  ReviewResult,
  RiskIssue,
} from '../types/index.js';

/**
 * Output Validator
 *
 * Validates AI model outputs against Zod schemas,
 * applies content safety checks, and handles invalid data gracefully.
 */

export interface ValidationReport {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  sanitized: boolean;
}

/**
 * Validate the complete review result.
 */
export function validateReviewResult(result: ReviewResult): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  let sanitized = false;

  // Validate PR summary
  if (result.summary) {
    const summaryResult = validatePRSummary(result.summary);
    if (!summaryResult.isValid) {
      errors.push(...summaryResult.errors);
    }
    warnings.push(...summaryResult.warnings);
    if (summaryResult.sanitized) sanitized = true;
  }

  // Validate risk report
  if (result.riskReport) {
    const riskResult = validateRiskReport(result.riskReport);
    if (!riskResult.isValid) {
      errors.push(...riskResult.errors);
    }
    warnings.push(...riskResult.warnings);
    if (riskResult.sanitized) sanitized = true;
  }

  // Validate suggestions
  for (const suggestion of result.suggestions) {
    const suggestionResult = validateReviewSuggestion(suggestion);
    if (!suggestionResult.isValid) {
      errors.push(...suggestionResult.errors);
    }
    warnings.push(...suggestionResult.warnings);
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    sanitized,
  };
}

/**
 * Validate PR summary against schema.
 */
export function validatePRSummary(summary: unknown): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  let sanitized = false;

  const result = validateSafe(PRSummarySchema, summary);
  if (!result.success && result.errors) {
    for (const err of result.errors) {
      errors.push(`PRSummary validation error: ${err.path.join('.')} - ${err.message}`);
    }
  }

  // Content safety check
  if (typeof summary === 'object' && summary !== null) {
    const safety = contentSafetyValidator.validateObject(summary as Record<string, unknown>);
    if (!safety.safe) {
      errors.push(...safety.violations.map((v) => `Content safety: ${v}`));
      sanitized = true;
    }
  }

  if (result.data) {
    // Additional semantic checks
    const data = result.data as PRSummary;
    if (data.keyFiles && data.keyFiles.length > 10) {
      warnings.push('PRSummary has more than 10 keyFiles, consider limiting');
    }
    if (data.description && data.description.length < 20) {
      warnings.push('PRSummary description is very short');
    }
    if (data.impact && data.impact.level === 'critical' && data.impact.affectedAreas.length === 0) {
      warnings.push('Critical impact but no affected areas specified');
    }
  }

  return { isValid: errors.length === 0, errors, warnings, sanitized };
}

/**
 * Validate risk report against schema.
 */
export function validateRiskReport(report: unknown): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  let sanitized = false;

  const result = validateSafe(RiskReportSchema, report);
  if (!result.success && result.errors) {
    for (const err of result.errors) {
      errors.push(`RiskReport validation error: ${err.path.join('.')} - ${err.message}`);
    }
  }

  // Content safety check
  if (typeof report === 'object' && report !== null) {
    const safety = contentSafetyValidator.validateObject(report as Record<string, unknown>);
    if (!safety.safe) {
      errors.push(...safety.violations.map((v) => `Content safety: ${v}`));
      sanitized = true;
    }
  }

  if (result.data) {
    const data = result.data as RiskReport;
    // Verify issue count matches category/severity counts
    if (data.issues) {
      const expectedCategoryTotal = Object.values(data.byCategory || {}).reduce((a, b) => a + b, 0);
      const expectedSeverityTotal = Object.values(data.bySeverity || {}).reduce((a, b) => a + b, 0);

      if (data.issues.length !== expectedCategoryTotal) {
        warnings.push(
          `Risk report issue count (${data.issues.length}) does not match byCategory total (${expectedCategoryTotal})`,
        );
      }
      if (data.issues.length !== expectedSeverityTotal) {
        warnings.push(
          `Risk report issue count (${data.issues.length}) does not match bySeverity total (${expectedSeverityTotal})`,
        );
      }
    }

    // Check for duplicate issues
    const ids = new Set<string>();
    for (const issue of data.issues || []) {
      if (ids.has(issue.id)) {
        warnings.push(`Duplicate issue ID: ${issue.id}`);
      }
      ids.add(issue.id);
    }

    // Warn about very high number of issues
    if ((data.issues || []).length > 20) {
      warnings.push(`High number of risk issues (${data.issues.length}), consider filtering`);
    }
  }

  return { isValid: errors.length === 0, errors, warnings, sanitized };
}

/**
 * Validate a single review suggestion.
 */
export function validateReviewSuggestion(suggestion: unknown): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  let sanitized = false;

  const result = validate(ReviewSuggestionSchema, suggestion);
  if (!result.success && result.errors) {
    for (const err of result.errors) {
      errors.push(`Suggestion validation error: ${err.path.join('.')} - ${err.message}`);
    }
  }

  // Content safety check
  if (typeof suggestion === 'object' && suggestion !== null) {
    const safety = contentSafetyValidator.validateObject(suggestion as Record<string, unknown>);
    if (!safety.safe) {
      errors.push(...safety.violations.map((v) => `Content safety: ${v}`));
      sanitized = true;
    }
  }

  if (result.data) {
    const data = result.data as ReviewSuggestion;
    if (data.suggestedCode && data.suggestedCode === data.currentCode) {
      warnings.push('Suggested code is identical to current code');
    }
    if (data.type === 'must_fix' && data.lineRange.start === data.lineRange.end) {
      warnings.push('Must-fix suggestion has zero-width line range');
    }
  }

  return { isValid: errors.length === 0, errors, warnings, sanitized };
}

/**
 * Validate a single risk issue.
 */
export function validateRiskIssue(issue: RiskIssue): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  let sanitized = false;

  // Content safety check for all string fields
  const stringFields = ['title', 'description', 'codeSnippet', 'suggestion'];
  for (const field of stringFields) {
    const value = issue[field as keyof RiskIssue] as string | null;
    if (value && typeof value === 'string' && !contentSafetyValidator.isSafe(value)) {
      errors.push(`Content safety: issue.${field} contains potentially unsafe content`);
      sanitized = true;
    }
  }

  // Semantic checks
  if (issue.severity === 'critical' && issue.confidence === 'low') {
    warnings.push(`Critical severity issue "${issue.title}" has low confidence`);
  }

  if (issue.lineRange.start > issue.lineRange.end) {
    errors.push(`Issue "${issue.title}" has invalid line range`);
  }

  if (issue.score < 0 || issue.score > 100) {
    errors.push(`Issue "${issue.title}" has invalid score: ${issue.score}`);
  }

  if (!issue.description || issue.description.length < 10) {
    warnings.push(`Issue "${issue.title}" has very short description`);
  }

  return { isValid: errors.length === 0, errors, warnings, sanitized };
}

export default {
  validateReviewResult,
  validatePRSummary,
  validateRiskReport,
  validateReviewSuggestion,
  validateRiskIssue,
};
