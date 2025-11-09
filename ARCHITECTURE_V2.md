# MCP 架构 V2 - 重构总结

本文档记录了 fe-testgen-mcp 从 V1 到 V2 的架构演进和重构成果。

## 重构概览

### 实施阶段

- **Phase 1**: ✅ 基础设施层（Metrics、BaseTool、ToolRegistry）
- **Phase 2**: ✅ Context & Memory 系统
- **Phase 3**: ✅ ReAct Engine 核心
- **Phase 4**: ✅ Pipeline 系统（DSL + Executor）
- **Phase 5**: 🔄 工具层重构（示例：FetchDiffToolV2）
- **Phase 6**: 🔄 TestAgent V2 重构

### 核心改进

1. **统一工具层抽象** → BaseTool
2. **Agent 真正 ReAct 化** → ReActEngine
3. **Pipeline 配置化** → YAML DSL
4. **Context & Memory** → 长期记忆支持
5. **Metrics 体系** → 可观测性基础

---

## 1. 基础设施层

### 1.1 Metrics 系统

**文件**: `src/utils/metrics.ts`

**设计目标**：
- 提供统一的 metrics 接口，支持未来集成 Prometheus/Datadog
- 零依赖的内存实现
- 支持 Counter、Timer、Histogram、Gauge

**核心接口**：
```typescript
interface MetricsClient {
  recordCounter(name: string, value?: number, labels?: MetricLabels): void;
  recordTimer(name: string, durationMs: number, labels?: MetricLabels): void;
  recordHistogram(name: string, value: number, labels?: MetricLabels): void;
  recordGauge(name: string, value: number, labels?: MetricLabels): void;
}
```

**使用方式**：
```typescript
import { getMetrics } from './utils/metrics.js';

getMetrics().recordCounter('tool.execution.started', 1, { tool: 'fetch-diff' });
getMetrics().recordTimer('tool.execution.duration', 1500, { tool: 'fetch-diff', status: 'success' });
```

**未来扩展**：
- 集成 Prometheus exporter
- 支持 push gateway
- 添加聚合统计导出

---

### 1.2 BaseTool 抽象

**文件**: `src/core/base-tool.ts`

**设计目标**：
- 统一工具执行模板（日志、metrics、错误处理）
- 定义工具元数据（name、description、inputSchema）
- 支持生命周期钩子（beforeExecute、afterExecute、onError）

**核心架构**：
```typescript
abstract class BaseTool<TInput, TOutput> {
  abstract getMetadata(): ToolMetadata;
  protected abstract executeImpl(input: TInput): Promise<TOutput>;
  
  // 模板方法
  async execute(input: TInput): Promise<ToolResult<TOutput>>;
  
  // 生命周期钩子
  protected async beforeExecute(input, context): Promise<void>;
  protected async afterExecute(result, context): Promise<void>;
  protected async onError(error, context): Promise<void>;
}
```

**优势**：
- ✅ 统一错误处理和日志
- ✅ 自动记录 metrics（执行次数、耗时、成功/失败率）
- ✅ 减少工具层重复代码
- ✅ 便于单元测试和 mock

**示例**：参见 `src/tools/v2/fetch-diff.ts`

---

### 1.3 ToolRegistry

**文件**: `src/core/tool-registry.ts`

**设计目标**：
- 集中管理所有工具的注册与检索
- 支持按名称查找工具
- 导出工具元数据（用于 MCP ListTools）

**使用方式**：
```typescript
const registry = new ToolRegistry();
registry.register(new FetchDiffToolV2(phabClient, cache));

const tool = registry.get('fetch-diff');
const allTools = registry.list();
const metadata = registry.listMetadata(); // 用于 ListToolsRequest
```

**优势**：
- ✅ 简化 index.ts 中的工具管理
- ✅ 支持动态加载工具
- ✅ 便于未来扩展（插件系统、热加载）

---

## 2. Context & Memory 系统

**文件**: `src/core/context.ts`

### 2.1 核心概念

- **AgentContext**: Agent 运行时的上下文（输入、历史、状态）
- **Observation**: Agent 观察到的信息（工具输出、事件等）
- **Thought**: Agent 的思考内容
- **Action**: Agent 的行动决策
- **Memory**: 跨会话的长期记忆

### 2.2 AgentContext 结构

