/**
 * MCP Server V2 - 集成新架构
 *
 * 这是一个示例文件，展示如何使用新架构组件。
 * 当前与 index.ts 并存，待验证稳定后逐步替换。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';

// 核心组件
import { ToolRegistry } from './core/tool-registry.js';
import { ContextStore, Memory } from './core/context.js';
import { ReActEngine } from './core/react-engine.js';
import { PipelineExecutor, PipelineLoader } from './core/pipeline.js';
import { initializeMetrics, getMetrics } from './utils/metrics.js';

// 客户端
import { OpenAIClient } from './clients/openai.js';
import { PhabricatorClient } from './clients/phabricator.js';
import { EmbeddingClient } from './clients/embedding.js';
import { Cache } from './cache/cache.js';
import { StateManager } from './state/manager.js';

// V2 工具
import { FetchDiffToolV2 } from './tools/v2/fetch-diff.js';

// V2 Agent (imported for type checking, will be used in future)
// import { TestAgentV2 } from './agents/v2/test-agent.js';

// 配置
import { getEnv, validateAiConfig } from './config/env.js';
import { loadConfig } from './config/loader.js';
import { logger } from './utils/logger.js';

dotenv.config();

// 全局实例
let config: ReturnType<typeof loadConfig>;
let openaiClient: OpenAIClient;
let phabClient: PhabricatorClient;
let cache: Cache;
let toolRegistry: ToolRegistry;
let contextStore: ContextStore;
let memory: Memory;

/**
 * 初始化系统
 */
function initializeV2() {
  try {
    // 1. 加载配置
    getEnv();
    config = loadConfig();
    const validation = validateAiConfig({
      llm: {
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseURL,
        model: config.llm.model,
      },
      embedding: {
        baseURL: config.embedding.baseURL || config.llm.baseURL,
        model: config.embedding.model,
        enabled: config.embedding.enabled,
      },
    });

    if (validation.errors.length > 0) {
      logger.error('AI configuration validation failed', { errors: validation.errors });
      throw new Error(
        `AI 配置验证失败:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`
      );
    }

    // 2. 初始化 Metrics
    initializeMetrics();

    // 3. 初始化客户端
    openaiClient = new OpenAIClient({
      apiKey: config.llm.apiKey,
      baseURL: config.llm.baseURL,
      model: config.llm.model,
      temperature: config.llm.temperature,
      topP: config.llm.topP,
      maxTokens: config.llm.maxTokens,
    });

    phabClient = new PhabricatorClient({
      host: config.phabricator.host,
      token: config.phabricator.token,
    });

    const embeddingClient = new EmbeddingClient({
      apiKey: config.llm.apiKey,
      baseURL: config.embedding.baseURL || config.llm.baseURL,
      model: config.embedding.model,
    });

    cache = new Cache({
      dir: config.cache.dir,
      ttl: config.cache.ttl,
    });

    const stateManager = new StateManager({
      dir: config.state.dir,
    });

    // 4. 初始化核心组件
    toolRegistry = new ToolRegistry();
    contextStore = new ContextStore();
    memory = new Memory();

    // 5. 注册 V2 工具
    toolRegistry.register(new FetchDiffToolV2(phabClient, cache));
    // TODO: 注册更多 V2 工具

    // 6. 初始化 ReActEngine
    const reactEngine = new ReActEngine(
      openaiClient,
      toolRegistry,
      contextStore,
      {
        maxSteps: 10,
        temperature: 0.7,
        stopReasons: ['TERMINATE', 'ERROR'],
      }
    );

    // 7. 初始化 PipelineExecutor
    const pipelineExecutor = new PipelineExecutor(toolRegistry);
    const pipelineLoader = new PipelineLoader();
    const pipelines = pipelineLoader.loadFromFile('./config/pipelines.yaml');

    if (config.embedding.enabled && embeddingClient) {
      getMetrics().recordCounter('embedding.client.initialized', 1);
    }

    if (reactEngine) {
      getMetrics().recordGauge('react.engine.max_steps', reactEngine['config']?.maxSteps ?? 10);
    }

    if (stateManager) {
      memory.set('state-dir', { dir: config.state.dir });
    }

    if (pipelineExecutor) {
      getMetrics().recordGauge('pipeline.registered_tools', toolRegistry.list().length);
    }

    logger.info('V2 components ready', {
      toolCount: toolRegistry.list().length,
      pipelines: pipelines.size,
      embeddingEnabled: config.embedding.enabled,
      stateDir: config.state.dir,
    });

    logger.info('V2 initialization complete');
    getMetrics().recordCounter('server.initialization.success', 1);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('V2 initialization failed', {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });
    getMetrics().recordCounter('server.initialization.failed', 1);
    throw error;
  }
}

/**
 * 创建 MCP Server
 */
const server = new Server(
  {
    name: 'fe-testgen-mcp-v2',
    version: '2.0.0-alpha',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * ListTools - 从 ToolRegistry 动态生成
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const metadata = toolRegistry.listMetadata();

  return {
    tools: metadata.map(meta => ({
      name: meta.name,
      description: meta.description,
      inputSchema: meta.inputSchema,
    })),
  };
});

/**
 * CallTool - 统一调用入口
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  logger.info(`[V2] Tool called: ${name}`, { args });
  getMetrics().recordCounter('tool.called', 1, { tool: name });

  try {
    const tool = toolRegistry.get(name);
    if (!tool) {
      throw new Error(`Tool "${name}" not found`);
    }

    const result = await tool.execute(args || {});
    return tool.formatResponse(result);
  } catch (error) {
    logger.error(`[V2] Tool ${name} failed`, { error });
    getMetrics().recordCounter('tool.failed', 1, { tool: name });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
    };
  }
});

/**
 * 主入口
 */
async function main() {
  try {
    initializeV2();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('fe-testgen-mcp V2 server started');
    getMetrics().recordCounter('server.started', 1);
  } catch (error) {
    logger.error('V2 server failed to start', { error });
    getMetrics().recordCounter('server.start.failed', 1);
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down...');
  getMetrics().recordCounter('server.shutdown', 1);
  // 清理资源
  memory.cleanup();
  process.exit(0);
});

main().catch((error) => {
  logger.error('Fatal error', { error });
  process.exit(1);
});
