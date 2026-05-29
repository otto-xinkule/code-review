import Anthropic from '@anthropic-ai/sdk';
import type { ModelRequest, ModelResponse } from '../../types/index.js';
import { BaseModelProvider } from '../provider.js';
import { logger } from '../../utility/logger.js';
import { getConfig } from '../../config/index.js';

/**
 * Anthropic (Claude) Model Provider
 *
 * Supports Claude Opus, Sonnet, and Haiku models via the Anthropic API.
 * Uses the Messages API format.
 */

export class AnthropicProvider extends BaseModelProvider {
  private client: Anthropic | null = null;

  constructor() {
    const config = getConfig();
    super(config.models.providers.anthropic);
  }

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({
        apiKey: this.config.apiKey,
      });
    }
    return this.client;
  }

  async sendRequest(request: ModelRequest): Promise<ModelResponse> {
    const startTime = Date.now();
    const client = this.getClient();

    const { system, user } = this.enforceResponseFormat(
      request.systemPrompt,
      request.userPrompt,
      request.responseFormat || 'text',
    );

    logger.info(
      {
        model: this.config.modelId,
        systemTokens: this.estimateTokens(system),
        userTokens: this.estimateTokens(user),
      },
      'Sending request to Anthropic',
    );

    const response = await client.messages.create({
      model: this.config.modelId,
      max_tokens: request.maxTokens || this.config.maxOutputTokens,
      temperature: request.temperature || 0.2,
      system,
      messages: [
        {
          role: 'user',
          content: user,
        },
      ],
    });

    const durationMs = Date.now() - startTime;

    // Extract text content from response
    const textContent = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as Anthropic.TextBlock).text)
      .join('\n');

    let json: unknown = null;
    if (request.responseFormat === 'json_object') {
      json = this.parseJSONResponse(textContent);
    }

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens:
        response.usage.input_tokens + response.usage.output_tokens,
    };

    logger.info(
      {
        model: this.config.modelId,
        durationMs,
        ...usage,
      },
      'Received response from Anthropic',
    );

    return {
      content: textContent,
      json,
      usage,
      model: response.model,
      durationMs,
    };
  }

  estimateTokens(text: string): number {
    // Anthropic uses a slightly different tokenization
    // ~3.5 characters per token for English text
    return Math.ceil(text.length / 3.5);
  }
}

export default AnthropicProvider;
