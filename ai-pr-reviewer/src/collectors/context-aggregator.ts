import type {
  ParsedDiff,
  ParsedDiffFile,
  FileContext,
  ImportInfo,
  SymbolInfo,
  PRMetadata,
  AggregatedContext,
  ContextLevel,
  ContextPolicy,
} from '../types/index.js';
import { logger } from '../utility/logger.js';
import { getConfig } from '../config/index.js';
import { detectLanguage } from './diff-parser.js';
import { getPRComments } from './github-api.js';

/**
 * Context Aggregator Module
 *
 * Assembles rich context for AI analysis by combining:
 * - Diff information
 * - File contents (when available)
 * - Import/dependency graphs
 * - Historical PR comments
 * - Linked issue descriptions
 *
 * Implements the L1-L4 context layering strategy.
 */

/**
 * Build aggregated context for AI analysis based on configured policy.
 */
export async function buildContext(
  parsedDiff: ParsedDiff,
  prMetadata: PRMetadata,
  policy?: ContextPolicy,
  fileContents?: Map<string, string>,
  linkedIssueData?: Array<{ number: number; title: string; body: string }>,
): Promise<AggregatedContext> {
  const config = getConfig();
  const effectivePolicy = policy || config.context.levels[config.context.defaultLevel];

  logger.info(
    { level: effectivePolicy.level, files: parsedDiff.files.length },
    'Building context',
  );

  const fileContexts = await buildFileContexts(parsedDiff, effectivePolicy, fileContents);
  const contextContent = assembleContextString(
    fileContexts,
    prMetadata,
    effectivePolicy,
    linkedIssueData,
  );

  const tokenCount = estimateTokenCount(contextContent);

  logger.info(
    { level: effectivePolicy.level, tokens: tokenCount, files: fileContexts.length },
    'Context built',
  );

  return {
    level: effectivePolicy.level,
    content: contextContent,
    tokenCount,
    metadata: {
      includedFiles: fileContexts.length,
      dependencyFiles: fileContexts.reduce((sum, f) => sum + (f.imports ? 1 : 0), 0),
      relatedIssues: linkedIssueData?.length || 0,
      wasTruncated: tokenCount > effectivePolicy.maxTokens,
    },
  };
}

/**
 * Build file contexts from parsed diff.
 * Optionally enriches with full file content and dependency info.
 */
async function buildFileContexts(
  parsedDiff: ParsedDiff,
  policy: ContextPolicy,
  fileContents?: Map<string, string>,
): Promise<FileContext[]> {
  const contexts: FileContext[] = [];
  const maxFiles = policy.maxFiles || 50;

  for (const file of parsedDiff.files.slice(0, maxFiles)) {
    const content = policy.includeFullFiles
      ? fileContents?.get(file.filename)
      : undefined;

    const fileContext: FileContext = {
      filename: file.filename,
      language: detectLanguage(file.filename),
      content,
      diff: file,
      imports: policy.includeDependencies ? extractImports(file) : undefined,
      exports: policy.includeDependencies ? extractExports(file) : undefined,
      symbols: policy.includeDependencies ? extractSymbols(file) : undefined,
    };

    contexts.push(fileContext);
  }

  if (parsedDiff.files.length > maxFiles) {
    logger.warn(
      { total: parsedDiff.files.length, included: maxFiles },
      'Truncated files due to policy limit',
    );
  }

  return contexts;
}

/**
 * Assemble the final context string from all gathered data.
 */
function assembleContextString(
  fileContexts: FileContext[],
  prMetadata: PRMetadata,
  policy: ContextPolicy,
  linkedIssueData?: Array<{ number: number; title: string; body: string }>,
): string {
  const parts: string[] = [];

  // === HEADER ===
  parts.push('=== PULL REQUEST CONTEXT ===');
  parts.push('');

  // === PR METADATA ===
  parts.push('## PR Information');
  parts.push(`Title: ${prMetadata.title}`);
  parts.push(`Author: ${prMetadata.author}`);
  parts.push(`Branch: ${prMetadata.headBranch} → ${prMetadata.baseBranch}`);
  parts.push(`State: ${prMetadata.state}`);
  parts.push(`Changed Files: ${prMetadata.changedFiles}`);
  parts.push(`Additions: +${prMetadata.additions} / Deletions: -${prMetadata.deletions}`);
  parts.push(`Labels: ${prMetadata.labels.join(', ') || 'none'}`);
  parts.push('');

  // === PR BODY ===
  if (policy.includePRBody && prMetadata.body) {
    parts.push('## PR Description');
    parts.push(truncateText(prMetadata.body, 2000));
    parts.push('');
  }

  // === LINKED ISSUES ===
  if (policy.includeIssues && linkedIssueData && linkedIssueData.length > 0) {
    parts.push('## Linked Issues');
    for (const issue of linkedIssueData) {
      parts.push(`### #${issue.number}: ${issue.title}`);
      parts.push(truncateText(issue.body, 500));
      parts.push('');
    }
  }

  // === FILE CHANGES ===
  parts.push('## File Changes');
  parts.push('');

  for (const fc of fileContexts) {
    parts.push(formatFileContext(fc, policy));
    parts.push('');
  }

  // === DEPENDENCY INFO ===
  if (policy.includeDependencies) {
    const allImports = fileContexts
      .filter((f) => f.imports && f.imports.length > 0)
      .flatMap((f) => f.imports!);

    if (allImports.length > 0) {
      parts.push('## Dependency Changes');
      const uniqueImports = deduplicateImports(allImports);
      for (const imp of uniqueImports) {
        parts.push(`- ${imp.source} (${imp.names.join(', ')})`);
      }
      parts.push('');
    }

    const allSymbols = fileContexts
      .filter((f) => f.symbols && f.symbols.length > 0 && f.symbols.some((s) => s.modified))
      .flatMap((f) => f.symbols!.filter((s) => s.modified).map((s) => `${f.filename}: ${s.name} (${s.type})`));

    if (allSymbols.length > 0) {
      parts.push('## Modified Symbols');
      for (const sym of allSymbols.slice(0, 30)) {
        parts.push(`- ${sym}`);
      }
      parts.push('');
    }
  }

  parts.push('=== END CONTEXT ===');

  return parts.join('\n');
}

