import { describe, it, expect } from 'vitest';
import { parseDiff, detectLanguage, isDiffEmpty, getChangedExtensions } from '../src/collectors/diff-parser.js';

describe('diff-parser', () => {
  describe('detectLanguage', () => {
    it('should detect TypeScript', () => {
      expect(detectLanguage('src/app.ts')).toBe('TypeScript');
      expect(detectLanguage('src/component.tsx')).toBe('TypeScript React');
    });

    it('should detect JavaScript', () => {
      expect(detectLanguage('src/app.js')).toBe('JavaScript');
      expect(detectLanguage('src/component.jsx')).toBe('JavaScript React');
    });

    it('should detect Python', () => {
      expect(detectLanguage('main.py')).toBe('Python');
    });

    it('should detect Dockerfile', () => {
      expect(detectLanguage('Dockerfile')).toBe('Dockerfile');
    });

    it('should return Unknown for unrecognized files', () => {
      expect(detectLanguage('unknown.xyz')).toBe('Unknown');
    });
  });

  describe('parseDiff', () => {
    it('should parse a simple diff with one file', () => {
      const rawDiff = [
        'diff --git a/file.ts b/file.ts',
        '--- a/file.ts',
        '+++ b/file.ts',
        '@@ -1,3 +1,4 @@',
        ' unchanged line',
        '-old line',
        '+new line',
        ' unchanged line 2',
        '+added line',
      ].join('\n');

      const result = parseDiff(rawDiff);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].filename).toBe('file.ts');
      expect(result.files[0].language).toBe('TypeScript');
      expect(result.files[0].additions).toBe(2);
      expect(result.files[0].deletions).toBe(1);
      expect(result.stats.filesChanged).toBe(1);
      expect(result.stats.additions).toBe(2);
      expect(result.stats.deletions).toBe(1);
    });

    it('should parse multiple files', () => {
      const rawDiff = [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,3 +1,3 @@',
        ' unchanged',
        '-old',
        '+new',
        'diff --git a/src/utils.py b/src/utils.py',
        '--- a/src/utils.py',
        '+++ b/src/utils.py',
        '@@ -1,0 +1,2 @@',
        '+new line 1',
        '+new line 2',
      ].join('\n');

      const result = parseDiff(rawDiff);

      expect(result.files).toHaveLength(2);
      expect(result.files[0].filename).toBe('src/app.ts');
      expect(result.files[1].filename).toBe('src/utils.py');
      expect(result.stats.filesChanged).toBe(2);
    });

    it('should detect file status', () => {
      const addedDiff = [
        'diff --git a/newfile.ts b/newfile.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/newfile.ts',
        '@@ -0,0 +1,1 @@',
        '+new content',
      ].join('\n');

      const result = parseDiff(addedDiff);
      expect(result.files[0].status).toBe('added');
    });

    it('should extract hunk line numbers correctly', () => {
      const rawDiff = [
        'diff --git a/file.ts b/file.ts',
        '--- a/file.ts',
        '+++ b/file.ts',
        '@@ -10,5 +10,6 @@',
        ' context line 1',
        '-removed line',
        '+added line',
        ' context line 2',
        ' context line 3',
        '+added line 2',
      ].join('\n');

      const result = parseDiff(rawDiff);
      const hunk = result.files[0].hunks[0];

      expect(hunk.oldStart).toBe(10);
      expect(hunk.oldLines).toBe(5);
      expect(hunk.newStart).toBe(10);
      expect(hunk.newLines).toBe(6);
    });

    it('should handle empty diff', () => {
      const result = parseDiff('');
      expect(result.files).toHaveLength(0);
      expect(isDiffEmpty(result)).toBe(true);
    });
  });

  describe('getChangedExtensions', () => {
    it('should return unique file extensions', () => {
      const rawDiff = [
        'diff --git a/file1.ts b/file1.ts',
        '--- a/file1.ts',
        '+++ b/file1.ts',
        '@@ -1,0 +1,1 @@',
        '+a',
        'diff --git a/file2.ts b/file2.ts',
        '--- a/file2.ts',
        '+++ b/file2.ts',
        '@@ -1,0 +1,1 @@',
        '+b',
        'diff --git a/file3.py b/file3.py',
        '--- a/file3.py',
        '+++ b/file3.py',
        '@@ -1,0 +1,1 @@',
        '+c',
      ].join('\n');

      const parsed = parseDiff(rawDiff);
      const extensions = getChangedExtensions(parsed);

      expect(extensions).toContain('.ts');
      expect(extensions).toContain('.py');
      expect(extensions).toHaveLength(2);
    });
  });
});
