/**
 * 从外部传入的 raw diff 进行代码审查
 * 专为 n8n 等外部工作流设计，接受 GitLab/GitHub 等平台的 diff 内容
 */

import { StateManager } from '../state/manager.js';
import { TopicIdentifierAgent } from '../agents/topic-identifier.js';
import { BaseAgent } from '../agents/base.js';
import { Workflow } from '../orchestrator/workflow.js';
import { ReactAgent } from '../agents/cr/react.js';
import { TypeScriptAgent } from '../agents/cr/typescript.js';
import { PerformanceAgent } from '../agents/cr/performance.js';
import { AccessibilityAgent } from '../agents/cr/accessibility.js';
import { SecurityAgent } from '../agents/cr/security.js';
import { CSSAgent } from '../agents/cr/css.js';
import { I18nAgent } from '../agents/cr/i18n.js';
import { TestingSuggestionsAgent } from '../agents/cr/testing-suggestions.js';
import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { Orchestrator } from '../orchestrator/pipeline.js';
import { parseDiff, generateNumberedDiff, findNewLineNumber, validateAndCorrectLineNumber, findLineNumberByCodeSnippet } from '../utils/diff-parser.js';
import { isFrontendFile } from '../schemas/diff.js';
import { computeContentHash } from '../utils/fingerprint.js';
import type { Config } from '../config/schema.js';
import type { ReviewResult } from '../schemas/issue.js';
import type { Diff } from '../schemas/diff.js';
import { logger } from '../utils/logger.js';
import { getProjectPath } from '../utils/paths.js';
import { loadRepoPrompt, mergePromptConfigs } from '../utils/repo-prompt.js';
import { detectProjectRoot } from '../utils/project-root.js';
import { readFileSync } from 'fs';

export interface ReviewRawDiffInput {
  rawDiff: string;
  identifier: string;
  projectRoot: string;
  metadata?: {
    title?: string;
    author?: string;
    mergeRequestId?: string;
    commitHash?: string;
    branch?: string;
  };
  topics?: string[];
  mode?: 'incremental' | 'full';
  forceRefresh?: boolean;
}

export class ReviewRawDiffTool {
  private workflow: Workflow;
  private testingSuggestionsAgent: TestingSuggestionsAgent;
  private openai: OpenAIClient;
  private mergePrompt: string;
  private globalContextPrompt?: string;
  private currentProjectContext?: string;
  private crAgents: Map<string, BaseAgent<any>>;
  private topicIdentifier: TopicIdentifierAgent;
  private orchestrator: Orchestrator;

  constructor(
    private stateManager: StateManager,
    openai: OpenAIClient,
    embedding: EmbeddingClient,
    config: Config
  ) {
    this.openai = openai;

    try {
      this.mergePrompt = readFileSync(
        getProjectPath('src/prompts/comment-merger.md'),
        'utf-8'
      );
    } catch (error) {
      logger.warn('Failed to load comment merger prompt, will use simple concatenation', { error });
      this.mergePrompt = 'Merge multiple code review comments into one unified comment.';
    }

    // 从配置文件加载全局 prompt（优先级最低）
    let globalContextPrompt: string | undefined;
    if (config.projectContextPrompt) {
      try {
        globalContextPrompt = readFileSync(
          getProjectPath(config.projectContextPrompt),
          'utf-8'
        );
        logger.info('Loaded global project context prompt for raw diff review', {
          path: config.projectContextPrompt,
        });
      } catch (error) {
        logger.warn('Failed to load global project context prompt', {
          error,
          path: config.projectContextPrompt,
        });
      }
    }

    this.globalContextPrompt = globalContextPrompt;
    this.currentProjectContext = globalContextPrompt;

    // 初始化工作流相关对象
    this.topicIdentifier = new TopicIdentifierAgent(openai);
    this.orchestrator = new Orchestrator(
      {
        parallelAgents: config.orchestrator.parallelAgents,
        maxConcurrency: config.orchestrator.maxConcurrency,
        filter: config.filter,
      },
      embedding
    );

    // 初始化 CR agents（使用全局配置作为默认值）
    this.crAgents = new Map<string, BaseAgent<any>>();
    this.crAgents.set('react', new ReactAgent(this.openai, globalContextPrompt));
    this.crAgents.set('typescript', new TypeScriptAgent(this.openai, globalContextPrompt));
    this.crAgents.set('performance', new PerformanceAgent(this.openai, globalContextPrompt));
    this.crAgents.set('accessibility', new AccessibilityAgent(this.openai, globalContextPrompt));
    this.crAgents.set('security', new SecurityAgent(this.openai, globalContextPrompt));
    this.crAgents.set('css', new CSSAgent(this.openai, globalContextPrompt));
    this.crAgents.set('i18n', new I18nAgent(this.openai, globalContextPrompt));
    this.testingSuggestionsAgent = new TestingSuggestionsAgent(this.openai, globalContextPrompt);
    this.crAgents.set('testing-suggestions', this.testingSuggestionsAgent);

    this.workflow = new Workflow(
      this.topicIdentifier,
      this.orchestrator,
      this.crAgents,
      new Map()
    );

    logger.info('Initialized raw diff CR tool', {
      hasGlobalPrompt: !!globalContextPrompt,
      promptLength: globalContextPrompt?.length || 0,
    });
  }