/**
 * Format a single file's context for inclusion.
 */
function formatFileContext(fc: FileContext, policy: ContextPolicy): string {
  const parts: string[] = [];

  const statusIcon = {
    added: '[+]',
    modified: '[~]',
    removed: '[-]',
    renamed: '[>]',
    copied: '[=]',
    changed: '[~]',
    unchanged: '[ ]',
  }[fc.diff.status] || '';

  parts.push(`### ${statusIcon} ${fc.filename} (${fc.language})`);
  parts.push(`Changes: +${fc.diff.additions} -${fc.diff.deletions}`);

  // Show imports if available
  if (policy.includeDependencies && fc.imports && fc.imports.length > 0) {
    const importSummary = fc.imports.map((i) => i.source).join(', ');
    parts.push(`Dependencies: ${importSummary}`);
  }

  // Show modified symbols
  if (fc.symbols && fc.symbols.some((s) => s.modified)) {
    const modifiedSyms = fc.symbols.filter((s) => s.modified).map((s) => s.name);
    parts.push(`Modified: ${modifiedSyms.join(', ')}`);
  }

  parts.push('');
  parts.push('```' + getMarkdownLanguage(fc.language));

  // Show full file content or just the diff
  if (policy.includeFullFiles && fc.content) {
    parts.push(truncateText(fc.content, 3000));
  } else {
    // Show the diff hunks
    for (const hunk of fc.diff.hunks.slice(0, 10)) {
      parts.push(hunk.header);
      for (const line of hunk.lines.slice(0, 30)) {
        const prefix = { add: '+', delete: '-', context: ' ' }[line.type];
        parts.push(`${prefix}${line.content}`);
      }
    }
    if (fc.diff.hunks.length > 10) {
      parts.push(`\n... (${fc.diff.hunks.length - 10} more hunks)`);
    }
  }

  parts.push('```');

  return parts.join('\n');
}

/**
 * Extract import information from a parsed diff file.
 */
function extractImports(file: ParsedDiffFile): ImportInfo[] {
  const imports: ImportInfo[] = [];

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'delete') continue;

      const content = line.content.trim();

      // JavaScript/TypeScript imports
      const jsImport = content.match(
        /^(?:import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)?\s+from\s+)?['"]([^'"]+)['"]|(?:const|let|var)\s+(?:\{[^}]*\}|\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\))/,
      );
      if (jsImport) {
        const source = jsImport[1] || jsImport[2];
        imports.push({
          source,
          names: extractImportNames(content),
          isDefault: content.includes('import ') && !content.includes('{'),
        });
        continue;
      }

      // Python imports
      const pyImport = content.match(
        /^(?:from\s+([\w.]+)\s+import\s+|import\s+([\w.]+))/,
      );
      if (pyImport) {
        const source = pyImport[1] || pyImport[2];
        imports.push({
          source,
          names: extractImportNames(content),
          isDefault: false,
        });
        continue;
      }

      // Go imports
      const goImport = content.match(/^"(.*?)"$/);
      if (goImport && content.trimStart().startsWith('"')) {
        imports.push({
          source: goImport[1],
          names: [],
          isDefault: false,
        });
      }
    }
  }

  return deduplicateImports(imports);
}

/**
 * Extract import names from an import statement.
 */