```typescript
interface AgentContext {
  sessionId: string;
  agentName: string;
  task: string;
  history: Array<{ thought?, action?, observation? }>;
  currentStep: number;
  maxSteps: number;
  isComplete: boolean;
  data: Record<string, unknown>; // 共享数据
  startTime: number;
  lastUpdateTime: number;
}
```

### 2.3 ContextStore

管理 Agent 上下文的生命周期：

```typescript
const store = new ContextStore();

// 创建上下文
const ctx = store.create('session-123', 'test-agent', 'Generate tests');

// 添加历史记录
store.addHistory('session-123', {
  thought: { content: 'I should fetch the diff first' },
  action: { type: 'call_tool', toolName: 'fetch-diff' },
  observation: { type: 'tool_result', content: { ... } }
});

// 更新上下文
store.update('session-123', ctx => {
  ctx.data.testsGenerated = 10;
});
```

### 2.4 Memory（长期记忆）

支持跨会话的记忆存储：

```typescript
const memory = new Memory();

// 存储记忆（支持 TTL 和标签）
memory.set('last-review-D123456', { issues: [...] }, { ttl: 3600, tags: ['review'] });

// 检索记忆
const lastReview = memory.get('last-review-D123456');

// 按标签查找
const allReviews = memory.findByTag('review');
```

**用途**：
- 记录历史 CR 结果，避免重复评论
- 缓存测试矩阵分析结果
- 保存用户偏好和项目配置

---

## 3. ReAct Engine

**文件**: `src/core/react-engine.ts`

### 3.1 ReAct 循环

```
while (!isComplete && currentStep < maxSteps):
  1. Thought: Agent 思考下一步行动（调用 LLM）
  2. Action: 从 Thought 中提取行动指令（call_tool / respond / terminate）
  3. Observation: 执行行动并记录结果
  4. 记录到 history
```

### 3.2 核心方法

- `think()`: 调用 LLM 生成 Thought
- `decide()`: 从 Thought 解析 Action
- `act()`: 执行 Action（调用工具或终止）

### 3.3 使用示例

```typescript
const engine = new ReActEngine(llm, toolRegistry, contextStore, config);

const result = await engine.run({
  agentName: 'code-reviewer',
  task: 'Review changes in D123456',
  systemPrompt: 'You are a code review agent...',
  goal: 'Find potential bugs and suggest improvements',
});

console.log(result.finalAnswer);
console.log(result.context.history); // 查看完整的 Thought-Action-Observation 历史
```

### 3.4 未来改进

- [ ] 使用 Function Calling 或 Structured Output 提升 Action 解析准确性
- [ ] 支持并行 Action（批量调用工具）
- [ ] 增强 Thought 的推理能力（Chain-of-Thought）
- [ ] 支持多 Agent 协作

---

## 4. Pipeline 系统

**文件**: 
- `src/core/pipeline.ts` - 执行引擎
- `config/pipelines.yaml` - DSL 定义

### 4.1 DSL 示例

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
          mode: "{{context.reviewMode || 'full'}}"
      
      - name: publish
        type: tool
        ref: publish-comments
        input:
          revisionId: "{{context.revisionId}}"
          comments: "{{steps.review.data.issues}}"
        condition: "context.publish"
```

### 4.2 PipelineExecutor

```typescript
const executor = new PipelineExecutor(toolRegistry);

const result = await executor.execute(pipelineDefinition, {
  revisionId: 'D123456',
  reviewMode: 'incremental',
  publish: true,
});

