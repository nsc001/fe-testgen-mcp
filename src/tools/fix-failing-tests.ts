/**
 * FixFailingTestsTool - 修复失败的测试用例
 * 
 * 职责：
 * 1. 提取失败的测试信息
 * 2. 使用 TestFixAgent 生成修复方案
 * 3. 应用修复到测试文件
 * 4. 重新运行测试验证
 * 5. 支持多轮修复
 */

import { z } from 'zod';
import { BaseTool } from '../core/base-tool.js';
import type { ToolMetadata } from '../core/base-tool.js';
import { TestFixAgent, TestFailure, TestFix } from '../agents/test-fix-agent.js';
import { RunTestsTool, RunTestsOutput } from './run-tests.js';
import { getAppContext } from '../core/app-context.js';
import { logger } from '../utils/logger.js';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

const ArgsSchema = z.object({
  workspaceId: z.string().describe('工作区 ID'),
  projectRoot: z.string().describe('项目根目录'),
  testResults: z.object({
    success: z.boolean(),
    framework: z.string(),
    summary: z.object({
      total: z.number(),
      passed: z.number(),
      failed: z.number(),
      skipped: z.number(),
      duration: z.number(),
    }),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
  }).describe('测试运行结果'),
  maxAttempts: z.number().optional().default(3).describe('最大修复尝试次数'),
});

type FixFailingTestsArgs = z.infer<typeof ArgsSchema>;

interface FixFailingTestsOutput {
  success: boolean;
  fixes: TestFix[];
  retriedResults?: RunTestsOutput;
  attempts: number;
  message: string;
}

export class FixFailingTestsTool extends BaseTool<FixFailingTestsArgs, FixFailingTestsOutput> {
  getMetadata(): ToolMetadata {
    return {
      name: 'fix-failing-tests',
      description: `自动修复失败的测试用例。

此工具会分析失败的测试，生成修复方案，应用修复，并重新运行测试。支持多轮修复（最多 3 次）。

**注意**：此工具只修复测试代码，不会修改被测试的源代码。

参数：
- workspaceId: 工作区 ID
- projectRoot: 项目根目录
- testResults: 测试运行结果（包含失败信息）
- maxAttempts: 最大修复尝试次数（默认 3 次）

返回：
- success: 是否所有测试都通过
- fixes: 应用的修复列表
- retriedResults: 最后一次测试运行结果
- attempts: 实际尝试次数
- message: 结果说明`,
      inputSchema: {},
    };
  }

  getZodSchema() {
    return ArgsSchema;
  }