  /**
   * 更新所有 CR agents 的项目上下文 prompt
   */
  private updateAllAgentsContext(projectContextPrompt?: string): void {
    if (this.currentProjectContext === projectContextPrompt) {
      return;
    }

    for (const agent of this.crAgents.values()) {
      agent.updateProjectContext(projectContextPrompt);
    }

    this.currentProjectContext = projectContextPrompt;

    logger.info('Updated all agents with new project context', {
      hasContext: !!projectContextPrompt,
      contextLength: projectContextPrompt?.length || 0,
    });
  }

  private async mergeComments(messages: string[]): Promise<string> {
    if (messages.length === 1) {
      return messages[0];
    }

    try {
      const userPrompt = `请合并以下针对同一行代码的多个审查评论：\n\n${messages.map((msg, idx) => `${idx + 1}. ${msg}`).join('\n\n')}\n\n请输出合并后的统一评论，保持格式：[LEVEL] message\\n建议: xxx\\n(confidence=x.xx)`;

      const merged = await this.openai.complete(
        [
          { role: 'system', content: this.mergePrompt },
          { role: 'user', content: userPrompt },
        ],
        {
          temperature: 0.3,
          maxTokens: 500,
        }
      );

      return merged.trim();
    } catch (error) {
      logger.warn('Failed to merge comments with AI, falling back to simple concatenation', { error });
      return messages.map((msg, idx) => `${idx + 1}. ${msg}`).join('\n\n');
    }
  }

  async review(input: ReviewRawDiffInput): Promise<ReviewResult> {
    const startTime = Date.now();
    const { rawDiff, identifier, projectRoot, metadata, mode = 'incremental', forceRefresh = false } = input;

    logger.info('Reviewing raw diff', {
      identifier,
      projectRoot,
      diffLength: rawDiff.length,
      mode,
    });

    // 1. 解析 diff
    const diff = parseDiff(rawDiff, identifier, {
      diffId: metadata?.mergeRequestId || metadata?.commitHash || 'unknown',
      title: metadata?.title || '',
      summary: `Branch: ${metadata?.branch || 'unknown'}`,
      author: metadata?.author || 'unknown',
    });

    diff.numberedRaw = generateNumberedDiff(diff);

    // 2. 过滤前端文件
    const frontendDiff: Diff = {
      ...diff,
      files: diff.files.filter(file => isFrontendFile(file.path)),
    };

    if (frontendDiff.files.length === 0) {
      throw new Error(
        `No frontend files found. Total files: ${diff.files.length}. ` +
        `Frontend extensions: .js, .jsx, .ts, .tsx, .vue, .css, .scss, .less`
      );
    }

    // 3. 计算 diff 指纹
    const diffFingerprint = computeContentHash(
      frontendDiff.files.map(f => `${f.path}:${f.additions}:${f.deletions}`).join('|')
    );

    // 4. 加载仓库级 prompt 配置
    let repoProjectContextPrompt: string | undefined;
    try {
      const filePaths = frontendDiff.files.map(f => f.path);
      const projectRootInfo = detectProjectRoot(filePaths, projectRoot);

      logger.info('Project root detected for raw diff review', {
        root: projectRootInfo.root,
        isMonorepo: projectRootInfo.isMonorepo,
      });

      const repoPromptConfig = loadRepoPrompt(
        projectRootInfo.root,
        frontendDiff.files.map(f => f.path)
      );
      if (repoPromptConfig.found) {
        logger.info('Using repo-level prompt config', {
          source: repoPromptConfig.source,
          length: repoPromptConfig.content.length,
        });
        repoProjectContextPrompt = repoPromptConfig.content;
      }
    } catch (error) {
      logger.warn('Failed to load repo prompt config', { error });
    }

    const mergedProjectContextPrompt = mergePromptConfigs(
      this.globalContextPrompt,
      repoProjectContextPrompt,
      undefined
    );

    if (mergedProjectContextPrompt !== this.currentProjectContext) {
      this.updateAllAgentsContext(mergedProjectContextPrompt);
    }

    // 5. 初始化状态
    const state = await this.stateManager.initState(
      identifier,
      diff.diffId || '',
      diffFingerprint
    );

    const isIncremental = mode === 'incremental' && state.diffFingerprint === diffFingerprint;
    const existingIssues = isIncremental
      ? state.issues.map(i => ({
          id: i.id,
          file: i.file,
          line: i.line,
          codeSnippet: i.codeSnippet,
          severity: i.severity as any,
          topic: i.category as any,
          message: i.message,
          suggestion: '',
          confidence: i.confidence,
        }))
      : undefined;

    // 6. 执行审查工作流
    const workflowResult = await this.workflow.executeReview({
      diff: frontendDiff,
      mode,
      existingIssues,
    });

    // 7. 获取测试建议
    let testingSuggestions = '';
    try {
      const suggestionsResult = await this.testingSuggestionsAgent.execute({
        diff: frontendDiff.raw,
        files: frontendDiff.files.map(f => ({
          path: f.path,
          content: frontendDiff.raw,
        })),
      });
      testingSuggestions = suggestionsResult.items[0] || '';
    } catch (error) {
      logger.warn('Failed to get testing suggestions', { error });
    }

    const allIssues = [...(existingIssues || []), ...workflowResult.items];
    await this.stateManager.updateIssues(identifier, allIssues);

    const duration = Date.now() - startTime;

    logger.info('Raw diff review completed', {
      identifier,
      issuesFound: workflowResult.items.length,
      duration,
    });

    return {
      summary: `Found ${workflowResult.items.length} issues across ${frontendDiff.files.length} files`,
      identifiedTopics: workflowResult.identifiedTopics,
      issues: workflowResult.items,
      testingSuggestions,
      metadata: {
        mode,
        agentsRun: workflowResult.metadata.agentsRun,
        duration,
        cacheHit: !forceRefresh,
      },
    };
  }

