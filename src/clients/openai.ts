import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';

export interface OpenAIConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  timeout?: number;
  maxRetries?: number;
  enableCache?: boolean; // 是否启用响应缓存
  cacheTTL?: number; // 缓存过期时间（秒），默认 1 小时
}

export class OpenAIClient {
  private client: OpenAI;
  private config: Required<OpenAIConfig>;
  private responseCache: Map<string, { response: string; timestamp: number }>;

  constructor(config: OpenAIConfig) {
    this.config = {
      temperature: 0,
      topP: 1,
      maxTokens: 4096,
      timeout: 60000,
      maxRetries: 3,
      baseURL: 'https://api.openai.com/v1',
      enableCache: config.enableCache ?? true,
      cacheTTL: config.cacheTTL ?? 3600,
      ...config,
    };

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries,
    });

    this.responseCache = new Map();

    // 定期清理过期缓存（每 5 分钟）
    if (this.config.enableCache) {
      setInterval(() => this.cleanExpiredCache(), 5 * 60 * 1000);
    }
  }

  /**
   * 完成对话（Chat Completion）
   */
  async complete(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: {
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      responseFormat?: { type: 'json_object' | 'text' };
      tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
      toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
    }
  ): Promise<string> {
    try {
      const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
        model: this.config.model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature: options?.temperature ?? this.config.temperature,
        top_p: options?.topP ?? this.config.topP,
        max_tokens: options?.maxTokens ?? this.config.maxTokens,
      };

      // 如果指定了 response_format，添加到请求中
      if (options?.responseFormat) {
        requestOptions.response_format = options.responseFormat;
      }

      // 如果指定了 tools，添加到请求中
      if (options?.tools && options.tools.length > 0) {
        requestOptions.tools = options.tools;
        if (options.toolChoice) {
          requestOptions.tool_choice = options.toolChoice;
        }
      }

      const cacheKey = this.config.enableCache ? this.createCacheKey('complete', { messages, options: requestOptions }) : undefined;

      if (cacheKey && this.config.enableCache) {
        const cached = this.getCachedResponse(cacheKey);
        if (cached) {
          getMetrics().recordCounter('openai.cache.hit', 1, { method: 'complete' });
          return cached;
        }
        getMetrics().recordCounter('openai.cache.miss', 1, { method: 'complete' });
      }

      const response = await this.client.chat.completions.create(requestOptions);

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      if (cacheKey && this.config.enableCache) {
        this.setCachedResponse(cacheKey, content);
      }

      return content;
    } catch (error) {
      logger.error('OpenAI completion failed', { error });
      throw error;
    }
  }

  /**
   * 完成对话并返回完整响应（包含 tool calls）
   */
  async completeWithToolCalls(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: {
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
      toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
    }
  ): Promise<OpenAI.Chat.Completions.ChatCompletion.Choice> {
    try {
      const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
        model: this.config.model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature: options?.temperature ?? this.config.temperature,
        top_p: options?.topP ?? this.config.topP,
        max_tokens: options?.maxTokens ?? this.config.maxTokens,
      };

      // 如果指定了 tools，添加到请求中
      if (options?.tools && options.tools.length > 0) {
        requestOptions.tools = options.tools;
        if (options.toolChoice) {
          requestOptions.tool_choice = options.toolChoice;
        }
      }

      const cacheKey = this.config.enableCache
        ? this.createCacheKey('completeWithToolCalls', { messages, options: requestOptions })
        : undefined;

      if (cacheKey && this.config.enableCache) {
        const cached = this.getCachedResponse(cacheKey);
        if (cached) {
          getMetrics().recordCounter('openai.cache.hit', 1, { method: 'completeWithToolCalls' });
          return JSON.parse(cached) as OpenAI.Chat.Completions.ChatCompletion.Choice;
        }
        getMetrics().recordCounter('openai.cache.miss', 1, { method: 'completeWithToolCalls' });
      }

      const response = await this.client.chat.completions.create(requestOptions);

      const choice = response.choices[0];
      if (!choice) {
        throw new Error('Empty response from OpenAI');
      }

      if (cacheKey && this.config.enableCache) {
        this.setCachedResponse(cacheKey, JSON.stringify(choice));
      }

      return choice;
    } catch (error) {
      logger.error('OpenAI completion with tool calls failed', { error });
      throw error;
    }
  }

  /**
   * 流式完成（可选）
   */
  async *completeStream(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: {
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    }
  ): AsyncGenerator<string, void, unknown> {
    try {
      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        temperature: options?.temperature ?? this.config.temperature,
        top_p: options?.topP ?? this.config.topP,
        max_tokens: options?.maxTokens ?? this.config.maxTokens,
        stream: true,
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    } catch (error) {
      logger.error('OpenAI stream failed', { error });
      throw error;
    }
  }

  /**
   * 创建缓存键（基于请求参数的哈希）
   */
  private createCacheKey(method: string, params: any): string {
    const hash = createHash('sha256');
    hash.update(JSON.stringify({ method, params, model: this.config.model }));
    return hash.digest('hex');
  }

  /**
   * 获取缓存的响应
   */
  private getCachedResponse(key: string): string | undefined {
    const cached = this.responseCache.get(key);
    if (!cached) {
      return undefined;
    }

    const now = Date.now();
    const age = (now - cached.timestamp) / 1000; // 秒

    if (age > this.config.cacheTTL) {
      this.responseCache.delete(key);
      return undefined;
    }

    logger.debug('[OpenAI] Cache hit', { key: key.substring(0, 8), age: Math.round(age) });
    return cached.response;
  }

  /**
   * 设置缓存的响应
   */
  private setCachedResponse(key: string, response: string): void {
    this.responseCache.set(key, {
      response,
      timestamp: Date.now(),
    });
    logger.debug('[OpenAI] Cache set', { key: key.substring(0, 8), size: this.responseCache.size });
  }

  /**
   * 清理过期缓存
   */
  private cleanExpiredCache(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.responseCache.entries()) {
      const age = (now - value.timestamp) / 1000;
      if (age > this.config.cacheTTL) {
        this.responseCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info('[OpenAI] Cleaned expired cache entries', {
        cleaned,
        remaining: this.responseCache.size,
      });
    }
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    const size = this.responseCache.size;
    this.responseCache.clear();
    logger.info('[OpenAI] Cache cleared', { size });
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { size: number; enabled: boolean; ttl: number } {
    return {
      size: this.responseCache.size,
      enabled: this.config.enableCache,
      ttl: this.config.cacheTTL,
    };
  }
}

