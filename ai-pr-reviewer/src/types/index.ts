/**
 * AI PR Review - Core Type Definitions
 *
 * Comprehensive type system covering PR metadata, diff parsing,
 * risk detection, AI model interactions, and output formatting.
 */

// ============================================================
// GitHub PR Related Types
// ============================================================

export interface PRMetadata {
  /** GitHub owner/repo */
  repository: string;
  /** PR number */
  prNumber: number;
  /** PR title */
  title: string;
  /** PR body/description */
  body: string | null;
  /** Author username */
  author: string;
  /** Base branch (target) */
  baseBranch: string;
  /** Head branch (source) */
  headBranch: string;
  /** Base commit SHA */
  baseSha: string;
  /** Head commit SHA */
  headSha: string;
  /** PR state (open, closed, merged) */
  state: 'open' | 'closed' | 'merged';
  /** Whether PR is a draft */
  isDraft: boolean;
  /** Labels applied to the PR */
  labels: string[];
  /** Linked issues (if any) */
  linkedIssues: number[];
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
  /** Total additions */
  additions: number;
  /** Total deletions */
  deletions: number;
  /** Changed files count */
  changedFiles: number;
  /** Whether this is an update to an existing PR */
  isUpdate: boolean;
}

export interface PRFile {
  /** File path relative to repo root */
  filename: string;
  /** File status */
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  /** Number of additions */
  additions: number;
  /** Number of deletions */
  deletions: number;
  /** Number of changes */
  changes: number;
  /** Raw diff/patch content */
  patch: string | null;
  /** Previous filename (for renamed files) */
  previousFilename?: string;
  /** Raw URL to file contents on base ref */
  contentsUrl: string;
  /** SHA of the file's blob */
  sha: string;
}

export interface PREvent {
  /** Event action */
  action: 'opened' | 'synchronize' | 'reopened' | 'closed';
  /** PR metadata */
  pr: PRMetadata;
  /** Associated repository info */
  repository: {
    owner: string;
    repo: string;
    defaultBranch: string;
  };
  /** Installation ID (GitHub App) */
  installationId?: number;
}

// ============================================================
// Diff Parsing Types
// ============================================================

export interface ParsedDiff {
  /** Original raw diff string */
  raw: string;
  /** Parsed file-level diffs */
  files: ParsedDiffFile[];
  /** Overall statistics */
  stats: DiffStats;
}

export interface ParsedDiffFile {
  /** File path */
  filename: string;
  /** Previous filename (for renames) */
  oldFilename?: string;
  /** File status */
  status: PRFile['status'];
  /** Hunks in this file */
  hunks: DiffHunk[];
  /** Language detected from file extension */
  language: string;
  /** Total additions in this file */
  additions: number;
  /** Total deletions in this file */
  deletions: number;
}

export interface DiffHunk {
  /** Original file line range */
  oldStart: number;
  oldLines: number;
  /** New file line range */
  newStart: number;
  newLines: number;
  /** Hunk header (e.g., @@ -1,5 +1,7 @@) */
  header: string;
  /** Individual lines in the hunk */
  lines: DiffLine[];
  /** Context around the hunk (pre/post context) */
  context?: DiffContext;
}

export interface DiffLine {
  /** Line type */
  type: 'add' | 'delete' | 'context';
  /** Line content (without +/- prefix) */
  content: string;
  /** Original line number (undefined for additions) */
  oldLineNumber?: number;
  /** New line number (undefined for deletions) */
  newLineNumber?: number;
}

export interface DiffContext {
  /** Pre-hunk context lines (from full file) */
  before: string[];
  /** Post-hunk context lines (from full file) */
  after: string[];
}

export interface DiffStats {
  /** Total files changed */
  filesChanged: number;
  /** Total additions */
  additions: number;
  /** Total deletions */
  deletions: number;
  /** Distribution by file status */
  byStatus: Record<string, number>;
  /** Distribution by language */
  byLanguage: Record<string, number>;
}

// ============================================================
// Context Aggregation Types
// ============================================================

export type ContextLevel = 'L1' | 'L2' | 'L3' | 'L4';

export interface AggregatedContext {
  /** Context level used */
  level: ContextLevel;
  /** The assembled prompt context string */
  content: string;
  /** Token count of the content */
  tokenCount: number;
  /** Metadata about what's included */
  metadata: {
    /** Number of files included */
    includedFiles: number;
    /** Number of dependency files included */
    dependencyFiles: number;
    /** Number of related issues included */
    relatedIssues: number;
    /** Truncation applied */
    wasTruncated: boolean;
  };
}

