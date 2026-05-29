import { logger } from '../utility/logger.js';

/**
 * Secret Sanitizer Module
 *
 * Detects and redacts sensitive information from code diffs
 * before sending to AI models. Prevents accidental exposure of
 * credentials, tokens, keys, and other secrets.
 */

interface SanitizationResult {
  sanitized: string;
  redactions: RedactionRecord[];
  wasModified: boolean;
}

interface RedactionRecord {
  type: string;
  original: string;
  replacement: string;
  position: number;
  line: number;
}

/**
 * Patterns for detecting various types of secrets.
 * Each pattern has a type label and the regex to match.
 */
const SECRET_PATTERNS: Array<{ type: string; pattern: RegExp; replacement: string }> = [
  // AWS Access Keys
  {
    type: 'AWS Access Key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: 'AKIA[REDACTED]',
  },
  // AWS Secret Access Keys
  {
    type: 'AWS Secret Key',
    pattern: /["']?aws_secret_access_key["']?\s*[:=]\s*["'][^"'\n]{20,}["']/gi,
    replacement: 'aws_secret_access_key=[REDACTED]',
  },
  // GitHub Tokens
  {
    type: 'GitHub Token',
    pattern: /ghp_[0-9a-zA-Z]{36}/g,
    replacement: 'ghp_[REDACTED]',
  },
  {
    type: 'GitHub Token',
    pattern: /github_pat_[0-9a-zA-Z_]{40,}/g,
    replacement: 'github_pat_[REDACTED]',
  },
  // Generic API Keys (long alphanumeric strings assigned to key-like vars)
  {
    type: 'Generic API Key',
    pattern: /(api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9_\-.]{20,}["']/gi,
    replacement: '$1=[REDACTED_API_KEY]',
  },
  // Stripe Keys
  {
    type: 'Stripe Key',
    pattern: /(sk|pk)_(test|live)_[0-9a-zA-Z]{24,}/g,
    replacement: '$1_$2_[REDACTED]',
  },
  // Private Key Headers
  {
    type: 'Private Key',
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: '-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----',
  },
  // JWT Tokens
  {
    type: 'JWT Token',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: 'eyJ[REDACTED].[REDACTED].[REDACTED]',
  },
  // Google API Keys
  {
    type: 'Google API Key',
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
    replacement: 'AIza[REDACTED]',
  },
  // Slack Tokens
  {
    type: 'Slack Token',
    pattern: /xox[abpos]-[0-9A-Za-z\-_]+/g,
    replacement: 'xox[REDACTED]',
  },
  // Database Connection Strings with passwords
  {
    type: 'Database Connection String',
    pattern: /(mongodb|mysql|postgres|postgresql|redis|sqlite|jdbc):\/\/[^:\s]+:[^@\s]+@/gi,
    replacement: '$1://[USER]:[REDACTED_PASSWORD]@',
  },
  // Authorization Headers
  {
    type: 'Authorization Header',
    pattern: /(Authorization|authorization)\s*[:=]\s*["'][^"']+["']/g,
    replacement: '$1: [REDACTED]',
  },
  // Password assignments in config
  {
    type: 'Config Password',
    pattern: /["'](password|passwd|pwd|secret|token)["']\s*[:=]\s*["'][^"'\n]{3,}["']/gi,
    replacement: '"$1": "[REDACTED]"',
  },
  // SSH Private Key References
  {
    type: 'SSH Key Path',
    pattern: /~\/\.ssh\/id_[a-z0-9_]+/g,
    replacement: '~/.ssh/[REDACTED_KEY_NAME]',
  },
  // Generic tokens/keys ending with equals (base64-like)
  {
    type: 'Base64 Token',
    pattern: /(token|key|secret|password|credential)\s*[:=]\s*['"]?[A-Za-z0-9+/]{32,}={0,2}['"]?/gi,
    replacement: '$1=[REDACTED_TOKEN]',
  },
];

/**
 * Sanitize text content by redacting secrets and sensitive information.
 * Returns the sanitized text and a record of what was redacted.
 */
export function sanitize(text: string): SanitizationResult {
  let sanitized = text;
  const redactions: RedactionRecord[] = [];

  for (const { type, pattern, replacement } of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sanitized)) !== null) {
      const original = match[0];
      const lineNumber = countLinesUpTo(sanitized, match.index);

      // For patterns with capture groups, use the group-aware replacement
      let actualReplacement: string;
      if (match.length > 1 && replacement.includes('$1')) {
        actualReplacement = original.replace(pattern, replacement);
      } else {
        actualReplacement = replacement;
      }

      // Record what we redacted
      redactions.push({
        type,
        original: truncate(original, 50),
        replacement: truncate(actualReplacement, 50),
        position: match.index,
        line: lineNumber,
      });

      // Only replace the first occurrence of this specific match
      // by building a new string
      const before = sanitized.substring(0, match.index);
      const after = sanitized.substring(match.index + original.length);

      // Use the capture-group aware replacement
      const replaced = type.includes('Key') || type.includes('Token')
        ? actualReplacement
        : replacement;

      sanitized = before + replaced + after;

      // Update pattern lastIndex for the new string
      pattern.lastIndex = match.index + replaced.length;
    }
  }

  if (redactions.length > 0) {
    logger.warn(
      {
        totalRedactions: redactions.length,
        byType: redactions.reduce<Record<string, number>>((acc, r) => {
          acc[r.type] = (acc[r.type] || 0) + 1;
          return acc;
        }, {}),
      },
      `Sanitized ${redactions.length} potential secrets from input`,
    );
  }

  return {
    sanitized,
    redactions,
    wasModified: redactions.length > 0,
  };
}

/**
 * Sanitize a parsed diff, preserving structure while redacting secrets.
 * Works on the raw diff string and returns sanitized version.
 */
export function sanitizeDiff(diffContent: string): string {
  const result = sanitize(diffContent);
  return result.sanitized;
}

/**
 * Check if content contains potential secrets (without modifying).
 * Fast pre-check before full sanitization.
 */
export function containsSecrets(text: string): boolean {
  for (const { pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Get a summary of what was redacted.
 */
export function getRedactionSummary(redactions: RedactionRecord[]): string {
  if (redactions.length === 0) return 'No secrets detected.';

  const byType: Record<string, number> = {};
  for (const r of redactions) {
    byType[r.type] = (byType[r.type] || 0) + 1;
  }

  const parts = Object.entries(byType).map(([type, count]) => `${count}x ${type}`);
  return `Redacted: ${parts.join(', ')}`;
}

/**
 * Count lines up to a position in text.
 */
function countLinesUpTo(text: string, position: number): number {
  const before = text.substring(0, position);
  return (before.match(/\n/g) || []).length + 1;
}

/**
 * Truncate a string for logging purposes.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

export default {
  sanitize,
  sanitizeDiff,
  containsSecrets,
  getRedactionSummary,
};
