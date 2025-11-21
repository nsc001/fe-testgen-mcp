# fe-testgen-mcp

基于 MCP 协议的前端单元测试生成服务，支持从 Git 仓库或外部工作流获取代码差异，自动生成并修复测试用例。核心目标是提供“一条命令即可补齐测试”的能力，方便在 CI、n8n、Cursor/Claude 等客户端中直接调用。

## 概览
- 自动检测项目（Monorepo/测试框架）并解析 diff，生成测试矩阵与测试代码
- 支持 Vitest/Jest，提供 Worker 隔离以避免长测阻塞
- 通过 HTTP Streaming 或 stdio 暴露 MCP 工具，可嵌入编辑器和自动化流程
- 内置缓存、并发控制与监控上报，可按需开启

## 快速开始
```bash
npm install
npm run build
npm start                       # 自动选择 HTTP Streaming 或 stdio 模式
OPENAI_API_KEY=sk-xxx npm start -- --transport stdio
```
- 需要 Node.js 20+。
- 默认端点：HTTP `http://localhost:3000/mcp`，SSE `http://localhost:3000/sse`。

## 配置速览
将必要的密钥与常用开关写在环境变量或 `config.yaml` 中：
- `OPENAI_API_KEY`（必需）、`OPENAI_MODEL`（默认 gpt-4）
- 传输：`TRANSPORT_MODE=stdio | httpStream`，端口/地址通过 `HTTP_PORT`、`HTTP_HOST`、`HTTP_ENDPOINT` 覆盖
- Worker：`WORKER_ENABLED`（默认 true）、`WORKER_MAX_POOL`（默认 3）
- 日志与监控：`ENABLE_FILE_LOG`、`ENABLE_CONSOLE_LOG`、`TRACKING_ENABLED`

## 核心工具
常用 MCP 工具（名称即调用名）：
- `fetch-commit-changes` / `fetch-diff-from-repo`：从本地或远程仓库获取 diff
- `analyze-test-matrix` / `analyze-test-matrix-worker`：分析功能与测试矩阵
- `generate-tests` / `generate-tests-worker` / `generate-tests-from-raw-diff`：生成测试代码
- `write-test-file`：将生成的用例落盘
- `run-tests`：执行 Vitest/Jest 并解析结果
- `fix-failing-tests`：基于失败日志自动修复测试
- `test-generation-workflow`：一键完成 diff → 生成 → 执行 → 修复

## 工作流示例
1. 在 CI 或 n8n 获取 MR/PR diff（或使用 `fetch-diff-from-repo`）。
2. 调用 `generate-tests-from-raw-diff` 获取补齐的测试用例与统计信息。
3. 如需落盘并验证，串联 `write-test-file` → `run-tests` → `fix-failing-tests`。

## 常见问题
- 需要禁用 HTTP 日志干扰时，保持默认 `ENABLE_FILE_LOG=false`、`ENABLE_CONSOLE_LOG=false`，或在开发模式下按需开启。
- 若遇到 undici 相关的 `File is not defined`，请确认 Node.js 版本 ≥18 并重新构建。