export interface ContextPolicy {
  /** Target context level */
  level: ContextLevel;
  /** Max tokens for this level */
  maxTokens: number;
  /** Whether to include full files */
  includeFullFiles: boolean;
  /** Whether to include dependency info */
  includeDependencies: boolean;
  /** Whether to include issue descriptions */
  includeIssues: boolean;
  /** Whether to include PR body */
  includePRBody: boolean;
  /** Max files to include when not including full files */
  maxFiles?: number;
}

export interface FileContext {
  /** File path */
  filename: string;
  /** File language */
  language: string;
  /** Raw file content (base version) */
  content?: string;
  /** Parsed diff */
  diff: ParsedDiffFile;
  /** Import/dependency information */
  imports?: ImportInfo[];
  /** Exported symbols */
  exports?: string[];
  /** Key functions/classes in the file */
  symbols?: SymbolInfo[];
}

export interface ImportInfo {
  /** Import source module */
  source: string;
  /** Imported names */
  names: string[];
  /** Whether it's a default import */
  isDefault: boolean;
}

export interface SymbolInfo {
  /** Symbol name */
  name: string;
  /** Symbol type */
  type: 'function' | 'class' | 'variable' | 'interface' | 'type' | 'enum';
  /** Whether the symbol was modified in this PR */
  modified: boolean;
  /** Line number range */
  range: { start: number; end: number };
}

// ============================================================
// Risk Detection Types
// ============================================================

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Confidence = 'high' | 'medium' | 'low';
export type RiskCategory =
  | 'security'
  | 'performance'
  | 'bug'
  | 'logic'
  | 'maintainability';

export interface RiskIssue {
  /** Unique issue ID */
  id: string;
  /** Risk category */
  category: RiskCategory;
  /** Severity level */
  severity: Severity;
  /** AI confidence in this finding */
  confidence: Confidence;
  /** Short title */
  title: string;
  /** Detailed description */
  description: string;
  /** File where the issue was found */
  file: string;
  /** Line range where issue occurs */
  lineRange: {
    start: number;
    end: number;
  };
  /** The problematic code snippet */
  codeSnippet: string;
  /** Suggested fix */
  suggestion: string | null;
  /** Risk score (0-100) */
  score: number;
  /** Related CWE/rule IDs */
  ruleIds?: string[];
  /** Whether this was machine-verified (e.g., by static analysis) */
  verifiedByTool?: boolean;
  /** Verification tool name */
  verificationTool?: string;
}

export interface RiskReport {
  /** Overall risk assessment */
  summary: string;
  /** Risk score (0-100) */
  overallScore: number;
  /** Detected issues */
  issues: RiskIssue[];
  /** Statistics by category */
  byCategory: Record<RiskCategory, number>;
  /** Statistics by severity */
  bySeverity: Record<Severity, number>;
  /** Files with high-risk issues */
  highRiskFiles: string[];
}

// ============================================================
// PR Summary Types
// ============================================================

export interface PRSummary {
  /** One-line summary of the change */
  title: string;
  /** Paragraph-level description */
  description: string;
  /** Change type classification */
  changeType: 'feature' | 'bugfix' | 'refactor' | 'performance' | 'docs' | 'test' | 'chore' | 'mixed';
  /** Key modules/systems affected */
  affectedModules: string[];
  /** Key files to review */
  keyFiles: KeyFileInfo[];
  /** Dependency changes */
  dependencyChanges: DependencyChange[];
  /** Impact analysis */
  impact: ImpactAnalysis;
  /** Change statistics */
  statistics: {
    filesChanged: number;
    additions: number;
    deletions: number;
    byLanguage: Record<string, number>;
    byType: Record<string, number>;
  };
}

export interface KeyFileInfo {
  /** File path */
  filename: string;
  /** Why this file is important for review */
  reason: string;
  /** Change complexity (0-100) */
  complexity: number;
  /** Lines changed */
  changes: number;
}

export interface DependencyChange {
  /** Dependency name (package/module) */
  name: string;
  /** Change type */
  type: 'added' | 'removed' | 'updated' | 'replaced';
  /** Old version (if applicable) */
  oldVersion?: string;
  /** New version (if applicable) */
  newVersion?: string;
  /** File where the dependency is declared */
  file: string;
}

