/**
 * GenerateGenTestRuleTool - 生成 gen-test MCP 规则草稿
 *
 * 在当前工作区内生成 `.cursor/rules/test-strategy.md`，结合可探测信息自动填充，
 * 其余字段提供默认值与 TODO 注释，提醒用户自行校正。
 */

import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

import { BaseTool } from '../core/base-tool.js';
import type { ToolMetadata } from '../core/base-tool.js';
import { getAppContext } from '../core/app-context.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ArgsSchema = z.object({
  workspaceId: z.string().describe('工作区 ID'),
  outputPath: z
    .string()
    .optional()
    .default('.cursor/rules/test-strategy.md')
    .describe('输出路径（相对于项目根目录）'),
});

type GenerateGenTestRuleArgs = z.infer<typeof ArgsSchema>;

interface GenerateGenTestRuleOutput {
  filePath: string;
  content: string;
  note: string;
}

export class GenerateGenTestRuleTool extends BaseTool<GenerateGenTestRuleArgs, GenerateGenTestRuleOutput> {
  getMetadata(): ToolMetadata {
    return {
      name: 'generate-gen-test-rule',
      description: `生成 gen-test MCP 规则草稿文件（默认 .cursor/rules/test-strategy.md），在 Cursor 中可通过「帮我配置下 gen-test mcp」快捷触发。

此工具会自动写入可探测的信息（仓库/分支、monorepo 类型、测试框架、测试模式等），其余字段提供默认值与 TODO 注释，提示用户手动调整。

**参数**：
- workspaceId: 工作区 ID（从 fetch-diff-from-repo 获取）
- outputPath: 输出路径（默认 .cursor/rules/test-strategy.md）

**返回**：
- filePath: 生成的文件路径
- content: 文件内容
- note: 提醒用户检查并补充 TODO 片段`,
      inputSchema: {},
    };
  }

  getZodSchema() {
    return ArgsSchema;
  }

  async executeImpl(args: GenerateGenTestRuleArgs): Promise<GenerateGenTestRuleOutput> {
    const { workspaceId, outputPath } = args;
    const context = getAppContext();
    const { workspaceManager, projectDetector } = context;

    logger.info('[GenerateGenTestRule] Generating gen-test rules', { workspaceId, outputPath });

    if (!workspaceManager) {
      throw new Error('WorkspaceManager not initialized');
    }
    if (!projectDetector) {
      throw new Error('ProjectDetector not initialized');
    }

    const workspace = workspaceManager.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const projectConfig = await projectDetector.detectProject(
      workspace.workDir,
      workspace.packageRoot,
      []
    );

    logger.info('[GenerateGenTestRule] Project config retrieved', {
      isMonorepo: projectConfig.isMonorepo,
      testFramework: projectConfig.testFramework,
      packageRoot: projectConfig.packageRoot || workspace.packageRoot,
    });

    const templatePath = resolve(__dirname, '../../docs/gen-test-rule-template.md');
    let template: string;

    try {
      template = await readFile(templatePath, 'utf-8');
    } catch (error) {
      logger.error('[GenerateGenTestRule] Failed to read template', { error });
      throw new Error(`Failed to read gen-test rule template: ${templatePath}`);
    }

    const content = this.populateTemplate(template, {
      workspace,
      projectConfig,
    });

    const absoluteOutputPath = resolve(workspace.workDir, outputPath);
    const outputDir = dirname(absoluteOutputPath);

    try {
      if (!existsSync(outputDir)) {
        await mkdir(outputDir, { recursive: true });
      }

      await writeFile(absoluteOutputPath, content, 'utf-8');

      logger.info('[GenerateGenTestRule] Rule file generated', {
        filePath: absoluteOutputPath,
        workspaceId,
      });

      return {
        filePath: outputPath,
        content,
        note: '规则为自动生成草稿，请按照文件中的 TODO 与注释手动校正后再使用。',
      };
    } catch (error) {
      logger.error('[GenerateGenTestRule] Failed to write file', { error });
      throw new Error(`Failed to write gen-test rule file: ${absoluteOutputPath}`);
    }
  }

  /**
   * 填充模板变量
   */
  private populateTemplate(
    template: string,
    data: {
      workspace: any;
      projectConfig: any;
    }
  ): string {
    const { workspace, projectConfig } = data;

    const replacements: Record<string, string> = {
      '{{PROJECT_NAME}}': this.extractProjectName(workspace.repoUrl),
      '{{GENERATED_AT}}': new Date().toISOString(),
      '{{REPO_URL}}': workspace.repoUrl || 'N/A',
      '{{BRANCH}}': workspace.sourceBranch || workspace.branch || 'N/A',
      '{{BASELINE_BRANCH}}': workspace.baselineBranch || 'main',
      '{{PROJECT_TYPE}}': projectConfig.isMonorepo ? 'Monorepo' : '单仓库',
      '{{MONOREPO_TYPE}}': projectConfig.monorepoType || 'N/A',
      '{{PACKAGE_ROOT}}': projectConfig.packageRoot || workspace.packageRoot || projectConfig.projectRoot || '（填写主要子项目根目录）',
      '{{AFFECTED_SUBPROJECTS}}': this.formatList(projectConfig.affectedSubProjects || workspace.affectedSubProjects),
      '{{TESTABLE_SUBPROJECTS}}': this.formatList(projectConfig.testableSubProjects || workspace.testableSubProjects),
      '{{TEST_FRAMEWORK}}': projectConfig.testFramework || 'vitest',
      '{{TEST_PATTERN}}': projectConfig.testPattern || '**/*.{test,spec}.{ts,tsx,js,jsx}',
      '{{HAS_EXISTING_TESTS}}': projectConfig.hasExistingTests ? '是' : '否',
      '{{MAX_TESTS}}': process.env.MAX_TESTS || '10',
      '{{MAX_FIX_ATTEMPTS}}': process.env.FIX_MAX_ATTEMPTS || '3',
      '{{FIX_CONFIDENCE_THRESHOLD}}': process.env.FIX_CONFIDENCE_THRESHOLD || '0.5',
    };

    let result = template;
    for (const [key, value] of Object.entries(replacements)) {
      result = result.replace(new RegExp(key, 'g'), value);
    }

    return result;
  }

  /**
   * 从仓库 URL 提取项目名称
   */
  private extractProjectName(repoUrl: string): string {
    if (!repoUrl) {
      return 'Unknown Project';
    }

    if (!repoUrl.startsWith('http') && !repoUrl.startsWith('git@')) {
      const parts = repoUrl.split('/');
      return parts[parts.length - 1] || 'Local Project';
    }

    const match = repoUrl.match(/\/([^\/]+?)(\.git)?$/);
    if (match && match[1]) {
      return match[1];
    }

    return 'Unknown Project';
  }

  /**
   * 格式化列表
   */
  private formatList(items?: string[]): string {
    if (!items || items.length === 0) {
      return '  - 无';
    }

    return items.map((item) => `  - ${item}`).join('\n');
  }
}
