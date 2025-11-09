/**
 * Pipeline System - 声明式工作流编排
 *
 * 支持：
 * - YAML/JSON 定义工作流
 * - 步骤间数据流转
 * - 条件执行
 * - 并行执行（future）
 * - 错误处理与重试
 */

import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { ToolRegistry } from './tool-registry.js';
import { logger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';

export interface PipelineStep {
  name: string;
  type: 'tool' | 'agent' | 'condition' | 'parallel';
  ref?: string; // 工具/Agent 名称
  input?: Record<string, unknown>;
  condition?: string; // 条件表达式
  onError?: 'stop' | 'continue' | 'retry';
  retries?: number;
}

export interface PipelineDefinition {
  name?: string;
  description?: string;
  steps: PipelineStep[];
}

export interface PipelineContext {
  input: Record<string, unknown>;
  steps: Record<string, { data?: unknown; error?: string }>;
}

export interface PipelineResult {
  success: boolean;
  context: PipelineContext;
  finalOutput?: unknown;
  error?: string;
}

/**
 * PipelineExecutor - 执行 Pipeline
 */
export class PipelineExecutor {
  constructor(private toolRegistry: ToolRegistry) {}

  async execute(pipeline: PipelineDefinition, input: Record<string, unknown>): Promise<PipelineResult> {
    const context: PipelineContext = {
      input,
      steps: {},
    };

    logger.info(`[Pipeline] Starting: ${pipeline.name || 'unnamed'}`, { stepsCount: pipeline.steps.length });
    getMetrics().recordCounter('pipeline.execution.started', 1, { pipeline: pipeline.name });

    const startTime = Date.now();

    try {
      for (const step of pipeline.steps) {
        logger.info(`[Pipeline] Executing step: ${step.name}`);

        // 检查条件
        if (step.condition && !this.evaluateCondition(step.condition, context)) {
          logger.info(`[Pipeline] Skipping step ${step.name} (condition not met)`);
          continue;
        }

        // 执行步骤
        const stepResult = await this.executeStep(step, context);
        context.steps[step.name] = stepResult;

        // 错误处理
        if (stepResult.error) {
          logger.error(`[Pipeline] Step ${step.name} failed`, { error: stepResult.error });

          if (step.onError === 'stop' || !step.onError) {
            throw new Error(`Step "${step.name}" failed: ${stepResult.error}`);
          }
          // 'continue' - 继续下一步
        }
      }

      const duration = Date.now() - startTime;
      getMetrics().recordTimer('pipeline.execution.duration', duration, {
        pipeline: pipeline.name,
        status: 'success',
      });

      logger.info(`[Pipeline] Completed: ${pipeline.name}`, { duration });

      return {
        success: true,
        context,
        finalOutput: this.extractFinalOutput(context),
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      getMetrics().recordTimer('pipeline.execution.duration', duration, {
        pipeline: pipeline.name,
        status: 'error',
      });

      logger.error(`[Pipeline] Failed: ${pipeline.name}`, { error: errorMessage });

      return {
        success: false,
        context,
        error: errorMessage,
      };
    }
  }

  private async executeStep(
    step: PipelineStep,
    context: PipelineContext
  ): Promise<{ data?: unknown; error?: string }> {
    if (step.type === 'tool') {
      return this.executeToolStep(step, context);
    }

    // TODO: 支持其他类型（agent, condition, parallel）
    return { error: `Unsupported step type: ${step.type}` };
  }

  private async executeToolStep(
    step: PipelineStep,
    context: PipelineContext
  ): Promise<{ data?: unknown; error?: string }> {
    if (!step.ref) {
      return { error: 'Tool step missing "ref"' };
    }

    const tool = this.toolRegistry.get(step.ref);
    if (!tool) {
      return { error: `Tool "${step.ref}" not found` };
    }

    // 解析输入（支持模板变量）
    const input = this.resolveInput(step.input || {}, context);

    try {
      const result = await tool.execute(input);
      return { data: result.data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 解析输入中的模板变量
   * 支持：{{context.xxx}}, {{steps.stepName.data.xxx}}
   */
  private resolveInput(input: Record<string, unknown>, context: PipelineContext): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && value.startsWith('{{') && value.endsWith('}}')) {
        const path = value.slice(2, -2).trim();
        resolved[key] = this.getValueByPath(path, context);
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  private getValueByPath(path: string, context: PipelineContext): unknown {
    const parts = path.split('.');
    let current: any = { context: context.input, steps: context.steps };

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  private evaluateCondition(condition: string, context: PipelineContext): boolean {
    // 简化实现：仅支持简单的存在性检查
    // 生产环境应使用更安全的表达式引擎
    try {
      const value = this.getValueByPath(condition, context);
      return Boolean(value);
    } catch {
      return false;
    }
  }

  private extractFinalOutput(context: PipelineContext): unknown {
    // 默认返回最后一个步骤的输出
    const stepNames = Object.keys(context.steps);
    if (stepNames.length === 0) return undefined;

    const lastStepName = stepNames[stepNames.length - 1];
    return context.steps[lastStepName].data;
  }
}

/**
 * PipelineLoader - 加载 Pipeline 定义
 */
export class PipelineLoader {
  loadFromFile(filePath: string): Map<string, PipelineDefinition> {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = YAML.parse(content);

      if (!parsed.pipelines) {
        throw new Error('Invalid pipeline file: missing "pipelines" key');
      }

      const pipelines = new Map<string, PipelineDefinition>();

      for (const [name, def] of Object.entries(parsed.pipelines)) {
        const pipeline = def as PipelineDefinition;
        pipeline.name = name;
        pipelines.set(name, pipeline);
      }

      logger.info(`Loaded ${pipelines.size} pipelines from ${filePath}`);
      return pipelines;
    } catch (error) {
      logger.error(`Failed to load pipelines from ${filePath}`, { error });
      return new Map();
    }
  }
}