console.log(result.context.steps); // 每个步骤的输出
```

### 4.3 支持的特性

- ✅ 模板变量：`{{context.xxx}}`, `{{steps.stepName.data.xxx}}`
- ✅ 条件执行：`condition: "context.publish"`
- ✅ 错误处理：`onError: 'stop' | 'continue' | 'retry'`
- 🔄 并行执行（计划中）
- 🔄 循环与分支（计划中）

### 4.4 优势

- ✅ 声明式配置，易于理解和维护
- ✅ 无需修改代码即可调整工作流
- ✅ 支持版本控制和 A/B 测试
- ✅ 降低新流程的开发成本

---

## 5. 工具层重构

### 5.1 迁移示例：FetchDiffToolV2

**变更对比**：

| 项目 | V1 | V2 (BaseTool) |
|------|----|----|
| 错误处理 | 手动 try/catch | 自动（模板方法） |
| 日志 | 手动 logger.info | 自动（生命周期） |
| Metrics | 无 | 自动记录 |
| 元数据 | 分散在 index.ts | 集中在 getMetadata() |
| 验证 | 分散在代码中 | beforeExecute() 钩子 |

**代码对比**：

V1:
```typescript
async fetch(options: FetchDiffOptions): Promise<Diff> {
  try {
    logger.info('Fetching diff...');
    // ... 业务逻辑
    logger.info('Fetched diff');
    return diff;
  } catch (error) {
    logger.error('Failed', { error });
    throw error;
  }
}
```

V2:
```typescript
protected async executeImpl(input: FetchDiffInput): Promise<FetchDiffOutput> {
  // 只关注业务逻辑，其他由 BaseTool 处理
  const diff = await this.phabClient.getRawDiff(input.revisionId);
  return { diff, source: 'phabricator' };
}
```

### 5.2 迁移指南

所有工具逐步迁移到 `src/tools/v2/` 目录：

1. 继承 `BaseTool<TInput, TOutput>`
2. 实现 `getMetadata()` 和 `executeImpl()`
3. （可选）实现生命周期钩子
4. 更新 ToolRegistry 注册

---

## 6. TestAgent V2

**文件**: `src/agents/v2/test-agent.ts`

### 6.1 架构改进

- ✅ 支持多种代码变更来源（CodeChangeSource 抽象）
- ✅ 使用 ReAct 模式（思考 → 行动 → 观察）
- ✅ 自主决策流程（分析 → 生成 → 写入 → 执行）
- ✅ 增量模式和去重

### 6.2 CodeChangeSource 抽象

**文件**: `src/core/code-change-source.ts`

```typescript
interface CodeChangeSource {
  fetchChanges(): Promise<Diff>;
  getMetadata(): CodeChangeMetadata;
  getIdentifier(): string;
}

// 实现类
- PhabricatorDiffSource
- GitCommitSource
- RawDiffSource (GitLab/GitHub)
```

### 6.3 使用示例

```typescript
// 从 Phabricator 生成测试
const source = new PhabricatorDiffSource('D123456', fetchDiffFn);

const agent = new TestAgentV2(llm, embedding, stateManager, contextStore);
const result = await agent.generate(source, {
  maxSteps: 10,
  mode: 'incremental',
  autoWrite: true,
  autoRun: true,
});

