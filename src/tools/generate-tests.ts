import { FetchDiffTool } from './fetch-diff.js';
import { StateManager } from '../state/manager.js';
import { detectProjectTestStack } from './detect-stack.js';
import { TopicIdentifierAgent } from '../agents/topic-identifier.js';
import { Workflow } from '../orchestrator/workflow.js';
import { HappyPathTestAgent } from '../agents/tests/happy-path.js';
import { EdgeCaseTestAgent } from '../agents/tests/edge-case.js';
import { ErrorPathTestAgent } from '../agents/tests/error-path.js';
import { StateChangeTestAgent } from '../agents/tests/state-change.js';
import { OpenAIClient } from '../clients/openai.js';
import { EmbeddingClient } from '../clients/embedding.js';
import { Orchestrator } from '../orchestrator/pipeline.js';
import { BaseAgent } from '../agents/base.js';
import type { Config } from '../config/schema.js';
import type { GenerateTestsInput } from '../schemas/tool-io.js';
import type { TestGenerationResult } from '../schemas/test-plan.js';
import { logger } from '../utils/logger.js';
import { detectProjectRoot, getTestStackDetectionPath } from '../utils/project-root.js';
import { loadRepoPrompt, mergePromptConfigs } from '../utils/repo-prompt.js';
import { getProjectPath } from '../utils/paths.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { glob } from 'glob';

export class GenerateTestsTool {
  private workflow: Workflow;
  private openai: OpenAIClient;
  private manualProjectRoot?: string;
  private globalContextPrompt?: string;
  private currentProjectContext?: string;
  private testAgents: Map<string, BaseAgent<any>>;
  private topicIdentifier: TopicIdentifierAgent;
  private orchestrator: Orchestrator;

  constructor(
    private fetchDiffTool: FetchDiffTool,
    private stateManager: StateManager,
    openai: OpenAIClient,
    embedding: EmbeddingClient,
    config: Config
  ) {
    this.openai = openai;
    this.manualProjectRoot = config.projectRoot || process.env.PROJECT_ROOT;
    
    let globalContextPrompt: string | undefined;
    if (config.projectContextPrompt) {
      try {
        globalContextPrompt = readFileSync(
          getProjectPath(config.projectContextPrompt),
          'utf-8'
        );
        logger.info('Loaded global project context prompt for test generation', {
          path: config.projectContextPrompt,
        });
      } catch (error) {
        logger.warn('Failed to load global project context prompt for test generation', {
          error,
          path: config.projectContextPrompt,
        });
      }
    }
    this.globalContextPrompt = globalContextPrompt;
    this.currentProjectContext = this.globalContextPrompt;
    
    this.topicIdentifier = new TopicIdentifierAgent(openai);
    this.orchestrator = new Orchestrator(
      {
        parallelAgents: config.orchestrator.parallelAgents,
        maxConcurrency: config.orchestrator.maxConcurrency,
        filter: config.filter,
      },
      embedding
    );
    
    this.testAgents = new Map();
    this.testAgents.set('happy-path', new HappyPathTestAgent(this.openai, globalContextPrompt));
    this.testAgents.set('edge-case', new EdgeCaseTestAgent(this.openai, globalContextPrompt));
    this.testAgents.set('error-path', new ErrorPathTestAgent(this.openai, globalContextPrompt));
    this.testAgents.set('state-change', new StateChangeTestAgent(this.openai, globalContextPrompt));

    this.workflow = new Workflow(
      this.topicIdentifier,
      this.orchestrator,
      new Map(),
      this.testAgents
    );

    logger.info('Initialized test agents', {
      hasGlobalPrompt: !!globalContextPrompt,
      promptLength: globalContextPrompt?.length || 0,
    });
  }

  /**
   * 更新所有 Test agents 的项目上下文 prompt
   */
  private updateTestAgentsContext(projectContextPrompt?: string): void {
    if (this.currentProjectContext === projectContextPrompt) {
      return;
    }

    for (const agent of this.testAgents.values()) {
      agent.updateProjectContext(projectContextPrompt);
    }

    this.currentProjectContext = projectContextPrompt;
    
    logger.info('Updated test agents with new project context', {
      hasContext: !!projectContextPrompt,
      contextLength: projectContextPrompt?.length || 0,
    });
  }

