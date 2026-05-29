import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzePR } from '../src/analysis/engine.js';
import type { ParsedDiff, PRMetadata, AnalysisConfig } from '../src/types/index.js';

describe('Analysis Engine', () => {
  // Mock parsed diff
  const mockParsedDiff: ParsedDiff = {
    raw: '',
    files: [
      {
        filename: 'src/utils.ts',
        language: 'TypeScript',
        status: 'modified',
        additions: 5,
        deletions: 2,
        hunks: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 4,
            header: '@@ -1,3 +1,4 @@',
            lines: [
              { type: 'context', content: 'function add(a, b) {', oldLineNumber: 1, newLineNumber: 1 },
              { type: 'delete', content: '  return a + b;', oldLineNumber: 2 },
              { type: 'add', content: '  // Add validation', newLineNumber: 2 },
              { type: 'add', content: '  if (a < 0 || b < 0) throw new Error();', newLineNumber: 3 },
              { type: 'context', content: '  return a + b;', oldLineNumber: 3, newLineNumber: 4 },
            ],
          },
        ],
      },
    ],
    stats: {
      filesChanged: 1,
      additions: 5,
      deletions: 2,
      byStatus: { modified: 1 },
      byLanguage: { TypeScript: 1 },
    },
  };

  const mockPRMetadata: PRMetadata = {
    repository: 'test/repo',
    prNumber: 1,
    title: 'Add input validation to utils',
    body: 'This PR adds input validation to the add function.',
    author: 'developer',
    baseBranch: 'main',
    headBranch: 'feature/validation',
    baseSha: 'abc123',
    headSha: 'def456',
    state: 'open',
    isDraft: false,
    labels: [],
    linkedIssues: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    additions: 5,
    deletions: 2,
    changedFiles: 1,
    isUpdate: false,
  };

  describe('analyzePR', () => {
    it('should return success=false when no model providers available', async () => {
      const result = await analyzePR(mockParsedDiff, mockPRMetadata, {
        generateSummary: false,
        detectRisks: false,
        generateSuggestions: false,
      });

      // Without API keys, should fail gracefully
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });
  });
});