  async executeImpl(args: FixFailingTestsArgs): Promise<FixFailingTestsOutput> {
    const { workspaceId, projectRoot, testResults, maxAttempts } = args;

    logger.info('[FixFailingTests] Starting test fix process', {
      workspaceId,
      failedTests: testResults.summary.failed,
      maxAttempts,
    });

    // 如果所有测试都通过了，无需修复
    if (testResults.success && testResults.summary.failed === 0) {
      return {
        success: true,
        fixes: [],
        attempts: 0,
        message: '所有测试已通过，无需修复',
      };
    }

    const context = getAppContext();
    const projectDetector = context.projectDetector;
    const openai = context.openai;

    if (!projectDetector || !openai) {
      throw new Error('ProjectDetector 或 OpenAI 客户端未初始化');
    }

    // 获取项目配置
    const projectConfig = await projectDetector.detectProject(projectRoot);

    const allFixes: TestFix[] = [];
    let currentTestResults = testResults;
    let attempts = 0;

    // 多轮修复循环
    while (attempts < maxAttempts && currentTestResults.summary.failed > 0) {
      attempts++;

      logger.info('[FixFailingTests] Attempt', {
        attempt: attempts,
        failedTests: currentTestResults.summary.failed,
      });

      // 1. 提取失败的测试
      const failures = this.extractFailures(currentTestResults, projectRoot);
      
      if (failures.length === 0) {
        logger.warn('[FixFailingTests] No failures extracted from test results');
        break;
      }

      // 2. 读取测试文件内容
      const testFiles = await this.readTestFiles(failures, projectRoot);

      // 3. 使用 TestFixAgent 生成修复
      const fixAgent = new TestFixAgent(openai);
      const fixResult = await fixAgent.executeTestFix({
        failures,
        testFiles,
        projectConfig,
      });

      if (fixResult.items.length === 0) {
        logger.warn('[FixFailingTests] No fixes generated');
        break;
      }

      // 4. 应用修复
      const appliedFixes = await this.applyFixes(fixResult.items, projectRoot);
      allFixes.push(...appliedFixes);

      logger.info('[FixFailingTests] Fixes applied', {
        fixCount: appliedFixes.length,
      });

      // 5. 重新运行测试
      const runTestsTool = new RunTestsTool();
      const retryResult = await runTestsTool.execute({
        projectRoot,
        workspaceId,
        framework: testResults.framework as 'vitest' | 'jest',
      });

      if (!retryResult.success || !retryResult.data) {
        logger.error('[FixFailingTests] Failed to re-run tests');
        break;
      }

      currentTestResults = retryResult.data;

      // 如果所有测试都通过了，退出循环
      if (currentTestResults.success && currentTestResults.summary.failed === 0) {
        logger.info('[FixFailingTests] All tests passed after fixes');
        break;
      }
    }

    const success = currentTestResults.success && currentTestResults.summary.failed === 0;
    const message = success
      ? `成功修复所有测试，共尝试 ${attempts} 次`
      : `尝试了 ${attempts} 次修复，仍有 ${currentTestResults.summary.failed} 个测试失败`;

    logger.info('[FixFailingTests] Fix process completed', {
      success,
      attempts,
      totalFixes: allFixes.length,
      finalFailedCount: currentTestResults.summary.failed,
    });

    return {
      success,
      fixes: allFixes,
      retriedResults: currentTestResults,
      attempts,
      message,
    };
  }

  /**
   * 从测试结果中提取失败信息
   */
  private extractFailures(testResults: RunTestsOutput, projectRoot: string): TestFailure[] {
    const failures: TestFailure[] = [];
    const output = testResults.stdout + '\n' + testResults.stderr;

    // 解析 Vitest 输出
    if (testResults.framework === 'vitest') {
      failures.push(...this.extractVitestFailures(output, projectRoot));
    }
    // 解析 Jest 输出
    else if (testResults.framework === 'jest') {
      failures.push(...this.extractJestFailures(output, projectRoot));
    }

    logger.debug('[FixFailingTests] Extracted failures', {
      count: failures.length,
      framework: testResults.framework,
    });

    return failures;
  }

  /**
   * 提取 Vitest 失败信息
   */
  private extractVitestFailures(output: string, _projectRoot: string): TestFailure[] {
    const failures: TestFailure[] = [];
    const lines = output.split('\n');

    let currentTest: Partial<TestFailure> = {};
    let inStackTrace = false;
    let stackLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 匹配测试名称和文件：FAIL  src/utils/test.spec.ts > should work
      const testMatch = line.match(/FAIL\s+(.+?)\s+>\s+(.+)/);
      if (testMatch) {
        // 保存上一个测试
        if (currentTest.testName && currentTest.testFile) {
          failures.push({
            testName: currentTest.testName,
            testFile: currentTest.testFile,
            errorMessage: currentTest.errorMessage || '',
            stackTrace: stackLines.join('\n'),
          });
        }

        // 开始新测试
        currentTest = {
          testFile: testMatch[1].trim(),
          testName: testMatch[2].trim(),
        };
        stackLines = [];
        inStackTrace = false;
      }

      // 匹配错误信息：AssertionError: expected ... to equal ...
      if (line.includes('Error:') || line.includes('Expected') || line.includes('Received')) {
        if (!currentTest.errorMessage) {
          currentTest.errorMessage = line.trim();
          inStackTrace = true;
        }
      }

      // 收集堆栈跟踪
      if (inStackTrace && (line.includes('at ') || line.includes('⎯⎯⎯'))) {
        stackLines.push(line);
      }
    }

