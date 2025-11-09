/**
 * ReAct Engine - Agent 执行引擎（Reasoning + Acting）
 *
 * 核心循环：
 * 1. Thought: Agent 思考（调用 LLM）
 * 2. Action: Agent 决定行动（调用工具或返回结果）
 * 3. Observation: 记录观察结果（工具输出）
 * 4. 重复直到任务完成或达到最大步数
 */

import { OpenAIClient } from '../clients/openai.js';
import { ToolRegistry } from './tool-registry.js';
import { AgentContext, ContextStore, Thought, Action, Observation } from './context.js';
import { logger } from '../utils/logger.js';
import { getMetrics } from '../utils/metrics.js';

export interface ReActConfig {
  maxSteps: number;
  temperature: number;
  stopReasons: string[];
  useFunctionCalling?: boolean; // 是否使用 Function Calling（默认 true）
}

export interface ReActResult {
  success: boolean;
  finalAnswer?: unknown;
  error?: string;
  context: AgentContext;
}

/**
 * ReActEngine - 核心执行引擎
 */
export class ReActEngine {
  constructor(
    private llm: OpenAIClient,
    private toolRegistry: ToolRegistry,
    private contextStore: ContextStore,
    private config: ReActConfig
  ) {}

  /**
   * 执行 ReAct 循环
   */
  async run(params: {
    agentName: string;
    task: string;
    systemPrompt: string;
    goal?: string;
    constraints?: string[];
    initialData?: Record<string, unknown>;
  }): Promise<ReActResult> {
    const sessionId = this.generateSessionId();

    // 创建上下文
    const context = this.contextStore.create(sessionId, params.agentName, params.task, {
      goal: params.goal,
      constraints: params.constraints,
      maxSteps: this.config.maxSteps,
      initialData: params.initialData,
    });

    logger.info(`[ReActEngine] Starting session ${sessionId}`, {
      agent: params.agentName,
      task: params.task,
    });

    getMetrics().recordCounter('react.session.started', 1, { agent: params.agentName });

    try {
      while (!context.isComplete && context.currentStep < context.maxSteps) {
        // Step 1: Thought
        const thought = await this.think(context, params.systemPrompt);
        logger.debug(`[ReActEngine] Thought: ${thought.content}`);

        // Step 2: Action
        const action = await this.decide(context, thought);
        logger.debug(`[ReActEngine] Action: ${action.type}`);

        // Step 3: Execute & Observe
        const observation = await this.act(action, context);
        logger.debug(`[ReActEngine] Observation: ${observation.type}`);

        // Record history
        this.contextStore.addHistory(sessionId, { thought, action, observation });

        // Check termination
        if (action.type === 'terminate' || action.type === 'respond') {
          context.isComplete = true;
          break;
        }
      }

      if (context.currentStep >= context.maxSteps) {
        logger.warn(`[ReActEngine] Max steps reached for session ${sessionId}`);
      }

      getMetrics().recordCounter('react.session.completed', 1, {
        agent: params.agentName,
        status: 'success',
      });
      getMetrics().recordHistogram('react.session.steps', context.currentStep, {
        agent: params.agentName,
      });

      return {
        success: true,
        finalAnswer: context.data.finalAnswer,
        context,
      };
    } catch (error) {
      logger.error(`[ReActEngine] Session ${sessionId} failed`, { error });
      getMetrics().recordCounter('react.session.completed', 1, {
        agent: params.agentName,
        status: 'error',
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        context,
      };
    }
  }

  /**
   * Thought: Agent 思考下一步
   */
  private async think(context: AgentContext, systemPrompt: string): Promise<Thought> {
    const historyText = this.formatHistory(context);
    const userPrompt = `
Task: ${context.task}
${context.goal ? `Goal: ${context.goal}` : ''}

History:
${historyText}

Current Step: ${context.currentStep + 1}/${context.maxSteps}

What should I do next? Think step by step.
`;

    let response: string;

    if (this.config.useFunctionCalling !== false) {
      // 使用 Function Calling
      try {
        const tools = await this.buildToolDefinitions();
        const choice = await this.llm.completeWithToolCalls(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          {
            temperature: this.config.temperature,
            tools: tools.length > 0 ? tools : undefined,
            toolChoice: tools.length > 0 ? 'auto' : undefined,
          }
        );

        // 如果有 tool calls，存储到上下文中以便 decide() 使用
        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
          context.data._pendingToolCalls = choice.message.tool_calls;
        }

        response = choice.message.content || JSON.stringify(choice.message.tool_calls);
      } catch (error) {
        logger.warn('[ReActEngine] Function calling failed, falling back to regex parsing', {
          error,
        });
        response = await this.llm.complete(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          { temperature: this.config.temperature }
        );
      }
    } else {
      // 使用正则匹配（fallback）
      response = await this.llm.complete(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { temperature: this.config.temperature }
      );
    }

    return {
      content: response,
      timestamp: Date.now(),
    };
  }