  async generate(input: GenerateTestsInput): Promise<TestGenerationResult> {
    const startTime = Date.now();
    const mode = input.mode || 'incremental';
    const forceRefresh = input.forceRefresh || false;

    const diff = await this.fetchDiffTool.fetch({
      revisionId: input.revisionId,
      forceRefresh,
    });

    const frontendDiff = this.fetchDiffTool.filterFrontendFiles(diff);

    const filePaths = frontendDiff.files.map(f => f.path);
    const effectiveProjectRoot = input.projectRoot || this.manualProjectRoot;
    const projectRoot = detectProjectRoot(filePaths, effectiveProjectRoot);
    
    logger.info('Project root detected', {
      root: projectRoot.root,
      isMonorepo: projectRoot.isMonorepo,
      workspaceType: projectRoot.workspaceType,
    });

    let repoProjectContextPrompt: string | undefined;
    try {
      const repoPromptConfig = loadRepoPrompt(projectRoot.root);
      if (repoPromptConfig.found) {
        repoProjectContextPrompt = repoPromptConfig.content;
        logger.info('Using repo-level prompt config for test generation', {
          source: repoPromptConfig.source,
          length: repoPromptConfig.content.length,
        });
      } else {
        logger.debug('No repo-level prompt found for test generation, using global config if available');
      }
    } catch (error) {
      logger.warn('Failed to load repo prompt config for test generation', { error });
    }

    const mergedProjectContextPrompt = mergePromptConfigs(
      this.globalContextPrompt,
      repoProjectContextPrompt,
      undefined
    );

    if (mergedProjectContextPrompt !== this.currentProjectContext) {
      logger.info('Prompt config changed for test generation', {
        previousLength: this.currentProjectContext?.length || 0,
        newLength: mergedProjectContextPrompt?.length || 0,
      });
      this.updateTestAgentsContext(mergedProjectContextPrompt);
    }

    const testDetectionPath = getTestStackDetectionPath(
      projectRoot,
      filePaths[0]
    );
    
    const stack = await detectProjectTestStack(testDetectionPath);
    const framework = stack.unit || 'vitest';
    
    logger.info('Test stack detected', {
      framework,
      detectionPath: testDetectionPath,
    });

    const existingTestContext = await this.findExistingTests(
      frontendDiff,
      projectRoot.root
    );

    const diffFingerprint = this.fetchDiffTool.computeDiffFingerprint(frontendDiff);

    const state = await this.stateManager.initState(
      input.revisionId,
      diff.diffId || '',
      diffFingerprint
    );

    const isIncremental = mode === 'incremental' && state.diffFingerprint === diffFingerprint;
    const existingTests = isIncremental ? state.tests.map(t => ({
      id: t.id,
      file: t.file,
      testFile: '',
      testName: t.testName,
      code: '',
      framework: framework,
      scenario: 'happy-path' as any,
      confidence: 0.7,
    })) : undefined;

    const workflowResult = await this.workflow.executeTestGeneration({
      diff: frontendDiff,
      mode,
      existingTests,
      framework,
      existingTestContext,
    });

    let finalTests = workflowResult.items;
    if (input.maxTests && finalTests.length > input.maxTests) {
      finalTests = finalTests
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, input.maxTests);
    }

    const allTests = [
      ...(existingTests || []),
      ...finalTests,
    ];
    await this.stateManager.updateTests(input.revisionId, allTests);

    const duration = Date.now() - startTime;

    return {
      identifiedScenarios: workflowResult.identifiedTopics,
      tests: finalTests,
      metadata: {
        stack: { unit: framework },
        embeddingUsed: !!existingTestContext,
        duration,
      },
    };
  }

  private async findExistingTests(
    diff: { files: Array<{ path: string }> },
    projectRoot: string
  ): Promise<string | undefined> {
    try {
      const testFiles: string[] = [];
      
      for (const file of diff.files) {
        const testPatterns = [
          join(projectRoot, file.path.replace(/\.(ts|tsx|js|jsx)$/, '.test.$1')),
          join(projectRoot, file.path.replace(/\.(ts|tsx|js|jsx)$/, '.spec.$1')),
          join(projectRoot, file.path.replace(/(.*)\/(.*)$/, '$1/__tests__/$2')),
        ];

        for (const pattern of testPatterns) {
          if (existsSync(pattern)) {
            testFiles.push(pattern);
          }
        }
      }

      const globPatterns = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'];
      for (const pattern of globPatterns) {
        try {
          const files = await glob(pattern, { cwd: projectRoot, ignore: ['node_modules/**'] });
          testFiles.push(...files.slice(0, 3).map(f => join(projectRoot, f)));
        } catch {
          // ignore
        }
      }

      if (testFiles.length === 0) {
        return undefined;
      }

      const contents = testFiles
        .slice(0, 3)
        .map(path => {
          try {
            return readFileSync(path, 'utf-8').substring(0, 2000);
          } catch {
            return '';
          }
        })
        .filter(c => c.length > 0)
        .join('\n\n---\n\n');

      return contents.length > 0 ? contents : undefined;
    } catch (error) {
      logger.warn('Failed to find existing tests', { error });
      return undefined;
    }
  }
}

