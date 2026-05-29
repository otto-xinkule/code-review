import type { IModelProvider } from './provider.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { QwenProvider } from './providers/qwen.js';
import type {
  ModelRequest,
  ModelResponse,
  ModelProvider as ModelProviderType,
  ParsedDiff,
  PRMetadata,
} from '../types/index.js';
import { logger } from '../utility/logger.js';
import { withRetry } from '../utility/retry.js';
import { metrics } from '../utility/metrics.js';
import { getConfig } from '../config/index.js';

/**
 * Model Router
 *
 * Manages multiple AI model providers and routes requests
 * based on PR characteristics, scene requirements, and availability.
 * Implements fallback chains and load balancing.
 */

export type ReviewScene = 'formal_review' | 'quick_review' | 'multilingual' | 'chinese_context';

export class ModelRouter {
  private providers: Map<ModelProviderType, IModelProvider>;
  private fallbackChain: string[];
  private disabledProviders: Set<string> = new Set();

  constructor() {
    this.providers = new Map();
    const config = getConfig();

    // Initialize providers that have API keys
    const providerClasses: Array<{
      type: ModelProviderType;
      factory: () => IModelProvider;
    }> = [
      { type: 'anthropic', factory: () => new AnthropicProvider() },
      { type: 'openai', factory: () => new OpenAIProvider() },
      { type: 'deepseek', factory: () => new DeepSeekProvider() },
      { type: 'qwen', factory: () => new QwenProvider() },
    ];

    for (const { type, factory } of providerClasses) {
      try {
        const provider = factory();
        if (provider.isAvailable()) {
          this.providers.set(type, provider);
          logger.info({ provider: type, model: provider.getModelName() }, 'Provider registered');
        } else {
          logger.warn({ provider: type }, 'Provider not available (no API key)');
        }
      } catch (error) {
        logger.error({ provider: type, error: String(error) }, 'Failed to initialize provider');
      }
    }

    if (this.providers.size === 0) {
      logger.error('No model providers available. Please configure at least one API key.');
    }

    this.fallbackChain = config.models.router.fallbackChain;
  }

  /**
   * Get a provider by type.
   */
  getProvider(type: ModelProviderType): IModelProvider | undefined {
    return this.providers.get(type);
  }

  /**
   * Get all available providers.
   */
  getAllProviders(): IModelProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Select the best model for a given scene.
   */
  selectByScene(scene: ReviewScene): IModelProvider | undefined {
    const config = getConfig();
    const modelId = config.models.router.scenes[scene];

    for (const [, provider] of this.providers) {
      if (provider.config.modelId === modelId && !this.disabledProviders.has(provider.getModelName())) {
        return provider;
      }
    }

    // Fallback: return any available provider
    return this.selectFallback();
  }

  /**
   * Select model based on PR characteristics.
   */
  selectByPR(parsedDiff: ParsedDiff, prMetadata: PRMetadata): IModelProvider | undefined {
    const config = getConfig();

    const fileCount = parsedDiff.files.length;
    const totalChanges = parsedDiff.stats.additions + parsedDiff.stats.deletions;
    const hasChinese = prMetadata.body?.match(/[\u4e00-\u9fff]/) || prMetadata.title.match(/[\u4e00-\u9fff]/);

    // Check if we should use routing
    if (!config.models.enableRouting) {
      return this.getProviderByModelId(config.models.default) || this.selectFallback();
    }

    const { small, medium } = config.models.router.sizeThresholds;

    // Scene-based selection
    if (hasChinese && totalChanges > 100) {
      logger.info('Routing to Chinese context model');
      return this.selectByScene('chinese_context');
    }

    if (totalChanges > medium * 200) {
      // Large PR: use most capable model
      logger.info('Routing to formal review model (large PR)');
      return this.selectByScene('formal_review');
    }

    if (fileCount <= small && totalChanges < 500) {
      // Small PR: use fast model
      logger.info('Routing to quick review model (small PR)');
      return this.selectByScene('quick_review');
    }

    if (totalChanges > 5000) {
      // Very large PR: use model with best multi-file reasoning
      const providers = this.getAllProviders()
        .filter((p) => !this.disabledProviders.has(p.getModelName()))
        .sort((a, b) => b.config.capabilities.multiFileReasoning - a.config.capabilities.multiFileReasoning);
      if (providers.length > 0) return providers[0];
    }

    // Default: use the configured default model
    return this.getProviderByModelId(config.models.default) || this.selectFallback();
  }