    // 保存最后一个测试
    if (currentTest.testName && currentTest.testFile) {
      failures.push({
        testName: currentTest.testName,
        testFile: currentTest.testFile,
        errorMessage: currentTest.errorMessage || '',
        stackTrace: stackLines.join('\n'),
      });
    }

    return failures;
  }

  /**
   * 提取 Jest 失败信息
   */
  private extractJestFailures(output: string, _projectRoot: string): TestFailure[] {
    const failures: TestFailure[] = [];
    const lines = output.split('\n');

    let currentTest: Partial<TestFailure> = {};
    let inStackTrace = false;
    let stackLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 匹配测试名称：● TestSuite › should work
      const testMatch = line.match(/●\s+(.+?)\s+›\s+(.+)/);
      if (testMatch) {
        // 保存上一个测试
        if (currentTest.testName && currentTest.testFile) {
          failures.push({
            testName: currentTest.testName,
            testFile: currentTest.testFile,
            errorMessage: currentTest.errorMessage || '',
            stackTrace: stackLines.join('\n'),
          });
        }

        // 开始新测试
        currentTest = {
          testName: testMatch[2].trim(),
        };
        stackLines = [];
        inStackTrace = false;
      }

      // 匹配文件路径
      if (line.includes('.spec.') || line.includes('.test.')) {
        const pathMatch = line.match(/([^\s]+\.(spec|test)\.(ts|js|tsx|jsx))/);
        if (pathMatch && !currentTest.testFile) {
          currentTest.testFile = pathMatch[1];
        }
      }

      // 匹配错误信息
      if (line.includes('Error:') || line.includes('Expected') || line.includes('Received')) {
        if (!currentTest.errorMessage) {
          currentTest.errorMessage = line.trim();
          inStackTrace = true;
        }
      }

      // 收集堆栈跟踪
      if (inStackTrace && line.includes('at ')) {
        stackLines.push(line);
      }
    }

    // 保存最后一个测试
    if (currentTest.testName && currentTest.testFile) {
      failures.push({
        testName: currentTest.testName,
        testFile: currentTest.testFile,
        errorMessage: currentTest.errorMessage || '',
        stackTrace: stackLines.join('\n'),
      });
    }

    return failures;
  }

  /**
   * 读取测试文件内容
   */
  private async readTestFiles(
    failures: TestFailure[],
    projectRoot: string
  ): Promise<Map<string, string>> {
    const testFiles = new Map<string, string>();

    const uniqueFiles = [...new Set(failures.map(f => f.testFile))];

    for (const file of uniqueFiles) {
      try {
        const filePath = resolve(projectRoot, file);
        const content = await readFile(filePath, 'utf-8');
        testFiles.set(file, content);
      } catch (error) {
        logger.warn('[FixFailingTests] Failed to read test file', {
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return testFiles;
  }

  /**
   * 应用修复到测试文件
   */
  private async applyFixes(fixes: TestFix[], projectRoot: string): Promise<TestFix[]> {
    const appliedFixes: TestFix[] = [];

    for (const fix of fixes) {
      // 只应用置信度较高的修复
      if (fix.confidence < 0.5) {
        logger.warn('[FixFailingTests] Skipping low confidence fix', {
          file: fix.testFile,
          confidence: fix.confidence,
        });
        continue;
      }

      try {
        const filePath = resolve(projectRoot, fix.testFile);
        await writeFile(filePath, fix.fixedCode, 'utf-8');
        appliedFixes.push(fix);

        logger.info('[FixFailingTests] Applied fix', {
          file: fix.testFile,
          confidence: fix.confidence,
          reason: fix.reason,
        });
      } catch (error) {
        logger.error('[FixFailingTests] Failed to apply fix', {
          file: fix.testFile,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return appliedFixes;
  }
}
