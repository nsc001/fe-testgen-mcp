# 迁移指南：从 V1 到 V2

本文档指导如何将现有工具和 Agent 从 V1 架构迁移到 V2 架构。

## 目录

- [为什么要迁移到 V2？](#为什么要迁移到-v2)
- [迁移策略](#迁移策略)
- [迁移工具](#迁移工具)
- [迁移 Agent](#迁移-agent)
- [迁移工作流](#迁移工作流)
- [测试与验证](#测试与验证)
- [常见问题](#常见问题)

---

## 为什么要迁移到 V2？

### V2 的优势

1. **统一抽象**：BaseTool 减少 80% 模板代码
2. **自动化监控**：内置 metrics 和日志
3. **更好的错误处理**：统一的生命周期钩子
4. **可组合性**：Pipeline DSL 支持声明式编排
5. **ReAct 模式**：Agent 具备自主决策能力
6. **长期记忆**：Context & Memory 支持跨会话

### 何时迁移？

- ✅ 新增工具/Agent → 直接使用 V2
- ✅ 现有工具需要增强（监控、错误处理）→ 迁移到 V2
- ✅ 工作流需要配置化 → 使用 Pipeline DSL
- ⚠️ 现有工具运行稳定且无需改动 → 暂缓迁移

---

## 迁移策略

### 渐进式迁移（推荐）

1. **保留 V1**：V1 代码保持不变，继续工作
2. **V2 并行**：V2 工具放在 `src/tools/v2/` 目录
3. **逐步替换**：验证 V2 工具稳定后，逐步替换 V1
4. **最终清理**：所有工具迁移完成后，删除 V1 代码

### 目录结构

```
src/
├── tools/              # V1 工具（保留）
│   ├── fetch-diff.ts
│   └── review-diff.ts
├── tools/v2/           # V2 工具（新增）
│   ├── fetch-diff.ts
│   └── review-diff.ts
├── agents/             # V1 Agent（保留）
│   └── cr/
├── agents/v2/          # V2 Agent（新增）
│   └── test-agent.ts
└── core/               # V2 核心组件
    ├── base-tool.ts
    ├── tool-registry.ts
    ├── react-engine.ts
    └── pipeline.ts
```

---

## 迁移工具

### 步骤 1: 创建 V2 工具

**V1 工具示例**（`src/tools/fetch-diff.ts`）：

```typescript
export class FetchDiffTool {
  constructor(
    private phabClient: PhabricatorClient,
    private cache: Cache
  ) {}

  async fetch(options: FetchDiffOptions): Promise<Diff> {
    const { revisionId, forceRefresh = false } = options;
    
    try {
      logger.info(`Fetching diff ${revisionId}...`);
      
      // 业务逻辑
      const diff = await this.phabClient.getRawDiff(revisionId);
      
      logger.info(`Fetched diff`);
      return diff;
    } catch (error) {
      logger.error('Fetch failed', { error });
      throw error;
    }
  }
}
```

**V2 工具示例**（`src/tools/v2/fetch-diff.ts`）：

```typescript
import { BaseTool, ToolMetadata } from '../../core/base-tool.js';

export interface FetchDiffInput {
  revisionId: string;
  forceRefresh?: boolean;
}

export interface FetchDiffOutput {
  diff: Diff;
  source: 'cache' | 'phabricator';
}

export class FetchDiffToolV2 extends BaseTool<FetchDiffInput, FetchDiffOutput> {
  constructor(
    private phabClient: PhabricatorClient,
    private cache: Cache
  ) {
    super();
  }

  getMetadata(): ToolMetadata {
    return {
      name: 'fetch-diff',
      description: '从 Phabricator 获取 diff',
      inputSchema: {
        type: 'object',
        properties: {
          revisionId: { type: 'string' },
          forceRefresh: { type: 'boolean' },
        },
        required: ['revisionId'],
      },
      category: 'code-retrieval',
      version: '2.0.0',
    };
  }

  protected async executeImpl(input: FetchDiffInput): Promise<FetchDiffOutput> {
    // ✅ 日志、错误处理、metrics 由 BaseTool 自动处理
    // 只需编写核心业务逻辑
    const { revisionId, forceRefresh = false } = input;
    
    if (!forceRefresh) {
      const cached = await this.cache.get<Diff>(`diff:${revisionId}`);
      if (cached) {
        return { diff: cached, source: 'cache' };
      }
    }
    
    const { diffId, raw } = await this.phabClient.getRawDiff(revisionId);
    const diff = parseDiff(raw, revisionId, { diffId });
    await this.cache.set(`diff:${revisionId}`, diff);
    
    return { diff, source: 'phabricator' };
  }

  // 可选：添加验证
  protected async beforeExecute(input: FetchDiffInput): Promise<void> {
    if (!input.revisionId.match(/^D\d+$/i)) {
      throw new Error(`Invalid revision ID: ${input.revisionId}`);
    }
  }

  // 向后兼容：保留旧接口
  async fetch(input: FetchDiffInput): Promise<Diff> {
    const result = await this.execute(input);
    if (!result.success || !result.data) {
      throw new Error(result.error || 'Failed to fetch diff');
    }
    return result.data.diff;
  }
}
```

### 步骤 2: 注册到 ToolRegistry

```typescript
// src/index-v2.ts 或任何初始化文件
import { ToolRegistry } from './core/tool-registry.js';
import { FetchDiffToolV2 } from './tools/v2/fetch-diff.js';

const registry = new ToolRegistry();
registry.register(new FetchDiffToolV2(phabClient, cache));
```

### 步骤 3: 测试

```typescript
// src/tools/v2/fetch-diff.test.ts
import { describe, it, expect } from 'vitest';
import { FetchDiffToolV2 } from './fetch-diff.js';

describe('FetchDiffToolV2', () => {
  it('should fetch diff successfully', async () => {
    const tool = new FetchDiffToolV2(phabClient, cache);
    const result = await tool.execute({ revisionId: 'D123456' });
    
    expect(result.success).toBe(true);
    expect(result.data?.diff).toBeDefined();
  });
});
```

---

## 迁移 Agent

### 步骤 1: 使用 ReActEngine（推荐）

**V1 Agent**（单次 LLM 调用）：

```typescript
export class ReactAgent extends BaseAgent<Issue> {
  async execute(context): Promise<{ items: Issue[]; confidence: number }> {
    const prompt = this.buildPrompt(context.diff, context.files);
    const response = await this.callLLM(this.prompt, prompt);
    const issues = this.parseResponse(response);
    return { items: issues, confidence: 0.8 };
  }
}
```

**V2 Agent**（ReAct 循环）：

```typescript
export class ReviewAgentV2 {
  async review(revisionId: string): Promise<ReviewResult> {
    const engine = new ReActEngine(llm, toolRegistry, contextStore, {
      maxSteps: 10,
      temperature: 0.7,
    });

    return await engine.run({
      agentName: 'review-agent',
      task: `Review code changes in ${revisionId}`,
      systemPrompt: `You are a code review agent.
      
Available tools:
- fetch-diff: Get diff content
- analyze-code: Analyze code for issues
- publish-comments: Publish review comments

Think step by step:
1. Fetch the diff
2. Analyze for issues
3. Decide whether to publish
`,
      goal: 'Find potential bugs and suggest improvements',
    });
  }
}
```

### 步骤 2: 使用 CodeChangeSource

**V1**（硬编码 Phabricator）：

```typescript
const diff = await fetchDiffTool.fetch({ revisionId });
```

**V2**（抽象变更来源）：

```typescript
import { PhabricatorDiffSource, GitCommitSource } from './core/code-change-source.js';

// Phabricator
const source = new PhabricatorDiffSource('D123456', fetchDiffFn);

// Git
const source = new GitCommitSource('abc123', '/path/to/repo', fetchCommitFn);

// 统一接口
const diff = await source.fetchChanges();
```

---

## 迁移工作流

### V1: 硬编码流程

```typescript
// src/tools/review-diff.ts
async review(input) {
  // 1. Fetch diff
  const diff = await this.fetchDiffTool.fetch({ revisionId });
  
  // 2. Review
  const issues = await this.orchestrator.executeReview({...});
  
  // 3. Publish
  if (input.publish) {
    await this.publishCommentsTool.publish({...});
  }
  
  return issues;
}
```

### V2: Pipeline DSL

**定义工作流**（`config/pipelines.yaml`）：

```yaml
pipelines:
  review:
    description: "前端代码审查流程"
    steps:
      - name: fetchDiff
        type: tool
        ref: fetch-diff
        input:
          revisionId: "{{context.revisionId}}"
      
      - name: review
        type: tool
        ref: review-frontend-diff
        input:
          revisionId: "{{context.revisionId}}"
          mode: "{{context.mode || 'full'}}"
      
      - name: publish
        type: tool
        ref: publish-phabricator-comments
        input:
          revisionId: "{{context.revisionId}}"
          comments: "{{steps.review.data.issues}}"
        condition: "context.publish"
        onError: "continue"
```

**执行工作流**：

```typescript
const loader = new PipelineLoader();
const pipelines = loader.loadFromFile('./config/pipelines.yaml');

const executor = new PipelineExecutor(toolRegistry);
const result = await executor.execute(pipelines.get('review')!, {
  revisionId: 'D123456',
  mode: 'incremental',
  publish: true,
});
```

---

## 测试与验证

### 1. 单元测试

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('MyToolV2', () => {
  it('should execute successfully', async () => {
    const tool = new MyToolV2(mockDeps);
    const result = await tool.execute(mockInput);
    
    expect(result.success).toBe(true);
  });

  it('should handle errors', async () => {
    const tool = new MyToolV2(mockDeps);
    vi.spyOn(mockDeps, 'doSomething').mockRejectedValue(new Error('Test error'));
    
    const result = await tool.execute(mockInput);
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('Test error');
  });

  it('should record metrics', async () => {
    const tool = new MyToolV2(mockDeps);
    await tool.execute(mockInput);
    
    expect(getMetrics().export()).toContainEqual(
      expect.objectContaining({ name: 'tool.execution.started' })
    );
  });
});
```

### 2. 集成测试

```typescript
describe('Pipeline Integration', () => {
  it('should execute review pipeline', async () => {
    const executor = new PipelineExecutor(toolRegistry);
    const result = await executor.execute(reviewPipeline, {
      revisionId: 'D123456',
    });
    
    expect(result.success).toBe(true);
    expect(result.context.steps).toHaveProperty('fetchDiff');
    expect(result.context.steps).toHaveProperty('review');
  });
});
```

### 3. 对比验证

```typescript
// 确保 V1 和 V2 输出一致
describe('V1 vs V2', () => {
  it('should produce same results', async () => {
    const v1Tool = new FetchDiffTool(phabClient, cache);
    const v2Tool = new FetchDiffToolV2(phabClient, cache);
    
    const v1Result = await v1Tool.fetch({ revisionId: 'D123456' });
    const v2Result = await v2Tool.fetch({ revisionId: 'D123456' });
    
    expect(v2Result).toEqual(v1Result);
  });
});
```

---

## 常见问题

### Q1: 必须一次性迁移所有工具吗？

**不必。** 采用渐进式迁移：
- 新工具直接用 V2
- 现有工具按优先级逐步迁移
- V1 和 V2 可以并存

### Q2: 如何在 V2 中复用 V1 工具？

使用 `LegacyToolAdapter`：

```typescript
import { LegacyToolAdapter } from './core/legacy-tool-adapter.js';

const v1Tool = new FetchDiffTool(phabClient, cache);

const adapter = new LegacyToolAdapter(
  {
    name: 'fetch-diff',
    description: '...',
    inputSchema: {...},
  },
  (input) => v1Tool.fetch(input)
);

toolRegistry.register(adapter);
```

### Q3: ReActEngine 是否必须使用？

**不必。** 你可以选择：
1. **简单工具**：继承 BaseTool，不使用 ReActEngine
2. **简单 Agent**：继承 BaseAgent，保持单次 LLM 调用
3. **复杂 Agent**：使用 ReActEngine，实现自主决策

### Q4: Pipeline DSL 是否支持所有逻辑？

**当前限制**：
- ✅ 线性执行
- ✅ 条件分支
- ✅ 模板变量
- ❌ 并行执行（计划中）
- ❌ 循环（计划中）

复杂逻辑可以编写自定义 Agent。

### Q5: Metrics 会影响性能吗？

**影响极小。** InMemoryMetricsClient 的开销：
- 记录 Counter：<1μs
- 记录 Timer：<1μs
- 内存占用：每条记录 ~100 bytes

建议定期调用 `reset()` 清理历史数据。

### Q6: 如何调试 ReActEngine？

查看完整历史记录：

```typescript
const result = await engine.run({...});

console.log(result.context.history);
// [
//   { thought: {...}, action: {...}, observation: {...} },
//   { thought: {...}, action: {...}, observation: {...} },
//   ...
// ]
```

### Q7: Pipeline 执行失败如何处理？

检查错误信息：

```typescript
const result = await executor.execute(pipeline, input);

if (!result.success) {
  console.error(result.error);
  
  // 查看哪一步失败
  for (const [name, step] of Object.entries(result.context.steps)) {
    if (step.error) {
      console.error(`Step ${name} failed:`, step.error);
    }
  }
}
```

---

## 下一步

1. **阅读架构文档**：`ARCHITECTURE_V2.md`
2. **查看示例**：`src/tools/v2/fetch-diff.ts`、`src/agents/v2/test-agent.ts`
3. **尝试迁移**：选择一个简单工具开始
4. **反馈问题**：遇到问题随时提 issue

---

**版本**: v2.0.0-alpha  
**更新日期**: 2024-11-08  
**维护者**: fe-testgen-mcp team
