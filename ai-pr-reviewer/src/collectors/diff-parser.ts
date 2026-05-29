import * as Diff from 'diff';
import type { ParsedDiff, ParsedDiffFile, DiffHunk, DiffLine, DiffStats, PRFile } from '../types/index.js';
import { logger } from '../utility/logger.js';

/**
 * Diff Parser Module
 *
 * Parses unified diff format into structured data.
 * Extracts hunks, individual lines, detects languages,
 * and computes statistics.
 */

// Language detection map from file extensions
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript React',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript React',
  '.py': 'Python',
  '.java': 'Java',
  '.go': 'Go',
  '.rs': 'Rust',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.c': 'C',
  '.h': 'C/C++ Header',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.scala': 'Scala',
  '.sql': 'SQL',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.json': 'JSON',
  '.xml': 'XML',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.less': 'Less',
  '.md': 'Markdown',
  '.mdx': 'MDX',
  '.graphql': 'GraphQL',
  '.tf': 'Terraform',
  '.dockerfile': 'Dockerfile',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.astro': 'Astro',
};

/**
 * Detect language from a filename.
 */
export function detectLanguage(filename: string): string {
  const lower = filename.toLowerCase();

  // Special filenames
  if (lower === 'dockerfile') return 'Dockerfile';
  if (lower === 'makefile') return 'Makefile';
  if (lower === '.gitignore') return 'Gitignore';

  const ext = lower.lastIndexOf('.') >= 0
    ? lower.substring(lower.lastIndexOf('.'))
    : '';

  return EXTENSION_LANGUAGE_MAP[ext] || 'Unknown';
}

/**
 * Parse a raw unified diff string into structured ParsedDiff.
 */
export function parseDiff(rawDiff: string): ParsedDiff {
  logger.info({ diffSize: rawDiff.length }, 'Parsing raw diff');

  const files: ParsedDiffFile[] = [];
  const stats: DiffStats = {
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    byStatus: {},
    byLanguage: {},
  };

  // Split the diff into file sections
  // Each file section starts with "diff --git"
  const fileSections = splitDiffIntoFiles(rawDiff);

  for (const section of fileSections) {
    const parsedFile = parseFileSection(section);
    if (parsedFile) {
      files.push(parsedFile);

      // Update stats
      stats.filesChanged++;
      stats.additions += parsedFile.additions;
      stats.deletions += parsedFile.deletions;
      stats.byStatus[parsedFile.status] = (stats.byStatus[parsedFile.status] || 0) + 1;
      stats.byLanguage[parsedFile.language] = (stats.byLanguage[parsedFile.language] || 0) + 1;
    }
  }

  logger.info(
    {
      files: stats.filesChanged,
      additions: stats.additions,
      deletions: stats.deletions,
    },
    'Diff parsing complete',
  );

  return {
    raw: rawDiff,
    files,
    stats,
  };
}

/**
 * Split raw diff into per-file sections.
 */
function splitDiffIntoFiles(rawDiff: string): string[] {
  const sections: string[] = [];
  const lines = rawDiff.split('\n');

  let currentSection: string[] = [];

  for (const line of lines) {
    // A new file section starts with "diff --git"
    if (line.startsWith('diff --git')) {
      if (currentSection.length > 0) {
        sections.push(currentSection.join('\n'));
      }
      currentSection = [line];
    } else if (currentSection.length > 0) {
      currentSection.push(line);
    }
  }

  // Don't forget the last section
  if (currentSection.length > 0) {
    sections.push(currentSection.join('\n'));
  }

  return sections;
}

/**
 * Parse a single file section from a diff.
 */
function parseFileSection(section: string): ParsedDiffFile | null {
  const lines = section.split('\n');

  // Skip empty sections
  if (lines.length === 0) return null;

  // Parse file info from the header
  const headerInfo = parseFileHeader(lines);
  if (!headerInfo) return null;

  // Parse hunks (lines starting with @@)
  const hunks = parseHunks(lines);

  // Count additions and deletions
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') additions++;
      if (line.type === 'delete') deletions++;
    }
  }

  return {
    filename: headerInfo.filename,
    oldFilename: headerInfo.oldFilename,
    status: headerInfo.status,
    hunks,
    language: detectLanguage(headerInfo.filename),
    additions,
    deletions,
  };
}

