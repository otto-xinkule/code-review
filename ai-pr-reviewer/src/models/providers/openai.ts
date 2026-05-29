import OpenAI from 'openai';
import type { ModelRequest, ModelResponse } from '../../types/index.js';
import { BaseModelProvider } from '../provider.js';
import { logger } from '../../utility/logger.js';
import { getConfig } from '../../config/index.js';

/**
 * OpenAI Model Provider
 *
 * Supports GPT-4, GPT-4o, and GPT-3.5 models via the OpenAI API.
 * Uses the Chat Completions API format.
 */

export class OpenAIProvider extends BaseModelProvider {
  private client: OpenAI | null = null;

  constructor() {
    const config = getConfig();
    super(config.models.providers.openai);
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
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
      'Sending request to OpenAI',
    );

    const response = await client.chat.completions.create({
      model: this.config.modelId,
      max_tokens: request.maxTokens || this.config.maxOutputTokens,
      temperature: request.temperature || 0.2,
      response_format:
        request.responseFormat === 'json_object'
          ? { type: 'json_object' }
          : undefined,
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
      'Received response from OpenAI',
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
    // OpenAI ~4 characters per token for English
    return Math.ceil(text.length / 4);
  }
}

export default OpenAIProvider;
