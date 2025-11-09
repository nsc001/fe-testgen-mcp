/**
 * AgentCoordinator - 多 Agent 协作协调器
 *
 * 职责：
 * 1. 管理多个 Agent 的并行执行
 * 2. 提供共享上下文和状态管理
 * 3. 协调 Agent 间的依赖关系
 * 4. 合并和去重执行结果
 * 5. 支持并发控制和错误恢复
 */

import pLimit from 'p-limit';
import { logger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';
import { ContextStore, AgentContext } from './context.js';

export interface AgentTask<TInput, TOutput> {
  id: string;
  name: string;
  agent: {
    execute: (input: TInput) => Promise<TOutput>;
  };
  input: TInput;
  priority?: number; // 优先级，数值越大优先级越高
  dependencies?: string[]; // 依赖的任务 ID
}

export interface AgentCoordinatorConfig {
  maxConcurrency?: number; // 最大并发数，默认 3
  continueOnError?: boolean; // 发生错误时是否继续，默认 false
  retryOnError?: boolean; // 发生错误时是否重试，默认 false
  maxRetries?: number; // 最大重试次数，默认 2
  sharedContext?: boolean; // 是否使用共享上下文，默认 true
}

export interface AgentExecutionResult<TOutput> {
  taskId: string;
  taskName: string;
  success: boolean;
  output?: TOutput;
  error?: Error;
  duration: number;
  retries: number;
}

export interface CoordinatorResult<TOutput> {
  success: boolean;
  results: AgentExecutionResult<TOutput>[];
  totalDuration: number;
  successCount: number;
  errorCount: number;
  context?: AgentContext;
}

export class AgentCoordinator<TInput = any, TOutput = any> {
  private config: Required<AgentCoordinatorConfig>;
  private contextStore: ContextStore;
  private limit: ReturnType<typeof pLimit>;

  constructor(
    contextStore: ContextStore,
    config: AgentCoordinatorConfig = {}
  ) {
    this.contextStore = contextStore;
    this.config = {
      maxConcurrency: config.maxConcurrency ?? 3,
      continueOnError: config.continueOnError ?? false,
      retryOnError: config.retryOnError ?? false,
      maxRetries: config.maxRetries ?? 2,
      sharedContext: config.sharedContext ?? true,
    };
    this.limit = pLimit(this.config.maxConcurrency);

    logger.info('[AgentCoordinator] Initialized', {
      maxConcurrency: this.config.maxConcurrency,
      continueOnError: this.config.continueOnError,
      retryOnError: this.config.retryOnError,
    });
  }

  /**
   * 执行多个 Agent 任务（并行）
   */
  async executeParallel(
    tasks: AgentTask<TInput, TOutput>[]
  ): Promise<CoordinatorResult<TOutput>> {
    const startTime = Date.now();
    const sessionId = this.generateSessionId();

    logger.info('[AgentCoordinator] Starting parallel execution', {
      tasksCount: tasks.length,
      sessionId,
    });

    getMetrics().recordCounter('agent_coordinator.execution.started', 1, {
      mode: 'parallel',
      tasksCount: tasks.length.toString(),
    });

    // 创建共享上下文（如果启用）
    const sharedContext = this.config.sharedContext
      ? this.contextStore.create(sessionId, 'agent-coordinator', 'Parallel execution', {
          goal: `Execute ${tasks.length} agents in parallel`,
          maxSteps: tasks.length * 10,
          initialData: {
            tasks: tasks.map((t) => ({ id: t.id, name: t.name })),
          },
        })
      : undefined;

    // 执行所有任务
    const results = await Promise.allSettled(
      tasks.map((task) =>
        this.limit(() => this.executeTask(task, sharedContext))
      )
    );

    // 处理结果
    const executionResults: AgentExecutionResult<TOutput>[] = results.map(
      (result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          const task = tasks[index];
          return {
            taskId: task.id,
            taskName: task.name,
            success: false,
            error: result.reason,
            duration: 0,
            retries: 0,
          };
        }
      }
    );

    const totalDuration = Date.now() - startTime;
    const successCount = executionResults.filter((r) => r.success).length;
    const errorCount = executionResults.filter((r) => !r.success).length;

    logger.info('[AgentCoordinator] Parallel execution completed', {
      totalDuration,
      successCount,
      errorCount,
    });

    getMetrics().recordCounter('agent_coordinator.execution.completed', 1, {
      mode: 'parallel',
      status: errorCount === 0 ? 'success' : 'partial',
    });
    getMetrics().recordHistogram('agent_coordinator.duration', totalDuration, {
      mode: 'parallel',
    });

    return {
      success: errorCount === 0 || this.config.continueOnError,
      results: executionResults,
      totalDuration,
      successCount,
      errorCount,
      context: sharedContext,
    };
  }

  /**
   * 执行多个 Agent 任务（串行，按优先级和依赖）
   */
  async executeSequential(
    tasks: AgentTask<TInput, TOutput>[]
  ): Promise<CoordinatorResult<TOutput>> {
    const startTime = Date.now();
    const sessionId = this.generateSessionId();

    logger.info('[AgentCoordinator] Starting sequential execution', {
      tasksCount: tasks.length,
      sessionId,
    });

    getMetrics().recordCounter('agent_coordinator.execution.started', 1, {
      mode: 'sequential',
      tasksCount: tasks.length.toString(),
    });

    // 创建共享上下文
    const sharedContext = this.config.sharedContext
      ? this.contextStore.create(sessionId, 'agent-coordinator', 'Sequential execution', {
          goal: `Execute ${tasks.length} agents sequentially`,
          maxSteps: tasks.length * 10,
          initialData: {
            tasks: tasks.map((t) => ({ id: t.id, name: t.name })),
          },
        })
      : undefined;

    // 按优先级排序（优先级高的先执行）
    const sortedTasks = this.sortTasksByPriority(tasks);

    // 执行任务（考虑依赖关系）
    const executionResults: AgentExecutionResult<TOutput>[] = [];
    const completedTaskIds = new Set<string>();

    for (const task of sortedTasks) {
      // 检查依赖是否满足
      if (task.dependencies && task.dependencies.length > 0) {
        const dependenciesMet = task.dependencies.every((depId) =>
          completedTaskIds.has(depId)
        );

        if (!dependenciesMet) {
          logger.warn('[AgentCoordinator] Task dependencies not met, skipping', {
            taskId: task.id,
            dependencies: task.dependencies,
            completed: Array.from(completedTaskIds),
          });

          executionResults.push({
            taskId: task.id,
            taskName: task.name,
            success: false,
            error: new Error('Dependencies not met'),
            duration: 0,
            retries: 0,
          });
          continue;
        }
      }

      // 执行任务
      const result = await this.executeTask(task, sharedContext);
      executionResults.push(result);

      if (result.success) {
        completedTaskIds.add(task.id);
      } else if (!this.config.continueOnError) {
        logger.error('[AgentCoordinator] Task failed, stopping execution', {
          taskId: task.id,
          error: result.error,
        });
        break;
      }
    }

    const totalDuration = Date.now() - startTime;
    const successCount = executionResults.filter((r) => r.success).length;
    const errorCount = executionResults.filter((r) => !r.success).length;

    logger.info('[AgentCoordinator] Sequential execution completed', {
      totalDuration,
      successCount,
      errorCount,
    });

    getMetrics().recordCounter('agent_coordinator.execution.completed', 1, {
      mode: 'sequential',
      status: errorCount === 0 ? 'success' : 'partial',
    });
    getMetrics().recordHistogram('agent_coordinator.duration', totalDuration, {
      mode: 'sequential',
    });

    return {
      success: errorCount === 0,
      results: executionResults,
      totalDuration,
      successCount,
      errorCount,
      context: sharedContext,
    };
  }

  /**
   * 执行单个任务（支持重试）
   */
  private async executeTask(
    task: AgentTask<TInput, TOutput>,
    sharedContext?: AgentContext
  ): Promise<AgentExecutionResult<TOutput>> {
    const startTime = Date.now();
    let retries = 0;
    let lastError: Error | undefined;

    logger.info('[AgentCoordinator] Executing task', {
      taskId: task.id,
      taskName: task.name,
    });

    // 如果有共享上下文，记录 Action
    if (sharedContext) {
      this.contextStore.addHistory(sharedContext.sessionId, {
        action: {
          type: 'call_tool',
          toolName: task.name,
          parameters: { taskId: task.id },
          timestamp: Date.now(),
        },
      });
    }

    while (retries <= this.config.maxRetries) {
      try {
        const output = await task.agent.execute(task.input);
        const duration = Date.now() - startTime;

        logger.info('[AgentCoordinator] Task completed successfully', {
          taskId: task.id,
          duration,
          retries,
        });

        // 记录 Observation
        if (sharedContext) {
          this.contextStore.addHistory(sharedContext.sessionId, {
            observation: {
              type: 'tool_result',
              source: task.name,
              content: { success: true, taskId: task.id },
              timestamp: Date.now(),
            },
          });
        }

        getMetrics().recordCounter('agent_coordinator.task.completed', 1, {
          taskName: task.name,
          status: 'success',
        });

        return {
          taskId: task.id,
          taskName: task.name,
          success: true,
          output,
          duration,
          retries,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        retries++;

        logger.warn('[AgentCoordinator] Task failed', {
          taskId: task.id,
          error: lastError.message,
          retries,
          willRetry: this.config.retryOnError && retries <= this.config.maxRetries,
        });

        if (!this.config.retryOnError || retries > this.config.maxRetries) {
          break;
        }

        // 等待一段时间后重试（指数退避）
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retries - 1)));
      }
    }

    const duration = Date.now() - startTime;

    logger.error('[AgentCoordinator] Task failed after retries', {
      taskId: task.id,
      retries: retries - 1,
      error: lastError?.message,
    });

    // 记录错误 Observation
    if (sharedContext) {
      this.contextStore.addHistory(sharedContext.sessionId, {
        observation: {
          type: 'error',
          source: task.name,
          content: { error: lastError?.message, taskId: task.id },
          timestamp: Date.now(),
        },
      });
    }

    getMetrics().recordCounter('agent_coordinator.task.completed', 1, {
      taskName: task.name,
      status: 'error',
    });

    return {
      taskId: task.id,
      taskName: task.name,
      success: false,
      error: lastError,
      duration,
      retries: retries - 1,
    };
  }

  /**
   * 按优先级排序任务
   */
  private sortTasksByPriority(
    tasks: AgentTask<TInput, TOutput>[]
  ): AgentTask<TInput, TOutput>[] {
    return [...tasks].sort((a, b) => {
      const priorityA = a.priority ?? 0;
      const priorityB = b.priority ?? 0;
      return priorityB - priorityA; // 降序，优先级高的在前
    });
  }

  /**
   * 合并多个 Agent 的执行结果（去重）
   */
  mergeResults<T extends { id?: string; [key: string]: any }>(
    results: T[]
  ): T[] {
    const seen = new Set<string>();
    const merged: T[] = [];

    for (const result of results) {
      const id = result.id || JSON.stringify(result);
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(result);
      }
    }

    logger.info('[AgentCoordinator] Merged results', {
      originalCount: results.length,
      mergedCount: merged.length,
      duplicatesRemoved: results.length - merged.length,
    });

    return merged;
  }

  /**
   * 更新并发限制
   */
  setMaxConcurrency(maxConcurrency: number): void {
    this.config.maxConcurrency = maxConcurrency;
    this.limit = pLimit(maxConcurrency);
    logger.info('[AgentCoordinator] Updated max concurrency', { maxConcurrency });
  }

  private generateSessionId(): string {
    return `coordinator-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }
}