interface FileHeaderInfo {
  filename: string;
  oldFilename?: string;
  status: ParsedDiffFile['status'];
}

/**
 * Parse file header information from diff section.
 */
function parseFileHeader(lines: string[]): FileHeaderInfo | null {
  let filename = '';
  let oldFilename: string | undefined;
  let status: ParsedDiffFile['status'] = 'modified';

  for (const line of lines) {
    // diff --git a/file b/file
    if (line.startsWith('diff --git')) {
      const match = line.match(/diff --git a\/(.+) b\/(.+)/);
      if (match) {
        oldFilename = match[1];
        filename = match[2];

        if (oldFilename !== filename) {
          // Check if it's a rename (both files exist but different names)
          if (oldFilename !== '/dev/null' && filename !== '/dev/null') {
            status = 'renamed';
          }
        }
      }
      continue;
    }

    // --- a/file (deleted file indicator)
    if (line.startsWith('--- a/')) {
      const file = line.replace('--- a/', '');
      if (file === '/dev/null') {
        status = 'added';
      }
      if (!oldFilename || oldFilename === '/dev/null') {
        oldFilename = file;
      }
      continue;
    }

    // +++ b/file (added file indicator)
    if (line.startsWith('+++ b/')) {
      const file = line.replace('+++ b/', '');
      if (file === '/dev/null') {
        status = 'removed';
      }
      if (!filename || filename === '/dev/null') {
        filename = file;
      }
      continue;
    }

    // new file mode
    if (line.startsWith('new file mode')) {
      status = 'added';
      continue;
    }

    // deleted file mode
    if (line.startsWith('deleted file mode')) {
      status = 'removed';
      continue;
    }

    // renamed from / to
    if (line.startsWith('rename from ')) {
      status = 'renamed';
      continue;
    }
  }

  if (!filename) return null;

  return { filename, oldFilename, status };
}

/**
 * Parse hunks from file section lines.
 */
function parseHunks(lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;

  for (const line of lines) {
    // Match hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)?/);

    if (hunkMatch) {
      // Save previous hunk
      if (currentHunk) {
        hunks.push(currentHunk);
      }

      const oldStart = parseInt(hunkMatch[1], 10);
      const oldLines = parseInt(hunkMatch[2] || '1', 10);
      const newStart = parseInt(hunkMatch[3], 10);
      const newLines = parseInt(hunkMatch[4] || '1', 10);

      currentHunk = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        header: line,
        lines: [],
      };
      continue;
    }

    // Parse individual lines
    if (currentHunk) {
      let oldLineNum = currentHunk.oldStart;
      for (const l of currentHunk.lines) {
        if (l.type !== 'add') oldLineNum++;
      }

      let newLineNum = currentHunk.newStart;
      for (const l of currentHunk.lines) {
        if (l.type !== 'delete') newLineNum++;
      }

      if (line.startsWith('+')) {
        currentHunk.lines.push({
          type: 'add',
          content: line.substring(1),
          newLineNumber: newLineNum,
        });
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({
          type: 'delete',
          content: line.substring(1),
          oldLineNumber: oldLineNum,
        });
      } else if (line.startsWith(' ') || line === '') {
        currentHunk.lines.push({
          type: 'context',
          content: line.startsWith(' ') ? line.substring(1) : line,
          oldLineNumber: oldLineNum,
          newLineNumber: newLineNum,
        });
      }
      // Lines like '\ No newline at end of file' are skipped
    }
  }

  // Save the last hunk
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * Convert PRFile[] from GitHub API into ParsedDiffFile[].
 */
