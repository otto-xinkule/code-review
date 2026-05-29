import type { TokenBudget, ParsedDiff, FileContext, AnalysisChunk } from '../types/index.js';
import { logger } from '../utility/logger.js';
import { getConfig } from '../config/index.js';
import { estimateTokenCount } from '../collectors/context-aggregator.js';

/**
 * Token Budget Manager
 *
 * Manages the token allocation across different parts of the prompt:
 * system prompt, context, diff content, history, and reserved space.
 * Ensures we stay within model limits and don't exceed budgets.
 */

/**
 * Create a new token budget with default allocations.
 */
export function createTokenBudget(totalBudget?: number): TokenBudget {
  const config = getConfig();
  const maxTokens = totalBudget || config.review.tokenBudget;

  return {
    maxTokens,
    usedTokens: 0,
    remainingTokens: maxTokens,
    allocation: {
      system: Math.floor(maxTokens * 0.05),    // 5% for system prompt
      context: Math.floor(maxTokens * 0.15),   // 15% for PR context
      diff: Math.floor(maxTokens * 0.60),      // 60% for diff content
      history: Math.floor(maxTokens * 0.10),   // 10% for review history
      reserved: Math.floor(maxTokens * 0.10),  // 10% reserved for output
    },
  };
}

/**
 * Check if adding a piece of content would exceed the budget.
 */
export function wouldExceedBudget(
  budget: TokenBudget,
  content: string,
  allocation: 'system' | 'context' | 'diff' | 'history' | 'reserved',
): boolean {
  const estimatedTokens = estimateTokenCount(content);
  const currentAllocation = budget.allocation[allocation];

  return estimatedTokens > currentAllocation * 1.2; // Allow 20% overflow
}

/**
 * Reserve tokens for a specific allocation.
 */
export function reserveTokens(
  budget: TokenBudget,
  allocation: 'system' | 'context' | 'diff' | 'history' | 'reserved',
  tokens: number,
): void {
  budget.allocation[allocation] -= tokens;
  budget.usedTokens += tokens;
  budget.remainingTokens = budget.maxTokens - budget.usedTokens;
}

/**
 * Get remaining tokens for a specific allocation.
 */
export function getRemainingAllocation(
  budget: TokenBudget,
  allocation: 'system' | 'context' | 'diff' | 'history' | 'reserved',
): number {
  return Math.max(0, budget.allocation[allocation]);
}

/**
 * Log the current budget status.
 */
export function logBudgetStatus(budget: TokenBudget): void {
  logger.debug(
    {
      maxTokens: budget.maxTokens,
      usedTokens: budget.usedTokens,
      remainingTokens: budget.remainingTokens,
      allocation: budget.allocation,
    },
    'Token budget status',
  );
}

// ============================================================
// Diff Chunking Strategy
// ============================================================

interface ChunkOptions {
  /** Maximum files per chunk */
  maxFilesPerChunk?: number;
  /** Maximum tokens per chunk */
  maxTokensPerChunk?: number;
  /** Whether to group related files (same directory) */
  groupRelated?: boolean;
}

/**
 * Split a large parsed diff into manageable chunks for AI analysis.
 * Each chunk should fit within the model's context window.
 */