  /**
   * Action: 从 Thought 中提取行动
   */
  private async decide(context: AgentContext, thought: Thought): Promise<Action> {
    // 优先使用 Function Calling 结果
    if (context.data._pendingToolCalls) {
      const toolCalls = context.data._pendingToolCalls as Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;

      if (toolCalls.length > 0) {
        const toolCall = toolCalls[0];
        let parameters: Record<string, unknown> = {};

        try {
          parameters = JSON.parse(toolCall.function.arguments);
        } catch (error) {
          logger.warn('[ReActEngine] Failed to parse tool call arguments', {
            arguments: toolCall.function.arguments,
            error,
          });
        }

        // 清除已使用的 tool calls
        delete context.data._pendingToolCalls;

        return {
          type: 'call_tool',
          toolName: toolCall.function.name,
          parameters,
          timestamp: Date.now(),
        };
      }
    }

    // Fallback: 解析 LLM 输出中的行动指令（正则匹配）
    const content = thought.content;
    const contentLower = content.toLowerCase();

    if (contentLower.includes('call tool:') || contentLower.includes('use tool:')) {
      // 提取工具名和参数（使用原始内容进行匹配，保留大小写）
      const toolMatch = content.match(/(?:call tool|use tool):\s*([\w-]+)/i);
      const toolName = toolMatch ? toolMatch[1] : '';

      // 尝试解析参数
      let parameters: Record<string, unknown> = {};
      const paramsMatch = content.match(/parameters?:\s*(\{[^}]+\}|\{[\s\S]+?\})/i);
      if (paramsMatch) {
        try {
          parameters = JSON.parse(paramsMatch[1]);
        } catch (error) {
          logger.warn('[ReActEngine] Failed to parse parameters from text', {
            text: paramsMatch[1],
            error,
          });
        }
      }

      return {
        type: 'call_tool',
        toolName,
        parameters,
        timestamp: Date.now(),
      };
    }

    if (contentLower.includes('final answer:') || contentLower.includes('complete')) {
      return {
        type: 'terminate',
        message: thought.content,
        timestamp: Date.now(),
      };
    }

    // 默认继续思考
    return {
      type: 'respond',
      message: thought.content,
      timestamp: Date.now(),
    };
  }

  /**
   * Act: 执行行动并返回观察结果
   */
  private async act(action: Action, context: AgentContext): Promise<Observation> {
    if (action.type === 'call_tool' && action.toolName) {
      const tool = await this.toolRegistry.get(action.toolName);
      if (!tool) {
        return {
          type: 'error',
          source: 'system',
          content: `Tool "${action.toolName}" not found`,
          timestamp: Date.now(),
        };
      }

      try {
        const result = await tool.execute(action.parameters || {});
        return {
          type: 'tool_result',
          source: action.toolName,
          content: result,
          timestamp: Date.now(),
        };
      } catch (error) {
        return {
          type: 'error',
          source: action.toolName,
          content: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        };
      }
    }

    if (action.type === 'terminate' || action.type === 'respond') {
      context.data.finalAnswer = action.message;
      return {
        type: 'system_event',
        source: 'engine',
        content: 'Task completed',
        timestamp: Date.now(),
      };
    }

    return {
      type: 'error',
      source: 'engine',
      content: `Unknown action type: ${action.type}`,
      timestamp: Date.now(),
    };
  }

  private formatHistory(context: AgentContext): string {
    return context.history
      .map((entry, idx) => {
        const parts: string[] = [`Step ${idx + 1}:`];
        if (entry.thought) parts.push(`Thought: ${entry.thought.content}`);
        if (entry.action) parts.push(`Action: ${entry.action.type}`);
        if (entry.observation) parts.push(`Observation: ${JSON.stringify(entry.observation.content)}`);
        return parts.join('\n');
      })
      .join('\n\n');
  }

  private async buildToolDefinitions(): Promise<
    Array<{
      type: 'function';
      function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
      };
    }>
  > {
    const metadataList = this.toolRegistry.listMetadata();

    return metadataList.map((metadata) => {
      const parameters = metadata.inputSchema && Object.keys(metadata.inputSchema).length > 0
        ? metadata.inputSchema
        : {
            type: 'object',
            properties: {},
          };

      return {
        type: 'function' as const,
        function: {
          name: metadata.name,
          description: metadata.description,
          parameters,
        },
      };
    });
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }
}