export interface ImpactAnalysis {
  /** Overall impact level */
  level: 'none' | 'low' | 'medium' | 'high' | 'critical';
  /** Affected components/systems */
  affectedAreas: string[];
  /** Upstream callers potentially affected */
  upstreamDependencies: string[];
  /** Downstream dependencies potentially affected */
  downstreamDependencies: string[];
  /** Whether database schema changes are involved */
  hasDatabaseChanges: boolean;
  /** Whether API contract changes are involved */
  hasAPIChanges: boolean;
  /** Whether configuration changes are involved */
  hasConfigChanges: boolean;
  /** Migration notes */
  migrationNotes?: string;
}

// ============================================================
// Review Suggestion Types
// ============================================================

export type SuggestionType = 'must_fix' | 'recommended' | 'optional';
export type SuggestionCategory =
  | 'style'
  | 'performance'
  | 'security'
  | 'logic'
  | 'testing'
  | 'documentation'
  | 'architecture';

export interface ReviewSuggestion {
  /** Suggestion ID */
  id: string;
  /** Suggestion type/priority */
  type: SuggestionType;
  /** Category */
  category: SuggestionCategory;
  /** Title */
  title: string;
  /** Detailed explanation */
  description: string;
  /** File path */
  file: string;
  /** Line range */
  lineRange: { start: number; end: number };
  /** Current code */
  currentCode: string;
  /** Suggested code change */
  suggestedCode: string;
  /** Reasoning */
  reasoning: string;
  /** Reference links */
  references?: string[];
}

export interface ReviewResult {
  /** PR metadata */
  pr: PRMetadata;
  /** PR change summary */
  summary: PRSummary | null;
  /** Risk report */
  riskReport: RiskReport | null;
  /** Review suggestions */
  suggestions: ReviewSuggestion[];
  /** Analysis metadata */
  metadata: AnalysisMetadata;
}

export interface AnalysisMetadata {
  /** Model used for analysis */
  model: string;
  /** Context level used */
  contextLevel: ContextLevel;
  /** Total tokens used (input + output) */
  tokensUsed: number;
  /** Analysis duration in ms */
  durationMs: number;
  /** Timestamp */
  timestamp: string;
  /** Whether model was downgraded */
  wasModelDowngraded: boolean;
  /** Fallback model used (if primary failed) */
  fallbackModel?: string;
  /** Cached result was used */
  wasCached: boolean;
}

// ============================================================
// Model Provider Types
// ============================================================

export interface ModelConfig {
  /** Model identifier */
  modelId: string;
  /** Provider name */
  provider: ModelProvider;
  /** API endpoint */
  endpoint: string;
  /** API key */
  apiKey: string;
  /** Max input tokens */
  maxInputTokens: number;
  /** Max output tokens */
  maxOutputTokens: number;
  /** Cost per 1M input tokens (USD) */
  costPer1MInput: number;
  /** Cost per 1M output tokens (USD) */
  costPer1MOutput: number;
  /** Model capabilities */
  capabilities: ModelCapabilities;
  /** Priority in routing (higher = preferred) */
  priority: number;
}

export interface ModelCapabilities {
  /** Speed rating (1-10) */
  speed: number;
  /** Code understanding rating (1-10) */
  codeUnderstanding: number;
  /** Multi-file reasoning rating (1-10) */
  multiFileReasoning: number;
  /** Multi-language support rating (1-10) */
  multiLanguage: number;
  /** Chinese language support (1-10) */
  chineseSupport: number;
}

export type ModelProvider = 'anthropic' | 'openai' | 'deepseek' | 'qwen';

export interface ModelRequest {
  /** System prompt */
  systemPrompt: string;
  /** User prompt */
  userPrompt: string;
  /** Desired max tokens for response */
  maxTokens?: number;
  /** Temperature */
  temperature?: number;
  /** Response format */
  responseFormat?: 'text' | 'json_object';
}

export interface ModelResponse {
  /** Raw text content */
  content: string;
  /** Parsed JSON (if applicable) */
  json?: unknown;
  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Model used */
  model: string;
  /** Response duration in ms */
  durationMs: number;
}

export interface ModelRouterConfig {
  /** Scene-based model selection */
  scenes: Record<string, string>;
  /** PR size thresholds for routing */
  sizeThresholds: {
    small: number;   // files
    medium: number;  // files
    // above medium = large
  };
  /** Fallback chain (in order of preference) */
  fallbackChain: string[];
}

// ============================================================
// Feedback Learning Types
// ============================================================

export interface FeedbackEntry {
  /** Issue/suggestion ID */
  issueId: string;
  /** Whether developer accepted the suggestion */
  accepted: boolean;
  /** Developer's rejection reason (if applicable) */
  rejectionReason?: string;
  /** Risk category */
  category: RiskCategory;
  /** Model that generated the suggestion */
  model: string;
  /** Timestamp */
  timestamp: string;
  /** PR metadata for context */
  context: {
    repository: string;
    prNumber: number;
    file: string;
    language: string;
  };
}

