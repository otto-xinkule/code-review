import { z } from 'zod';

/**
 * Zod schemas for validating LLM output structures.
 * Ensures type safety and content validation for all analysis results.
 */

// ============================================================
// PR Summary Schema
// ============================================================

export const KeyFileInfoSchema = z.object({
  filename: z.string().min(1),
  reason: z.string().min(1),
  complexity: z.number().min(0).max(100),
  changes: z.number().min(0),
});

export const DependencyChangeSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['added', 'removed', 'updated', 'replaced']),
  oldVersion: z.string().optional(),
  newVersion: z.string().optional(),
  file: z.string().min(1),
});

export const ImpactAnalysisSchema = z.object({
  level: z.enum(['none', 'low', 'medium', 'high', 'critical']),
  affectedAreas: z.array(z.string()),
  upstreamDependencies: z.array(z.string()),
  downstreamDependencies: z.array(z.string()),
  hasDatabaseChanges: z.boolean(),
  hasAPIChanges: z.boolean(),
  hasConfigChanges: z.boolean(),
  migrationNotes: z.string().nullable().optional(),
});

export const PRSummarySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  changeType: z.enum([
    'feature',
    'bugfix',
    'refactor',
    'performance',
    'docs',
    'test',
    'chore',
    'mixed',
  ]),
  affectedModules: z.array(z.string()),
  keyFiles: z.array(KeyFileInfoSchema).max(20),
  dependencyChanges: z.array(DependencyChangeSchema),
  impact: ImpactAnalysisSchema,
  statistics: z.object({
    filesChanged: z.number().min(0),
    additions: z.number().min(0),
    deletions: z.number().min(0),
    byLanguage: z.record(z.string(), z.number()),
    byType: z.record(z.string(), z.number()),
  }),
});

// ============================================================
// Risk Report Schema
// ============================================================

export const RiskIssueSchema = z.object({
  id: z.string().min(1).max(100),
  category: z.enum(['security', 'performance', 'bug', 'logic', 'maintainability']),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  confidence: z.enum(['high', 'medium', 'low']),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  file: z.string().min(1),
  lineRange: z.object({
    start: z.number().positive(),
    end: z.number().positive(),
  }),
  codeSnippet: z.string(),
  suggestion: z.string().nullable(),
  score: z.number().min(0).max(100),
  ruleIds: z.array(z.string()).optional(),
  verifiedByTool: z.boolean().optional(),
  verificationTool: z.string().optional(),
});

export const RiskReportSchema = z.object({
  summary: z.string().min(1).max(1000),
  overallScore: z.number().min(0).max(100),
  issues: z.array(RiskIssueSchema),
  byCategory: z.record(z.string(), z.number()),
  bySeverity: z.record(z.string(), z.number()),
  highRiskFiles: z.array(z.string()),
});

// ============================================================
// Review Suggestions Schema
// ============================================================

export const ReviewSuggestionSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['must_fix', 'recommended', 'optional']),
  category: z.enum([
    'style',
    'performance',
    'security',
    'logic',
    'testing',
    'documentation',
    'architecture',
  ]),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  file: z.string().min(1),
  lineRange: z.object({
    start: z.number().positive(),
    end: z.number().positive(),
  }),
  currentCode: z.string(),
  suggestedCode: z.string(),
  reasoning: z.string().min(1),
  references: z.array(z.string().url().or(z.string())).optional(),
});

// ============================================================
// Content Safety Validation
// ============================================================

/**
 * Validator that checks for unsafe content in model outputs.
 */
export class ContentSafetyValidator {
  private blockedPatterns: RegExp[] = [
    // Prevent model outputs containing injection attempts
    /<script[\s>]/i,
    /javascript\s*:/i,
    /onerror\s*=/i,
    /onload\s*=/i,
    // Block system prompt leakage attempts
    /system\s*prompt/i,
    /you\s*are\s*a\s*(helpful\s*)?assistant/i,
    // Block inappropriately revealing credentials
    /(?:api_key|password)\s*[:=]\s*['"][^'"]{6,}['"]/i,
  ];

  /**
   * Check if content contains any blocked patterns.
   */
  isSafe(content: string): boolean {
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(content)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check specific fields of an object for unsafe content.
   */
  validateObject(obj: Record<string, unknown>): { safe: boolean; violations: string[] } {
    const violations: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && !this.isSafe(value)) {
        violations.push(`Field "${key}" contains potentially unsafe content`);
      } else if (typeof value === 'object' && value !== null) {
        // Recursively check nested objects
        const nested = this.validateObject(value as Record<string, unknown>);
        violations.push(
          ...nested.violations.map((v) => `${key}.${v}`),
        );
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (typeof value[i] === 'string' && !this.isSafe(value[i])) {
            violations.push(`Field "${key}[${i}]" contains potentially unsafe content`);
          }
        }
      }
    }

    return {
      safe: violations.length === 0,
      violations,
    };
  }
}

export const contentSafetyValidator = new ContentSafetyValidator();

// ============================================================
// Validation helper functions
// ============================================================

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: z.ZodError['errors'];
}

/**
 * Validate and parse a value against a Zod schema.
 */
export function validate<T>(schema: z.ZodSchema<T>, data: unknown): ValidationResult<T> {
  try {
    const parsed = schema.parse(data);
    return { success: true, data: parsed };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, errors: error.errors };
    }
    throw error;
  }
}

/**
 * Validate and attempt to repair/coerce a value.
 */
export function validateSafe<T>(schema: z.ZodSchema<T>, data: unknown): ValidationResult<T> {
  try {
    const parsed = schema.parse(data);
    return { success: true, data: parsed };
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Try coerce (with defaults)
      try {
        const safeSchema = extendWithDefaults(schema);
        const parsed = safeSchema.parse(data);
        return { success: true, data: parsed };
      } catch {
        return { success: false, errors: error.errors };
      }
    }
    throw error;
  }
}

/**
 * Add default values to a schema to make it more forgiving.
 */
function extendWithDefaults(schema: z.ZodSchema<unknown>): z.ZodSchema<unknown> {
  // For objects, make all fields optional with defaults
  if (schema instanceof z.ZodObject) {
    const shape = schema._def.shape();
    const newShape: Record<string, z.ZodSchema<unknown>> = {};

    for (const [key, value] of Object.entries(shape)) {
      const valueSchema = value as z.ZodSchema<unknown>;
      if (valueSchema instanceof z.ZodString) {
        newShape[key] = valueSchema.default('');
      } else if (valueSchema instanceof z.ZodNumber) {
        newShape[key] = valueSchema.default(0);
      } else if (valueSchema instanceof z.ZodBoolean) {
        newShape[key] = valueSchema.default(false);
      } else if (valueSchema instanceof z.ZodArray) {
        newShape[key] = valueSchema.default([]);
      } else if (valueSchema instanceof z.ZodEnum) {
        newShape[key] = valueSchema.optional();
      } else if (valueSchema instanceof z.ZodObject) {
        newShape[key] = extendWithDefaults(valueSchema);
      } else {
        newShape[key] = valueSchema.optional();
      }
    }

    return z.object(newShape);
  }
  return schema.optional();
}