  /**
   * 生成用于发布的评论列表（与 review-diff.ts 保持一致的逻辑）
   */
  generatePublishableComments(
    issues: any[],
    frontendDiff: Diff,
    minConfidence = 0.8
  ): Array<{
    file: string;
    line: number;
    message: string;
    issueId: string;
    confidence: number;
  }> {
    const fileMap = new Map(frontendDiff.files.map(f => [f.path, f]));

    return issues
      .filter(issue => issue.confidence >= minConfidence)
      .map(issue => {
        const file = fileMap.get(issue.file);
        if (!file) {
          logger.warn('Issue references non-existent file', {
            issueFile: issue.file,
            availableFiles: Array.from(fileMap.keys()),
          });
          return null;
        }

        let resolvedLine: number | null = null;
        let resolvedSource: 'snippet' | 'line' | 'line-adjusted' | null = null;
        let updatedIssue = issue;

        // 1. 优先使用代码片段匹配
        if (issue.codeSnippet) {
          const snippetLine = findLineNumberByCodeSnippet(file, issue.codeSnippet);
          if (snippetLine !== null) {
            resolvedLine = snippetLine;
            resolvedSource = 'snippet';
          }
        }

        // 2. 回退到行号验证
        if (resolvedLine === null && typeof issue.line === 'number') {
          const validation = validateAndCorrectLineNumber(file, issue.line);
          if (!validation.valid) {
            if (validation.suggestion) {
              resolvedLine = validation.suggestion;
              resolvedSource = 'line-adjusted';
              updatedIssue = {
                ...issue,
                line: validation.suggestion,
                id: `${issue.id}:line-adjusted-${validation.suggestion}`,
              };
            } else {
              return null;
            }
          } else {
            resolvedLine = validation.line ?? issue.line;
            resolvedSource = 'line';
          }
        }

        if (resolvedLine === null) {
          return null;
        }

        // 3. 最终验证
        const newLine = findNewLineNumber(file, resolvedLine);
        if (newLine === null) {
          logger.error('Line validation failed', {
            file: issue.file,
            resolvedLine,
            source: resolvedSource,
          });
          return null;
        }

        updatedIssue = {
          ...updatedIssue,
          line: newLine,
        };

        const parts: string[] = [];
        const severityLabel = issue.severity.toUpperCase();
        parts.push(`[${severityLabel}] ${issue.message}`);

        if (issue.suggestion) {
          parts.push(`建议: ${issue.suggestion}`);
        }

        parts.push(`(confidence=${issue.confidence.toFixed(2)})`);

        const message = parts.join('\n');

        return {
          file: issue.file,
          line: newLine,
          message,
          issueId: updatedIssue.id,
          confidence: issue.confidence,
        };
      })
      .filter((comment): comment is NonNullable<typeof comment> => comment !== null);
  }
}
