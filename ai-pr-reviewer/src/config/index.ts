import { config as dotenvConfig } from 'dotenv';
import type { AppConfig, ContextLevel, ContextPolicy, ModelConfig, ModelProvider, Severity } from '../types/index.js';

// Load environment variables
dotenvConfig();

/**
 * Default context policies for each level.
 */
const DEFAULT_CONTEXT_POLICIES: Record<ContextLevel, ContextPolicy> = {
  L1: {
    level: 'L1',
    maxTokens: 3000,
    includeFullFiles: false,
    includeDependencies: false,
    includeIssues: false,
    includePRBody: true,
    maxFiles: 50,
  },
  L2: {
    level: 'L2',
    maxTokens: 6000,
    includeFullFiles: false,
    includeDependencies: false,
    includeIssues: true,
    includePRBody: true,
    maxFiles: 30,
  },
  L3: {
    level: 'L3',
    maxTokens: 12000,
    includeFullFiles: true,
    includeDependencies: true,
    includeIssues: true,
    includePRBody: true,
    maxFiles: 20,
  },
  L4: {
    level: 'L4',
    maxTokens: 32000,
    includeFullFiles: true,
    includeDependencies: true,
    includeIssues: true,
    includePRBody: true,
    maxFiles: 50,
  },
};

/**
 * Default model provider configurations.
 */
const DEFAULT_MODEL_CONFIGS: Record<ModelProvider, ModelConfig> = {
  anthropic: {
    modelId: 'claude-opus-4-20240229',
    provider: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    maxInputTokens: 200000,
    maxOutputTokens: 4096,
    costPer1MInput: 15.0,
    costPer1MOutput: 75.0,
    capabilities: {
      speed: 6,
      codeUnderstanding: 10,
      multiFileReasoning: 10,
      multiLanguage: 9,
      chineseSupport: 8,
    },
    priority: 100,
  },
  openai: {
    modelId: 'gpt-4o',
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.OPENAI_API_KEY || '',
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    costPer1MInput: 5.0,
    costPer1MOutput: 15.0,
    capabilities: {
      speed: 8,
      codeUnderstanding: 8,
      multiFileReasoning: 8,
      multiLanguage: 9,
      chineseSupport: 7,
    },
    priority: 80,
  },
  deepseek: {
    modelId: 'deepseek-coder',
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    costPer1MInput: 0.14,
    costPer1MOutput: 0.28,
    capabilities: {
      speed: 9,
      codeUnderstanding: 7,
      multiFileReasoning: 7,
      multiLanguage: 7,
      chineseSupport: 9,
    },
    priority: 70,
  },
  qwen: {
    modelId: 'qwen2.5-coder-32b-instruct',
    provider: 'qwen',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiKey: process.env.QWEN_API_KEY || '',
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    costPer1MInput: 1.0,
    costPer1MOutput: 2.0,
    capabilities: {
      speed: 7,
      codeUnderstanding: 7,
      multiFileReasoning: 7,
      multiLanguage: 8,
      chineseSupport: 10,
    },
    priority: 60,
  },
};

/**
 * Build the full application configuration from environment variables and defaults.
 */
export function loadConfig(): AppConfig {
  return {
    github: {
      token: process.env.GITHUB_TOKEN || '',
      repository: process.env.GITHUB_REPOSITORY || '',
      webhookSecret: process.env.WEBHOOK_SECRET,
      webhookPort: parseInt(process.env.WEBHOOK_PORT || '3000', 10),
    },
    models: {
      default: process.env.DEFAULT_MODEL || 'claude-opus-4-20240229',
      fallback: process.env.FALLBACK_MODEL || 'gpt-4o',
      enableRouting: process.env.ENABLE_MODEL_ROUTING !== 'false',
      providers: DEFAULT_MODEL_CONFIGS,
      router: {
        scenes: {
          formal_review: 'claude-opus-4-20240229',
          quick_review: 'deepseek-coder',
          multilingual: 'gpt-4o',
          chinese_context: 'qwen2.5-coder-32b-instruct',
        },
        sizeThresholds: {
          small: 5,
          medium: 15,
        },
        fallbackChain: [
          'claude-opus-4-20240229',
          'gpt-4o',
          'deepseek-coder',
          'qwen2.5-coder-32b-instruct',
        ],
      },
    },
    review: {
      maxDiffSize: parseInt(process.env.MAX_DIFF_SIZE || '512000', 10),
      maxFilesPerChunk: parseInt(process.env.MAX_FILES_PER_CHUNK || '15', 10),
      tokenBudget: parseInt(process.env.TOKEN_BUDGET || '8000', 10),
      confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.7'),
      maxInlineCommentsPerFile: parseInt(process.env.MAX_INLINE_COMMENTS_PER_FILE || '5', 10),
      enabledFeatures: {
        summary: process.env.ENABLE_SUMMARY !== 'false',
        riskDetection: process.env.ENABLE_RISK_DETECTION !== 'false',
        suggestions: process.env.ENABLE_SUGGESTIONS !== 'false',
        feedbackLearning: process.env.ENABLE_FEEDBACK_LEARNING !== 'false',
        autoUpdateReview: process.env.ENABLE_AUTO_UPDATE_REVIEW !== 'false',
      },
      riskFilters: {
        security: process.env.CHECK_SECURITY !== 'false',
        performance: process.env.CHECK_PERFORMANCE !== 'false',
        bugs: process.env.CHECK_BUGS !== 'false',
        logic: process.env.CHECK_LOGIC !== 'false',
        maintainability: process.env.CHECK_MAINTAINABILITY !== 'false',
        minSeverity: (process.env.MIN_SEVERITY_LEVEL as Severity) || 'medium',
      },
    },
    context: {
      defaultLevel: 'L2',
      levels: DEFAULT_CONTEXT_POLICIES,
    },
    logging: {
      level: process.env.LOG_LEVEL || 'info',
    },
    advanced: {
      requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '300000', 10),
      maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
      cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '3600', 10),
    },
  };
}

/**
 * Validate that required configuration is present.
 */
export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];

  if (!config.github.token) {
    errors.push('GITHUB_TOKEN is required');
  }

  if (config.models.enableRouting) {
    const activeProviders = Object.entries(config.models.providers)
      .filter(([, c]) => c.apiKey)
      .map(([p]) => p);

    if (activeProviders.length === 0) {
      errors.push(
        'At least one model provider API key is required (ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or QWEN_API_KEY)',
      );
    }

    // Warn about default model not having API key
    const defaultModelConfig = Object.values(config.models.providers).find(
      (c) => c.modelId === config.models.default,
    );
    if (defaultModelConfig && !defaultModelConfig.apiKey) {
      errors.push(
        `Default model '${config.models.default}' has no API key configured. Model routing will select an alternative.`,
      );
    }
  }

  return errors;
}

/** Singleton config instance */
let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
