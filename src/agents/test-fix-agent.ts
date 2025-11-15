/**
 * TestFixAgent - 测试用例修复 Agent
 * 
 * 职责：
 * 1. 分析失败的测试用例
 * 2. 生成修复后的测试代码
 * 3. 只修复测试代码，不修改源代码
 */

import { OpenAIClient } from '../clients/openai.js';
import { BaseAgent, AgentResult } from './base.js';
import { logger } from '../utils/logger.js';
import type { ProjectConfig } from '../orchestrator/project-detector.js';

/**
 * 测试失败信息
 */
export interface TestFailure {
  testName: string;
  testFile: string;
  errorMessage: string;
  stackTrace: string;
}

/**
 * 测试修复上下文
 */
export interface TestFixContext {
  failures: TestFailure[];
  testFiles: Map<string, string>;
  projectConfig: ProjectConfig;
}

/**
 * 测试修复结果
 */
export interface TestFix {
  testFile: string;
  originalCode: string;
  fixedCode: string;
  reason: string;
  confidence: number;
}

export class TestFixAgent extends BaseAgent<TestFix> {
  constructor(openai: OpenAIClient) {
    super(openai, {
      name: 'test-fix-agent',
      promptPath: '', // 不使用外部 prompt 文件
      description: '测试用例修复 Agent',
    });
  }

  getName(): string {
    return 'test-fix-agent';
  }

  /**
   * BaseAgent 要求的抽象方法实现（不使用）
   */
  async execute(_context: {
    diff: string;
    files: Array<{ path: string; content: string }>;
    metadata?: Record<string, unknown>;
  }): Promise<AgentResult<TestFix>> {
    throw new Error('Use executeTestFix instead');
  }