export interface FeedbackStats {
  /** Total feedback entries */
  totalEntries: number;
  /** Overall acceptance rate */
  acceptanceRate: number;
  /** Acceptance rate by category */
  byCategory: Record<string, number>;
  /** Acceptance rate by model */
  byModel: Record<string, number>;
  /** False positive rate */
  falsePositiveRate: number;
  /** Common rejection reasons */
  commonRejections: { reason: string; count: number }[];
}

// ============================================================
// Analysis Engine Types
// ============================================================

export interface AnalysisConfig {
  /** Whether to generate summary */
  generateSummary: boolean;
  /** Whether to detect risks */
  detectRisks: boolean;
  /** Whether to generate suggestions */
  generateSuggestions: boolean;
  /** Risk categories to check */
  riskCategories: RiskCategory[];
  /** Minimum severity to report */
  minSeverity: Severity;
  /** Minimum confidence to report */
  minConfidence: Confidence;
  /** Maximum inline comments per file */
  maxInlineCommentsPerFile: number;
  /** Whether to use feedback learning */
  useFeedbackLearning: boolean;
}

export interface AnalysisChunk {
  /** Chunk ID */
  id: string;
  /** Files in this chunk */
  files: FileContext[];
  /** Total tokens in this chunk */
  tokenCount: number;
  /** Chunk index */
  index: number;
  /** Total chunks */
  totalChunks: number;
}

// ============================================================
// Output/Publishing Types
// ============================================================

export interface ReviewOutput {
  /** Overall PR comment (summary) */
  prComment: string;
  /** Inline file comments */
  inlineComments: InlineComment[];
  /** Review summary attached to the PR review */
  reviewSummary: string;
  /** Review event type */
  reviewEvent: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
  /** Metadata */
  metadata: {
    model: string;
    contextLevel: string;
    tokensUsed: number;
  };
}

export interface InlineComment {
  /** File path */
  path: string;
  /** Line number (use 1 for file-level comments) */
  line: number;
  /** Comment body */
  body: string;
  /** Side: LEFT (old) or RIGHT (new) */
  side?: 'LEFT' | 'RIGHT';
  /** Start line (for multi-line comments) */
  startLine?: number;
  /** Start side */
  startSide?: 'LEFT' | 'RIGHT';
}

// ============================================================
// Cache Types
// ============================================================

export interface CacheEntry<T> {
  /** Cached data */
  data: T;
  /** Cache key */
  key: string;
  /** Expiry timestamp */
  expiresAt: number;
  /** Creation timestamp */
  createdAt: number;
}

// ============================================================
// Token Budget Types
// ============================================================

export interface TokenBudget {
  /** Maximum total tokens */
  maxTokens: number;
  /** Tokens used so far */
  usedTokens: number;
  /** Remaining tokens */
  remainingTokens: number;
  /** Allocation breakdown */
  allocation: {
    system: number;
    context: number;
    diff: number;
    history: number;
    reserved: number;
  };
}

// ============================================================
// Configuration Types
// ============================================================

export interface AppConfig {
  /** GitHub configuration */
  github: {
    token: string;
    repository: string;
    webhookSecret?: string;
    webhookPort: number;
  };
  /** Model configuration */
  models: {
    default: string;
    fallback: string;
    enableRouting: boolean;
    providers: Record<ModelProvider, ModelConfig>;
    router: ModelRouterConfig;
  };
  /** Review configuration */
  review: {
    maxDiffSize: number;
    maxFilesPerChunk: number;
    tokenBudget: number;
    confidenceThreshold: number;
    maxInlineCommentsPerFile: number;
    enabledFeatures: {
      summary: boolean;
      riskDetection: boolean;
      suggestions: boolean;
      feedbackLearning: boolean;
      autoUpdateReview: boolean;
    };
    riskFilters: {
      security: boolean;
      performance: boolean;
      bugs: boolean;
      logic: boolean;
      maintainability: boolean;
      minSeverity: Severity;
    };
  };
  /** Context configuration */
  context: {
    defaultLevel: ContextLevel;
    levels: Record<ContextLevel, ContextPolicy>;
  };
  /** Logging configuration */
  logging: {
    level: string;
  };
  /** Advanced configuration */
  advanced: {
    requestTimeout: number;
    maxRetries: number;
    cacheTtlSeconds: number;
  };
}