function extractImportNames(statement: string): string[] {
  const names: string[] = [];

  // Named imports { a, b, c }
  const namedMatch = statement.match(/\{\s*([^}]+)\s*\}/);
  if (namedMatch) {
    const named = namedMatch[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]);
    names.push(...named);
  }

  // Default import
  const defaultMatch = statement.match(
    /import\s+(\w+)\s+from|import\s+(\w+)/,
  );
  if (defaultMatch) {
    const name = defaultMatch[1] || defaultMatch[2];
    if (name && name !== 'type' && name !== 'from') {
      names.push(name);
    }
  }

  return names.filter((n) => n && !['type', 'from', 'as'].includes(n));
}

/**
 * Extract exported symbols from a parsed diff file.
 */
function extractExports(file: ParsedDiffFile): string[] {
  const exports: string[] = [];

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'delete') continue;

      const content = line.content.trim();

      // JS/TS exports
      const exportMatch = content.match(
        /export\s+(?:(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)|{\s*([^}]+)\s*})/,
      );
      if (exportMatch) {
        if (exportMatch[1]) {
          exports.push(exportMatch[1]);
        } else if (exportMatch[2]) {
          const names = exportMatch[2].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]);
          exports.push(...names);
        }
      } else if (content === 'export default' || content.startsWith('export default ')) {
        exports.push('default');
      }
    }
  }

  return [...new Set(exports)];
}

/**
 * Extract key symbols (functions, classes) from a parsed diff file.
 */
function extractSymbols(file: ParsedDiffFile): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  let lineNum = 0;

  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      lineNum++;
      const content = line.content.trim();

      const symbolMatch = content.match(
        /^(?:export\s+)?(?:async\s+)?(?:function|class)\s+(\w+)|^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/,
      );

      if (symbolMatch) {
        const name = symbolMatch[1] || symbolMatch[2];
        const type = content.includes('class')
          ? 'class'
          : 'function';

        symbols.push({
          name,
          type: type as SymbolInfo['type'],
          modified: line.type === 'add',
          range: { start: lineNum, end: lineNum },
        });
      }

      // Interface/type
      const typeMatch = content.match(/^(?:export\s+)?(?:interface|type|enum)\s+(\w+)/);
      if (typeMatch) {
        symbols.push({
          name: typeMatch[1],
          type: content.includes('interface') ? 'interface' : 'type',
          modified: line.type === 'add',
          range: { start: lineNum, end: lineNum },
        });
      }
    }
  }

  return symbols;
}

/**
 * Deduplicate imports by source module.
 */
function deduplicateImports(imports: ImportInfo[]): ImportInfo[] {
  const map = new Map<string, ImportInfo>();

  for (const imp of imports) {
    const existing = map.get(imp.source);
    if (existing) {
      // Merge names
      existing.names = [...new Set([...existing.names, ...imp.names])];
    } else {
      map.set(imp.source, { ...imp });
    }
  }

  return Array.from(map.values());
}

/**
 * Estimate token count from text.
 * Rough approximation: ~4 characters per token.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Get the selection policy for a given context level.
 */
export function getContextPolicy(level: ContextLevel): ContextPolicy {
  const config = getConfig();
  return config.context.levels[level];
}

/**
 * Select the appropriate context level based on PR characteristics.
 */
export function selectContextLevel(
  fileCount: number,
  totalChanges: number,
  hasComplexChanges: boolean,
): ContextLevel {
  if (fileCount <= 3 && totalChanges < 200) {
    return 'L1';
  }
  if (fileCount <= 15 && totalChanges < 1000) {
    return 'L2';
  }
  if (hasComplexChanges) {
    return 'L4';
  }
  return 'L3';
}

/**
 * Get the markdown language identifier for syntax highlighting.
 */
function getMarkdownLanguage(language: string): string {
  const map: Record<string, string> = {
    'TypeScript': 'typescript',
    'TypeScript React': 'tsx',
    'JavaScript': 'javascript',
    'JavaScript React': 'jsx',
    'Python': 'python',
    'Java': 'java',
    'Go': 'go',
    'Rust': 'rust',
    'Ruby': 'ruby',
    'PHP': 'php',
    'C#': 'csharp',
    'C++': 'cpp',
    'C': 'c',
    'Swift': 'swift',
    'Kotlin': 'kotlin',
    'SQL': 'sql',
    'Shell': 'bash',
    'YAML': 'yaml',
    'JSON': 'json',
    'XML': 'xml',
    'HTML': 'html',
    'CSS': 'css',
    'SCSS': 'scss',
    'Markdown': 'markdown',
    'GraphQL': 'graphql',
    'Dockerfile': 'dockerfile',
    'Vue': 'vue',
    'Svelte': 'svelte',
  };
  return map[language] || '';
}

/**
 * Truncate text to a maximum length while preserving word boundaries.
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.substring(0, maxLength - 3);
  const lastSpace = truncated.lastIndexOf(' ');
  const cutPoint = lastSpace > maxLength * 0.8 ? lastSpace : maxLength - 3;
  return text.substring(0, cutPoint) + '...';
}

export default {
  buildContext,
  getContextPolicy,
  selectContextLevel,
  estimateTokenCount,
};