export function parsePRFiles(prFiles: PRFile[]): ParsedDiff {
  const files: ParsedDiffFile[] = [];
  const stats: DiffStats = {
    filesChanged: prFiles.length,
    additions: 0,
    deletions: 0,
    byStatus: {},
    byLanguage: {},
  };

  for (const prFile of prFiles) {
    const language = detectLanguage(prFile.filename);
    const hunks: DiffHunk[] = [];

    // Parse patch into hunks if available
    if (prFile.patch) {
      const lines = prFile.patch.split('\n');
      const parsedHunks = parseHunks(lines);
      hunks.push(...parsedHunks);
    }

    const parsedFile: ParsedDiffFile = {
      filename: prFile.filename,
      oldFilename: prFile.previousFilename,
      status: prFile.status,
      hunks,
      language,
      additions: prFile.additions,
      deletions: prFile.deletions,
    };

    files.push(parsedFile);

    stats.additions += prFile.additions;
    stats.deletions += prFile.deletions;
    stats.byStatus[prFile.status] = (stats.byStatus[prFile.status] || 0) + 1;
    stats.byLanguage[language] = (stats.byLanguage[language] || 0) + 1;
  }

  return {
    raw: '', // Not available from PRFiles
    files,
    stats,
  };
}

/**
 * Get a compact summary of diff for display or context insertion.
 */
export function summarizeDiff(
  parsedDiff: ParsedDiff,
  maxLines: number = 200,
): string {
  const lines: string[] = [];
  let lineCount = 0;

  lines.push('# PR Change Summary');
  lines.push('');
  lines.push(`Files changed: ${parsedDiff.stats.filesChanged}`);
  lines.push(`Additions: +${parsedDiff.stats.additions}`);
  lines.push(`Deletions: -${parsedDiff.stats.deletions}`);
  lines.push('');

  for (const file of parsedDiff.files) {
    if (lineCount >= maxLines) {
      lines.push(`\n... (truncated, ${parsedDiff.files.length - parsedDiff.files.indexOf(file)} more files)`);
      break;
    }

    const statusIcon = {
      added: `[ADDED]`,
      modified: `[MODIFIED]`,
      removed: `[REMOVED]`,
      renamed: `[RENAMED]`,
      copied: `[COPIED]`,
      changed: `[CHANGED]`,
      unchanged: `[UNCHANGED]`,
    }[file.status] || `[${file.status.toUpperCase()}]`;

    lines.push(`### ${statusIcon} ${file.filename} (${file.language})`);
    lines.push(`+${file.additions} -${file.deletions}`);
    lines.push('');

    for (const hunk of file.hunks) {
      for (const diffLine of hunk.lines) {
        if (lineCount >= maxLines) break;

        const prefix = {
          add: '+',
          delete: '-',
          context: ' ',
        }[diffLine.type];

        lines.push(`${prefix} ${diffLine.content}`);
        lineCount++;
      }
      if (lineCount >= maxLines) break;
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Filter diff to only include specific file extensions.
 */
export function filterDiffByExtension(
  parsedDiff: ParsedDiff,
  extensions: string[],
): ParsedDiff {
  const filteredFiles = parsedDiff.files.filter((f) => {
    const ext = f.filename.toLowerCase().substring(f.filename.lastIndexOf('.'));
    return extensions.includes(ext);
  });

  const stats: DiffStats = {
    filesChanged: filteredFiles.length,
    additions: filteredFiles.reduce((sum, f) => sum + f.additions, 0),
    deletions: filteredFiles.reduce((sum, f) => sum + f.deletions, 0),
    byStatus: {},
    byLanguage: {},
  };

  for (const f of filteredFiles) {
    stats.byStatus[f.status] = (stats.byStatus[f.status] || 0) + 1;
    stats.byLanguage[f.language] = (stats.byLanguage[f.language] || 0) + 1;
  }

  return {
    raw: parsedDiff.raw,
    files: filteredFiles,
    stats,
  };
}

/**
 * Check if the diff is empty (no changes).
 */
export function isDiffEmpty(parsedDiff: ParsedDiff): boolean {
  return parsedDiff.files.length === 0;
}

/**
 * Get the list of unique file extensions changed.
 */
export function getChangedExtensions(parsedDiff: ParsedDiff): string[] {
  const extensions = new Set<string>();
  for (const file of parsedDiff.files) {
    const ext = file.filename.toLowerCase().substring(file.filename.lastIndexOf('.'));
    extensions.add(ext);
  }
  return Array.from(extensions);
}

export default {
  parseDiff,
  parsePRFiles,
  detectLanguage,
  summarizeDiff,
  filterDiffByExtension,
  isDiffEmpty,
  getChangedExtensions,
};