console.log(result.tests); // 生成的测试用例
console.log(result.filesWritten); // 写入的文件
console.log(result.testResults); // 测试执行结果
```

---

## 7. 向后兼容性

### 7.1 策略

- ✅ 保留所有 V1 工具和 Agent（`src/tools/*.ts`, `src/agents/*.ts`）
- ✅ V2 版本放在 `src/tools/v2/`, `src/agents/v2/`
- ✅ 通过配置文件或环境变量切换版本
- ✅ 渐进式迁移，避免大爆炸式重构

### 7.2 迁移路径

**阶段 1**: 基础设施就绪（✅ 已完成）
- Metrics、BaseTool、Context、ReActEngine、Pipeline

**阶段 2**: 工具层迁移（🔄 进行中）
- 优先迁移高频工具（fetch-diff, review-diff, generate-tests）
- 保留 V1 工具作为 fallback

**阶段 3**: Agent 层重构（🔄 进行中）
- TestAgent V2、ReviewAgent V2
- 基于 ReActEngine 重写

**阶段 4**: Pipeline 集成（📅 计划中）
- 将现有工作流迁移到 YAML DSL
- 在 MCP Server 中集成 PipelineExecutor

**阶段 5**: 废弃 V1（📅 未来）
- 充分验证 V2 稳定性后，逐步废弃 V1

---

## 8. 可观测性增强

### 8.1 Metrics 维度

| Metric | 类型 | 维度 | 说明 |
|--------|------|------|------|
| `tool.execution.started` | Counter | tool | 工具调用次数 |
| `tool.execution.completed` | Counter | tool, status | 工具完成次数 |
| `tool.execution.duration` | Timer | tool, status | 工具执行耗时 |
| `react.session.started` | Counter | agent | ReAct 会话启动 |
| `react.session.completed` | Counter | agent, status | ReAct 会话完成 |
| `react.session.steps` | Histogram | agent | ReAct 执行步数 |
| `pipeline.execution.started` | Counter | pipeline | Pipeline 启动 |
| `pipeline.execution.duration` | Timer | pipeline, status | Pipeline 耗时 |

### 8.2 日志增强

所有核心组件统一使用结构化日志：

```typescript
logger.info('[Tool:fetch-diff] Starting execution', { input });
logger.info('[ReActEngine] Step 3: Thought', { thought: '...' });
logger.info('[Pipeline] Executing step: review', { step: 'review' });
```

### 8.3 未来集成

- [ ] Prometheus exporter（`/metrics` 端点）
- [ ] OpenTelemetry tracing
- [ ] Grafana 仪表盘模板
- [ ] Sentry 错误追踪集成

---

## 9. 性能优化

### 9.1 已实现

- ✅ BaseTool 自动记录 metrics（零成本抽象）
- ✅ ContextStore 内存管理（避免泄漏）
- ✅ Memory 支持 TTL 和自动清理

### 9.2 计划中

- [ ] 工具层并行执行（Pipeline parallel steps）
- [ ] LLM 调用批处理（减少 roundtrip）
- [ ] 缓存策略优化（分层缓存、预热）
- [ ] 惰性加载工具（首次调用时初始化）

---

## 10. 测试策略

### 10.1 单元测试

每个核心组件提供单元测试：

```bash
src/core/base-tool.test.ts
src/core/tool-registry.test.ts
src/core/context.test.ts
src/core/react-engine.test.ts
src/core/pipeline.test.ts
```

### 10.2 集成测试

验证完整工作流：

```bash
tests/integration/review-workflow.test.ts
tests/integration/test-generation-workflow.test.ts
tests/integration/pipeline-execution.test.ts
```

### 10.3 E2E 测试

使用真实 Phabricator/Git 仓库验证：

```bash
tests/e2e/phabricator-review.test.ts
tests/e2e/git-test-generation.test.ts
```

---

## 11. 文档更新

需要更新的文档：

- [ ] README.md - 添加 V2 架构说明
- [ ] ARCHITECTURE_V2.md - 本文档（持续更新）
- [ ] API.md - 新增 BaseTool、ReActEngine、Pipeline API
- [ ] MIGRATION_GUIDE.md - V1 → V2 迁移指南
- [ ] CONTRIBUTING.md - 新增工具开发指南

---

## 12. 下一步计划

### 短期（1-2 周）

- [ ] 完成核心工具迁移到 V2（fetch-diff, review-diff, generate-tests）
- [ ] 集成 ReActEngine 到 ReviewDiffTool
- [ ] 编写 Pipeline 集成测试
- [ ] 添加 Metrics 导出端点

### 中期（1-2 月）

- [ ] 完成 TestAgent V2 功能开发
- [ ] 将现有工作流迁移到 Pipeline DSL
- [ ] 实现 HTTP Server + SSE transport
- [ ] Prometheus + Grafana 集成

### 长期（3-6 月）

- [ ] 多 Agent 协作机制
- [ ] 插件系统（动态加载工具和 Agent）
- [ ] 云端部署方案（K8s + Helm）
- [ ] Web UI 仪表盘

---

## 13. 贡献指南

### 13.1 添加新工具

1. 继承 `BaseTool<TInput, TOutput>`
2. 实现必需方法（`getMetadata()`, `executeImpl()`）
3. 添加单元测试
4. 在 ToolRegistry 注册
5. 更新 Pipeline DSL（如需要）

### 13.2 添加新 Agent

1. 继承现有 Agent 基类或使用 ReActEngine
2. 定义 system prompt 和工具列表
3. 实现 execute() 方法
4. 添加单元测试和集成测试
5. 更新文档

### 13.3 添加新 Pipeline

1. 在 `config/pipelines.yaml` 定义新流程
2. 确保引用的工具已注册
3. 添加集成测试
4. 更新文档

---

## 14. 参考资料

- [ReAct 论文](https://arxiv.org/abs/2210.03629)
- [MCP 协议规范](https://github.com/anthropics/model-context-protocol)
- [Prometheus 指标规范](https://prometheus.io/docs/practices/naming/)
- [OpenTelemetry 规范](https://opentelemetry.io/docs/)

---

**版本**: v2.0.0-alpha
**更新日期**: 2024-11-08
**维护者**: fe-testgen-mcp team
