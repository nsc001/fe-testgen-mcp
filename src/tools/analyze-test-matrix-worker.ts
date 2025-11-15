/**
 * Analyze Test Matrix Worker Tool
 * 使用 Worker 线程分析测试矩阵
 */

import { BaseTool } from '../core/base-tool.js';
import type { ToolMetadata } from '../core/base-tool.js';
import type { TestMatrix } from '../schemas/test-matrix.js';
import { getAppContext } from '../core/app-context.js';
import { OpenAIClient } from '../clients/openai.js';
import { TestMatrixAnalyzer } from '../agents/test-matrix-analyzer.js';
import { logger } from '../utils/logger.js';
import { z } from 'zod';

const ArgsSchema = z.object({
  workspaceId: z.string().describe('工作区 ID'),
  diff: z.string().describe('Git diff 内容'),
  projectConfig: z.object({
    projectRoot: z.string(),
    isMonorepo: z.boolean(),
    testFramework: z.enum(['vitest', 'jest', 'none']).optional(),
    hasExistingTests: z.boolean(),
  }).passthrough().describe('项目配置'),
});

type AnalyzeArgs = z.infer<typeof ArgsSchema>;

interface AnalysisResult {
  features: TestMatrix['features'];
  scenarios: TestMatrix['scenarios'];
}

export class AnalyzeTestMatrixWorkerTool extends BaseTool<AnalyzeArgs, TestMatrix> {
  constructor(
    private openai: OpenAIClient
  ) {
    super();
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'analyze-test-matrix-worker',
      description: `使用 Worker 线程分析代码变更并生成测试矩阵。
      
此工具会在后台 Worker 线程中执行分析任务，避免阻塞主线程。如果 Worker 不可用或失败，会自动回退到直接执行。

参数：
- workspaceId: 工作区 ID（从 fetch-diff-from-repo 获取）
- diff: Git diff 内容
- projectConfig: 项目配置（包含测试框架、项目类型等）

返回：
- features: 检测到的功能列表
- scenarios: 推荐的测试场景列表`,
      inputSchema: {},
    };
  }

  getZodSchema() {
    return ArgsSchema;
  }

  async executeImpl(args: AnalyzeArgs): Promise<TestMatrix> {
    const { workspaceId, diff, projectConfig } = args;

    logger.info('[AnalyzeTestMatrixWorker] Starting analysis', {
      workspaceId,
      diffLength: diff.length,
    });

    const context = getAppContext();
    const workerPool = (context as any).workerPool;

    // 尝试使用 Worker 执行
    if (workerPool && process.env.WORKER_ENABLED !== 'false') {
      try {
        const result: AnalysisResult = await workerPool.executeTask({
          type: 'analyze',
          workspaceId,
          payload: {
            diff,
            projectConfig,
          },
          timeout: 120000, // 2 分钟超时
        });

        logger.info('[AnalyzeTestMatrixWorker] Worker analysis completed', {
          workspaceId,
          featuresCount: result.features.length,
          scenariosCount: result.scenarios.length,
        });

        return this.buildMatrix(result);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('[AnalyzeTestMatrixWorker] Worker failed, falling back to direct execution', {
          workspaceId,
          error: errorMessage,
        });
        // Fall through to direct execution
      }
    }

    // 回退：直接执行
    logger.info('[AnalyzeTestMatrixWorker] Using direct execution', { workspaceId });

    const analyzer = new TestMatrixAnalyzer(this.openai);

    const result = await analyzer.execute({
      diff,
      files: [],
      framework: projectConfig.testFramework,
    });

    const features = result.items.flatMap((item) => item.features) as TestMatrix['features'];
    const scenarios = result.items.flatMap((item) => item.scenarios) as TestMatrix['scenarios'];

    logger.info('[AnalyzeTestMatrixWorker] Direct analysis completed', {
      workspaceId,
      featuresCount: features.length,
      scenariosCount: scenarios.length,
    });

    return this.buildMatrix({ features, scenarios });
  }

  private buildMatrix(result: AnalysisResult): TestMatrix {
    const features = result.features ?? [];
    const scenarios = result.scenarios ?? [];

    const summary = {
      totalFeatures: features.length,
      totalScenarios: scenarios.length,
      estimatedTests: scenarios.reduce((acc, scenario) => acc + (scenario.testCases?.length ?? 1), 0),
      coverage: {
        'happy-path': scenarios.filter((s) => s.scenario === 'happy-path').length,
        'edge-case': scenarios.filter((s) => s.scenario === 'edge-case').length,
        'error-path': scenarios.filter((s) => s.scenario === 'error-path').length,
        'state-change': scenarios.filter((s) => s.scenario === 'state-change').length,
      },
    } as TestMatrix['summary'];

    return {
      features,
      scenarios,
      summary,
    };
  }
}
