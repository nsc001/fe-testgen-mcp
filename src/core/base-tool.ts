/**
 * BaseTool - 所有工具的统一基类
 *
 * 职责：
 * 1. 提供统一的执行模板（日志、metrics、错误处理）
 * 2. 定义工具元数据（名称、描述、输入 schema）
 * 3. 支持生命周期钩子（beforeExecute, afterExecute）
 * 4. 统一响应格式
 */

import { logger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';
import { formatJsonResponse, formatErrorResponse } from '../utils/response-formatter.js';

export interface ToolMetadata {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category?: string;
  version?: string;
}

export interface ToolExecutionContext {
  toolName: string;
  startTime: number;
  metadata?: Record<string, unknown>;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: {
    duration?: number;
    toolName?: string;
    [key: string]: unknown;
  };
}

export abstract class BaseTool<TInput = any, TOutput = any> {
  /**
   * 获取工具元数据（子类必须实现）
   */
  abstract getMetadata(): ToolMetadata;

  /**
   * 执行工具逻辑（子类必须实现）
   */
  protected abstract executeImpl(input: TInput): Promise<TOutput>;

  /**
   * 统一执行入口（模板方法）
   */
  async execute(input: TInput): Promise<ToolResult<TOutput>> {
    const metadata = this.getMetadata();
    const startTime = Date.now();
    const context: ToolExecutionContext = {
      toolName: metadata.name,
      startTime,
    };

    logger.info(`[Tool:${metadata.name}] Starting execution`, { input });
    getMetrics().recordCounter('tool.execution.started', 1, { tool: metadata.name });

    try {
      // 生命周期：before
      await this.beforeExecute(input, context);

      // 核心执行
      const result = await this.executeImpl(input);

      const duration = Date.now() - startTime;

      // 生命周期：after
      await this.afterExecute(result, context);

      // 记录 metrics
      getMetrics().recordTimer('tool.execution.duration', duration, {
        tool: metadata.name,
        status: 'success',
      });
      getMetrics().recordCounter('tool.execution.completed', 1, { tool: metadata.name });

      logger.info(`[Tool:${metadata.name}] Execution completed`, { duration });

      return {
        success: true,
        data: result,
        metadata: {
          duration,
          toolName: metadata.name,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // 记录错误 metrics
      getMetrics().recordTimer('tool.execution.duration', duration, {
        tool: metadata.name,
        status: 'error',
      });
      getMetrics().recordCounter('tool.execution.failed', 1, { tool: metadata.name });

      logger.error(`[Tool:${metadata.name}] Execution failed`, {
        error: errorMessage,
        duration,
        stack: error instanceof Error ? error.stack : undefined,
      });

      // 生命周期：error
      await this.onError(error, context);

      return {
        success: false,
        error: errorMessage,
        metadata: {
          duration,
          toolName: metadata.name,
        },
      };
    }
  }

  /**
   * 生命周期钩子：执行前（可选覆盖）
   */
  protected async beforeExecute(_input: TInput, _context: ToolExecutionContext): Promise<void> {
    // 默认空实现
  }

  /**
   * 生命周期钩子：执行后（可选覆盖）
   */
  protected async afterExecute(_result: TOutput, _context: ToolExecutionContext): Promise<void> {
    // 默认空实现
  }

  /**
   * 生命周期钩子：错误处理（可选覆盖）
   */
  protected async onError(_error: unknown, _context: ToolExecutionContext): Promise<void> {
    // 默认空实现
  }

  /**
   * 验证输入（可选覆盖）
   */
  protected validateInput(_input: TInput): void {
    // 子类可以覆盖此方法进行输入验证
  }

  /**
   * 格式化为 MCP 响应（兼容现有系统）
   */
  formatResponse(result: ToolResult<TOutput>): { content: Array<{ type: string; text: string }> } {
    if (result.success) {
      return formatJsonResponse(result.data);
    }

    return formatErrorResponse({
      tool: this.getMetadata().name,
      error: result.error || 'Unknown error',
      metadata: result.metadata,
    });
  }
}
