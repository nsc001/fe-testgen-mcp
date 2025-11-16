# n8n 集成指南

> 适用于希望在 n8n 工作流中自动化执行“获取 diff → 分析 → 生成测试 → 写入/运行/修复”流程的团队。

## 📦 前置条件

1. **运行中的 fe-testgen-mcp Server**  
   - 已执行 `npm run build` 并启动 `dist/index.js`  
   - 对外提供 HTTP 或 Stdio 接口（建议使用 HTTP Streaming 模式）
2. **n8n 版本**：≥ 1.50（支持 MCP Agent 节点）
3. **凭证配置**：
   - 在 n8n 中创建 **OpenAI** 凭证（供 MCP 工具内部使用）
   - 在 MCP Agent 节点中配置服务器地址（HTTP）或命令行（Stdio）
4. **目标仓库访问权限**：若从远程仓库 clone，需要具备有效的 Git 凭证（HTTPS/SSH）

---

## 🚀 集成模式对比

| 模式 | 适用场景 | 调用工具 | 优势 | 注意事项 |
|------|----------|----------|------|----------|
| **逐步编排** | 自定义程度高，需要对每个步骤精细控制 | fetch-diff-from-repo → analyze-test-matrix-worker → generate-tests-worker → write-test-file → run-tests → fix-failing-tests | - 可插入自定义逻辑  <br> - 便于调试每个阶段 | - 节点较多  <br> - 需手动处理失败回退 |
| **一键式工作流** | 希望快速落地全自动流程 | test-generation-workflow | - 单节点完成  <br> - 自动处理 Worker、回退、修复 | - 灵活度相对较低  <br> - 需要一次性准备全部参数 |

> **建议**：先在测试环境使用逐步编排模式，验证每一步的输入/输出；稳定后可切换到一键式工作流模式。

---

## 🛠️ 逐步编排示例

下面示例展示了在 n8n 中使用 MCP Agent 节点按步骤完成整个流程。

### 1. 获取 diff 与项目配置

- **节点名称**：`Fetch Diff`
- **工具**：`fetch-diff-from-repo`
- **输入示例**：

```json
{
  "repoUrl": "https://github.com/org/repo.git",
  "branch": "feature/test-generation",
  "baselineBranch": "main"
}
```

- **输出**：
  - `data.workspaceId`
  - `data.diff`
  - `data.projectConfig`
  - `data.changedFiles`

### 2. 分析测试矩阵（Worker）

- **节点名称**：`Analyze Matrix`
- **工具**：`analyze-test-matrix-worker`
- **输入示例**（使用前一步输出）：

```json
{
  "workspaceId": "{{$json["data"]["workspaceId"]}}",
  "diff": "{{$json["data"]["diff"]}}",
  "projectConfig": "{{$json["data"]["projectConfig"]}}"
}
```

- **注意**：Worker 失败时会自动回退到非 Worker 版本，日志中可看到 `Worker execution failed, falling back to direct`。

### 3. 生成测试（Worker）

- **节点名称**：`Generate Tests`
- **工具**：`generate-tests-worker`
- **输入示例**：

```json
{
  "workspaceId": "{{$json["workspaceId"]}}",
  "matrix": "{{$json["matrix"]}}",
  "scenarios": ["happy-path", "edge-case"],
  "maxTests": 6
}
```

### 4. 写入测试文件

- **节点名称**：`Write Files`
- **工具**：`write-test-file`
- **输入示例**：

```json
{
  "tests": "{{$json["tests"]}}",
  "workspaceId": "{{$json["workspaceId"]}}",
  "projectRoot": "{{$json["projectConfig"]["projectRoot"]}}",
  "overwrite": false
}
```

### 5. 运行测试

- **节点名称**：`Run Tests`
- **工具**：`run-tests`
- **输入示例**：

```json
{
  "workspaceId": "{{$json["workspaceId"]}}",
  "projectRoot": "{{$json["projectConfig"]["projectRoot"]}}",
  "timeout": 60000
}
```

- **输出**：`summary`、`stdout`、`stderr`、`exitCode`

### 6. 自动修复失败测试（可选）

- **节点名称**：`Fix Failures`
- **工具**：`fix-failing-tests`
- **触发条件**：`{{$json["testResults"]["success"]}}` 为 `false`
- **输入示例**：

```json
{
  "workspaceId": "{{$json["workspaceId"]}}",
  "testResults": "{{$json["testResults"]}}",
  "maxAttempts": 3
}
```

- **输出**：
  - `fixes`: 应用的修复列表
  - `retriedResults`: 重新运行的测试结果

---

## ⚡ 一键式工作流示例

对流程稳定、希望最小化节点数量的团队，推荐使用 `test-generation-workflow`。

- **节点名称**：`Test Workflow`
- **工具**：`test-generation-workflow`
- **输入示例**：

```json
{
  "repoUrl": "https://github.com/org/repo.git",
  "branch": "feature/test-generation",
  "baselineBranch": "main",
  "scenarios": ["happy-path", "edge-case", "error-path"],
  "autoFix": true,
  "maxFixAttempts": 2,
  "maxTests": 8
}
```

- **输出字段**：
  - `workspaceId`
  - `projectConfig`
  - `matrix`
  - `tests`
  - `filesWritten`
  - `testResults`
  - `fixes`（自动修复开启时）
  - `steps`（每个步骤的耗时与状态）

- **常见用法**：
  - 将 `filesWritten` 传给 GitLab/GitHub API 创建 MR 评论或提交
  - 将 `testResults` 发送到 Slack/Teams 通知
  - 使用 `steps` 字段做可视化监控

---

## 🔄 清理与资源管理

- `workspaceManager.cleanupExpired()` 会在启动后每 10 分钟自动运行，清理超过 1 小时的临时工作区
- 如需提前释放资源，可在工作流结束后调用 `cleanup-workspace` 工具（TODO：如需可在未来版本提供）
- 建议在 n8n 中添加一个 **最后一步**，记录 `workspaceId` 便于追踪

---

## 🧩 常见问题

### 1. Worker 超时
- 调整环境变量 `WORKER_TIMEOUT_MS` 或在工具输入中显式增加 `timeout`
- 关注 n8n 日志中的 `Task timeout` 警告

### 2. Git 克隆失败
- 确认仓库地址是否可访问
- 对私有仓库，建议在 `repoUrl` 中使用 HTTPS + token 或预先配置 SSH Key

### 3. 自动修复失败
- `fix-failing-tests` 默认最多尝试 3 次，可通过 `maxAttempts` 调整
- 可在输出中查看 `confidence`，低于阈值（默认 0.5）的修复会被忽略

### 4. 多工作区并发
- `workspaceId` 与 n8n 执行 ID 无关，可并发运行
- 若需要跨节点共享，可使用 n8n 的 `Workflow Data` 或 `Execute Workflow` 节点传递

---

## 📚 延伸阅读

- [test-generation-workflow 工具源码](../src/tools/test-generation-workflow.ts)
- [fix-failing-tests 工具源码](../src/tools/fix-failing-tests.ts)
- [generate-cursor-rule 工具源码](../src/tools/generate-cursor-rule.ts)
- [implementation-improvement-plan.md](./implementation-improvement-plan.md)
- [cursor-rule-template.md](./cursor-rule-template.md)

希望这份指南能帮助你快速在 n8n 中落地全自动的前端测试生成流程！