export function chunkDiff(
  parsedDiff: ParsedDiff,
  options: ChunkOptions = {},
): AnalysisChunk[] {
  const config = getConfig();
  const maxFilesPerChunk = options.maxFilesPerChunk || config.review.maxFilesPerChunk;
  const maxTokensPerChunk = options.maxTokensPerChunk || config.review.tokenBudget;
  const groupRelated = options.groupRelated !== false;

  const fileContexts = parsedDiff.files.map((file) => ({
    filename: file.filename,
    language: file.language,
    diff: file,
  }));

  if (fileContexts.length <= maxFilesPerChunk) {
    // Single chunk is sufficient
    return [
      {
        id: 'chunk-01',
        files: fileContexts as FileContext[],
        tokenCount: estimateTotalTokens(fileContexts),
        index: 0,
        totalChunks: 1,
      },
    ];
  }

  // Sort files: largest changes first
  const sorted = [...fileContexts].sort(
    (a, b) => (b.diff.additions + b.diff.deletions) - (a.diff.additions + a.diff.deletions),
  );

  const chunks: AnalysisChunk[] = [];
  let currentChunk: FileContext[] = [];
  let currentTokens = 0;

  for (const fc of sorted) {
    const fileTokens = estimateFileTokens(fc);

    // Check if adding this file would exceed limits
    const wouldExceedFiles = currentChunk.length >= maxFilesPerChunk;
    const wouldExceedTokens = currentTokens + fileTokens > maxTokensPerChunk * 0.8;

    if (currentChunk.length > 0 && (wouldExceedFiles || wouldExceedTokens)) {
      chunks.push({
        id: formatChunkId(chunks.length + 1),
        files: [...currentChunk],
        tokenCount: currentTokens,
        index: chunks.length,
        totalChunks: 0, // Will be updated after all chunks are created
      });
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(fc);
    currentTokens += fileTokens;
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      id: formatChunkId(chunks.length + 1),
      files: [...currentChunk],
      tokenCount: currentTokens,
      index: chunks.length,
      totalChunks: 0,
    });
  }

  // Update total chunk count
  for (const chunk of chunks) {
    chunk.totalChunks = chunks.length;
  }

  logger.info(
    {
      totalFiles: fileContexts.length,
      chunks: chunks.length,
      sizes: chunks.map((c) => `${c.files.length}f/${c.tokenCount}t`),
    },
    'Diff chunked for analysis',
  );

  return chunks;
}

/**
 * Estimate tokens for a single file.
 */
function estimateFileTokens(fc: { diff: { additions: number; deletions: number }; filename: string }): number {
  // Rough estimate: additions + deletions + filename + metadata
  const changeTokens = estimateTokenCount(
    `filename: ${fc.filename}\nadditions: ${fc.diff.additions}\ndeletions: ${fc.diff.deletions}\n`,
  );
  return changeTokens + (fc.diff.additions + fc.diff.deletions) * 2;
}

/**
 * Estimate total tokens for a set of file contexts.
 */
function estimateTotalTokens(fileContexts: { diff: { additions: number; deletions: number }; filename: string }[]): number {
  return fileContexts.reduce((sum, fc) => sum + estimateFileTokens(fc), 0);
}

/**
 * Format a chunk ID with zero padding.
 */
function formatChunkId(index: number, total?: number): string {
  if (total && total > 99) return `chunk-${String(index).padStart(3, '0')}`;
  return `chunk-${String(index).padStart(2, '0')}`;
}

/**
 * Determine if chunking is needed based on PR size.
 */
export function shouldChunk(
  parsedDiff: ParsedDiff,
  threshold?: number,
): boolean {
  const config = getConfig();
  const maxFiles = threshold || config.review.maxFilesPerChunk;

  return parsedDiff.files.length > maxFiles ||
    (parsedDiff.stats.additions + parsedDiff.stats.deletions) > 2000;
}

/**
 * Merge analysis results from multiple chunks.
 */
export function mergeChunkResults<T extends { id?: string; file?: string }>(
  chunkResults: T[],
  deduplicateBy?: keyof T,
): T[] {
  if (!deduplicateBy) return chunkResults;

  const seen = new Set<unknown>();
  const merged: T[] = [];

  for (const result of chunkResults) {
    const key = result[deduplicateBy];
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(result);
    }
  }

  return merged;
}

export default {
  createTokenBudget,
  wouldExceedBudget,
  reserveTokens,
  getRemainingAllocation,
  logBudgetStatus,
  chunkDiff,
  shouldChunk,
  mergeChunkResults,
};
