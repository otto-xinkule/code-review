import OpenAI from 'openai';
import type { ModelRequest, ModelResponse } from '../../types/index.js';
import { BaseModelProvider } from '../provider.js';
import { logger } from '../../utility/logger.js';
import { getConfig } from '../../config/index.js';

/**
 * DeepSeek Model Provider
 *
 * Supports DeepSeek-Coder and DeepSeek-V3 models via the DeepSeek API.
 * Uses OpenAI-compatible Chat Completions API format.
 */

export class DeepSeekProvider extends BaseModelProvider {
  private client: OpenAI | null = null;

  constructor() {
    const config = getConfig();
    super(config.models.providers.deepseek);
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.config.apiKey,
        baseURL: this.config.endpoint,
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
      },
      'Sending request to DeepSeek',
    );

    const response = await client.chat.completions.create({
      model: this.config.modelId,
      max_tokens: request.maxTokens || this.config.maxOutputTokens,
      temperature: request.temperature || 0.2,
      messages: [
        {
          role: 'system',
          content: system,
        },
        {
          role: 'user',
          content: user,
        },
      ],
    });

    const durationMs = Date.now() - startTime;
    const textContent = response.choices[0]?.message?.content || '';

    let json: unknown = null;
    if (request.responseFormat === 'json_object') {
      json = this.parseJSONResponse(textContent);
    }

    const usage = {
      inputTokens: response.usage?.prompt_tokens || 0,
      outputTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0,
    };

    logger.info(
      {
        model: response.model,
        durationMs,
        ...usage,
      },
      'Received response from DeepSeek',
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
    // DeepSeek uses a similar tokenization
    return Math.ceil(text.length / 4);
  }
}

export default DeepSeekProvider;