  /**
   * Get a provider by model ID.
   */
  getProviderByModelId(modelId: string): IModelProvider | undefined {
    for (const [, provider] of this.providers) {
      if (provider.config.modelId === modelId) {
        return provider;
      }
    }
    return undefined;
  }

  /**
   * Select a fallback provider from the chain.
   */
  selectFallback(): IModelProvider | undefined {
    for (const modelId of this.fallbackChain) {
      const provider = this.getProviderByModelId(modelId);
      if (provider && !this.disabledProviders.has(modelId)) {
        logger.info({ modelId }, 'Using fallback model');
        return provider;
      }
    }
    return this.getAllProviders().filter((p) => !this.disabledProviders.has(p.getModelName()))[0];
  }

  /**
   * Send a request with automatic retry and fallback.
   */
  async sendWithFallback(request: ModelRequest): Promise<ModelResponse> {
    const providers = this.getProviderChain(request);
    let lastError: Error | null = null;

    for (const provider of providers) {
      try {
        logger.info({ model: provider.getModelName() }, 'Attempting request');

        const response = await withRetry(
          () => provider.sendRequest(request),
          { maxRetries: 2 },
        );

        metrics.recordEvent('model_request', 1, {
          model: provider.getModelName(),
          success: true,
          durationMs: response.durationMs,
        });

        return response;
      } catch (error) {
        lastError = error as Error;
        logger.error(
          { model: provider.getModelName(), error: String(error) },
          'Model request failed, trying next provider',
        );

        metrics.recordEvent('model_request', 0, {
          model: provider.getModelName(),
          success: false,
          error: String(error),
        });

        // If rate limited, temporarily disable the provider
        if (isRateLimitError(error)) {
          logger.warn({ model: provider.getModelName() }, 'Rate limited, temporarily disabling provider');
          this.disabledProviders.add(provider.getModelName());
          // Re-enable after 60 seconds
          setTimeout(() => {
            this.disabledProviders.delete(provider.getModelName());
            logger.info({ model: provider.getModelName() }, 'Provider re-enabled after rate limit cooldown');
          }, 60000);
        }
      }
    }

    throw new Error(
      `All model providers failed. Last error: ${lastError?.message || 'Unknown error'}`,
    );
  }

  /**
   * Build the provider chain for a request, ordered by priority.
   */
  private getProviderChain(request: ModelRequest): IModelProvider[] {
    const config = getConfig();
    const defaultModel = config.models.default;

    // Start with the default model
    const chain: IModelProvider[] = [];

    const defaultProvider = this.getProviderByModelId(defaultModel);
    if (defaultProvider && !this.disabledProviders.has(defaultModel)) {
      chain.push(defaultProvider);
    }

    // Add fallback chain providers
    for (const modelId of this.fallbackChain) {
      if (modelId !== defaultModel) {
        const provider = this.getProviderByModelId(modelId);
        if (provider && !this.disabledProviders.has(modelId)) {
          chain.push(provider);
        }
      }
    }

    // Add any remaining available providers
    for (const [, provider] of this.providers) {
      if (!chain.includes(provider) && !this.disabledProviders.has(provider.getModelName())) {
        chain.push(provider);
      }
    }

    return chain;
  }

  /**
   * Get available model count.
   */
  getAvailableCount(): number {
    return Array.from(this.providers.values()).filter(
      (p) => !this.disabledProviders.has(p.getModelName()),
    ).length;
  }

  /**
   * Get the list of model IDs that are currently available.
   */
  getAvailableModels(): string[] {
    return Array.from(this.providers.values())
      .filter((p) => !this.disabledProviders.has(p.getModelName()))
      .map((p) => p.getModelName());
  }
}

/**
 * Check if an error is a rate limit error.
 */
function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('rate_limit') ||
      msg.includes('rate limit') ||
      msg.includes('too many requests') ||
      msg.includes('429');
  }
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    return obj.status === 429;
  }
  return false;
}

/** Singleton instance */
let _router: ModelRouter | null = null;

export function getRouter(): ModelRouter {
  if (!_router) {
    _router = new ModelRouter();
  }
  return _router;
}

export default ModelRouter;
