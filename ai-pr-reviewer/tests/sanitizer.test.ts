import { describe, it, expect } from 'vitest';
import { sanitize, containsSecrets, sanitizeDiff } from '../src/collectors/sanitizer.js';

describe('sanitizer', () => {
  describe('containsSecrets', () => {
    it('should detect AWS access keys', () => {
      const text = 'const key = "AKIAIOSFODNN7EXAMPLE";';
      expect(containsSecrets(text)).toBe(true);
    });

    it('should detect GitHub tokens', () => {
      const text = 'const token = "ghp_1234567890abcdef1234567890abcdef12345678";';
      expect(containsSecrets(text)).toBe(true);
    });

    it('should detect API keys in assignments', () => {
      const text = 'api_key = "sk-verylongapikey1234567890abcdef"';
      expect(containsSecrets(text)).toBe(true);
    });

    it('should not flag normal code', () => {
      const text = 'const x = 42;\nfunction hello() { return "world"; }';
      expect(containsSecrets(text)).toBe(false);
    });
  });

  describe('sanitize', () => {
    it('should redact AWS access keys', () => {
      const text = 'const key = "AKIAIOSFODNN7EXAMPLE";';
      const result = sanitize(text);

      expect(result.wasModified).toBe(true);
      expect(result.sanitized).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(result.sanitized).toContain('REDACTED');
    });

    it('should redact GitHub tokens', () => {
      const text = 'GITHUB_TOKEN=ghp_1234567890abcdef1234567890abcdef12345678';
      const result = sanitize(text);

      expect(result.wasModified).toBe(true);
      expect(result.sanitized).not.toContain('ghp_');
    });

    it('should not modify clean text', () => {
      const text = 'function add(a: number, b: number): number { return a + b; }';
      const result = sanitize(text);

      expect(result.wasModified).toBe(false);
      expect(result.sanitized).toBe(text);
    });

    it('should record redaction details', () => {
      const text = 'API_KEY = "sk-1234567890abcdef1234567890abcdef12345678"';
      const result = sanitize(text);

      expect(result.redactions).toHaveLength(1);
      expect(result.redactions[0].type).toBeDefined();
      expect(result.redactions[0].line).toBeGreaterThan(0);
    });

    it('should handle multiple secrets', () => {
      const text = [
        'AWS_KEY = "AKIAIOSFODNN7EXAMPLE"',
        'GITHUB_TOKEN = ghp_1234567890abcdef1234567890abcdef12345678',
        'const x = 42;',
      ].join('\n');

      const result = sanitize(text);

      expect(result.wasModified).toBe(true);
      expect(result.redactions.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('sanitizeDiff', () => {
    it('should sanitize a diff string', () => {
      const diff = [
        'diff --git a/config.ts b/config.ts',
        '--- a/config.ts',
        '+++ b/config.ts',
        '@@ -1,1 +1,1 @@',
        '-const apiKey = "old-secret-key-1234567890";',
        '+const apiKey = "new-secret-key-9876543210";',
      ].join('\n');

      const sanitized = sanitizeDiff(diff);

      expect(sanitized).not.toContain('old-secret-key');
      expect(sanitized).not.toContain('new-secret-key');
    });
  });
});