  /**
   * 执行测试修复（实际使用的方法）
   */
  async executeTestFix(context: TestFixContext): Promise<AgentResult<TestFix>> {
    const { failures, testFiles, projectConfig } = context;

    logger.info('[TestFixAgent] Analyzing test failures', {
      failureCount: failures.length,
      testFileCount: testFiles.size,
    });

    const fixes: TestFix[] = [];

    for (const failure of failures) {
      const testFileContent = testFiles.get(failure.testFile);
      if (!testFileContent) {
        logger.warn('[TestFixAgent] Test file not found', { file: failure.testFile });
        continue;
      }

      try {
        const fix = await this.generateFix(failure, testFileContent, projectConfig);
        if (fix) {
          fixes.push(fix);
        }
      } catch (error) {
        logger.error('[TestFixAgent] Failed to generate fix', {
          testFile: failure.testFile,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const avgConfidence = fixes.length > 0
      ? fixes.reduce((sum, fix) => sum + fix.confidence, 0) / fixes.length
      : 0;

    logger.info('[TestFixAgent] Fix generation completed', {
      fixCount: fixes.length,
      avgConfidence,
    });

    return {
      items: fixes,
      confidence: avgConfidence,
    };
  }

  /**
   * 生成单个测试文件的修复
   */
  private async generateFix(
    failure: TestFailure,
    testFileContent: string,
    projectConfig: ProjectConfig
  ): Promise<TestFix | null> {
    const systemPrompt = this.buildSystemPrompt(projectConfig);
    const userPrompt = this.buildUserPrompt(failure, testFileContent);

    logger.debug('[TestFixAgent] Generating fix', {
      testFile: failure.testFile,
      testName: failure.testName,
    });

    try {
      const response = await this.openai.complete(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          responseFormat: { type: 'json_object' },
        }
      );

      // 清理响应
      let cleanedResponse = response.trim();
      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      const result = JSON.parse(cleanedResponse);

      logger.debug('[TestFixAgent] Fix generated', {
        testFile: failure.testFile,
        confidence: result.confidence,
      });

      return {
        testFile: failure.testFile,
        originalCode: testFileContent,
        fixedCode: result.fixedCode || testFileContent,
        reason: result.reason || 'Unknown reason',
        confidence: result.confidence || 0.5,
      };
    } catch (error) {
      logger.error('[TestFixAgent] Failed to parse fix response', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * 构建系统 Prompt
   */
  private buildSystemPrompt(projectConfig: ProjectConfig): string {
    return `你是一个专业的前端测试工程师，擅长修复失败的测试用例。

## 核心原则

1. **只修复测试代码**：不修改被测试的源代码，只调整测试本身
2. **最小化修改**：尽可能少地修改测试代码，保持测试的原始意图
3. **保持测试意图**：确保修复后的测试仍然验证正确的行为
4. **合理置信度**：对修复方案进行置信度评估（0-1）

## 常见失败场景与修复方法

### 1. Mock 问题
**症状**：\`TypeError: x.method is not a function\`、\`Cannot read property 'x' of undefined\`
**原因**：Mock 对象不完整，缺少必要的方法或属性
**修复**：
- 补充缺失的 Mock 方法
- 使用 \`vi.fn()\` 或 \`jest.fn()\` 创建模拟函数
- 为 Mock 对象添加缺失的属性

### 2. 异步问题
**症状**：测试提前结束、Promise 未等待、\`act\` 警告
**原因**：缺少 \`await\` 或异步状态更新未完成
**修复**：
- 添加 \`await\` 关键字
- 使用 \`waitFor\`、\`findBy*\` 等异步查询
- 在 React Testing Library 中使用 \`act\`

### 3. 断言过严
**症状**：期望值与实际值略有差异
**原因**：断言对格式、顺序、精确值要求过于严格
**修复**：
- 使用更宽松的匹配器（如 \`toContain\` 而非 \`toBe\`）
- 使用 \`toMatchObject\` 部分匹配
- 对数字使用 \`toBeCloseTo\`
- 忽略不重要的属性（如时间戳）

### 4. 环境问题
**症状**：\`document is not defined\`、\`window is not defined\`
**原因**：测试环境缺少浏览器 API
**修复**：
- 添加环境检查或 polyfill
- 使用 \`@testing-library/jest-dom\`
- 配置 \`testEnvironment: 'jsdom'\`

### 5. 状态问题
**症状**：测试间相互影响、状态未重置
**原因**：全局状态未清理、Mock 未重置
**修复**：
- 添加 \`beforeEach\` / \`afterEach\` 清理逻辑
- 使用 \`vi.clearAllMocks()\` 或 \`jest.clearAllMocks()\`
- 重置模块：\`vi.resetModules()\`

### 6. 导入问题
**症状**：\`Cannot find module\`、导入路径错误
**原因**：路径别名、扩展名、相对路径错误
**修复**：
- 修正导入路径
- 添加文件扩展名
- 检查路径别名配置

## 测试框架信息

- **当前框架**：${projectConfig.testFramework || 'vitest'}
- **项目类型**：${projectConfig.isMonorepo ? 'Monorepo' : '单仓库'}
- **已有测试**：${projectConfig.hasExistingTests ? '是' : '否'}

## 输出格式

返回 JSON 格式的修复方案：

\`\`\`json
{
  "fixedCode": "完整的修复后的测试文件代码",
  "reason": "修复原因说明（中文，简洁明了）",
  "confidence": 0.85
}
\`\`\`

**置信度说明**：
- 0.9-1.0：非常确定，修复方法标准且明确
- 0.7-0.9：比较确定，常见问题，修复可靠
- 0.5-0.7：中等确定，需要一些假设
- 0.3-0.5：不太确定，可能需要更多上下文
- 0.0-0.3：很不确定，建议人工检查

## 注意事项

1. 保持原测试文件的结构和风格
2. 不要添加不必要的注释
3. 确保修复后代码语法正确
4. 如果无法确定修复方案，降低置信度而非盲目修改`;
  }

  /**
   * 构建用户 Prompt
   */
  private buildUserPrompt(failure: TestFailure, testFileContent: string): string {
    return `# 测试失败信息

**测试文件**：\`${failure.testFile}\`
**测试名称**：\`${failure.testName}\`

## 错误信息

\`\`\`
${failure.errorMessage}
\`\`\`

## 堆栈跟踪

\`\`\`
${failure.stackTrace}
\`\`\`

## 当前测试代码

\`\`\`typescript
${testFileContent}
\`\`\`

---

请分析失败原因并生成修复后的测试代码。`;
  }
}
