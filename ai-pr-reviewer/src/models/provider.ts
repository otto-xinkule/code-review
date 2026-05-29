import type { ModelRequest, ModelResponse, ModelProvider, ModelConfig } from '../types/index.js';
import { logger } from '../utility/logger.js';

/**
 * Abstract Model Provider
 *
 * Defines the interface for all AI model providers.
 * Each provider (Anthropic, OpenAI, DeepSeek, Qwen) implements this interface.
 */

export interface IModelProvider {
  /** Provider identifier */
  readonly provider: ModelProvider;
  /** Model configuration */
  readonly config: ModelConfig;
  /** Check if provider is available (has API key) */
  isAvailable(): boolean;
  /** Send a request to the model */
  sendRequest(request: ModelRequest): Promise<ModelResponse>;
  /** Estimate token count for text */
  estimateTokens(text: string): number;
  /** Get the model name */
  getModelName(): string;
}

/**
 * Base implementation with common functionality.
 */
export abstract class BaseModelProvider implements IModelProvider {
  public readonly provider: ModelProvider;
  public readonly config: ModelConfig;

  constructor(config: ModelConfig) {
    this.provider = config.provider;
    this.config = config;
  }

  isAvailable(): boolean {
    return !!this.config.apiKey && this.config.apiKey.length > 0;
  }

  abstract sendRequest(request: ModelRequest): Promise<ModelResponse>;

  getModelName(): string {
    return this.config.modelId;
  }

  estimateTokens(text: string): number {
    // Default: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Parse JSON from model response, with error handling.
   */
  protected parseJSONResponse(content: string): unknown {
    try {
      // Try direct parse
      return JSON.parse(content);
    } catch {
      // Try to extract JSON from markdown code blocks
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[1]);
        } catch {
          // fall through
        }
      }

      // Try to find JSON object in the text
      const objectMatch = content.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        try {
          return JSON.parse(objectMatch[0]);
        } catch {
          // fall through
        }
      }

      // Try to find JSON array in the text
      const arrayMatch = content.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        try {
          return JSON.parse(arrayMatch[0]);
        } catch {
          // fall through
        }
      }

      logger.warn({ contentPreview: content.substring(0, 200) }, 'Failed to parse JSON from model response');
      return null;
    }
  }

  /**
   * Ensure response format instruction is in the prompt.
   */
  protected enforceResponseFormat(
    systemPrompt: string,
    userPrompt: string,
    format: 'text' | 'json_object',
  ): { system: string; user: string } {
    if (format === 'json_object') {
      const jsonInstruction = `\n\nIMPORTANT: You MUST respond with valid JSON only. Do not include any other text, markdown formatting, or code blocks. The response must be parseable by JSON.parse().`;
      return {
        system: systemPrompt,
        user: userPrompt + jsonInstruction,
      };
    }
    return { system: systemPrompt, user: userPrompt };
  }
}
