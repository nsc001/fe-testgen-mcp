# MCP 功能概览

本文件汇总本 MCP 的核心功能与工具，便于快速理解和对接（包含 n8n / MCP 客户端调用要点）。详尽进度、拆解和历史报告请参考仓库历史记录；日常使用只需阅读此文档。

## 核心能力
- 多仓库工作区：支持本地路径或远程 Git 仓库，自动克隆、生成 `workspaceId`，并提供 diff/变更文件获取与过期清理。
- 项目自动识别：检测 Monorepo 类型（pnpm/yarn/npm/lerna/nx/rush）、测试框架（Vitest/Jest）、已有测试与自定义规则。
- Worker 执行：分析/生成/测试均可在 worker 线程中运行，支持超时、回退到主线程、崩溃自恢复。
- 测试生成与修复：自动分析改动、生成测试矩阵和用例，运行并尝试自动修复失败的测试。
- 流程编排：提供从获取 diff → 分析 → 生成测试 → 运行 → 自动修复的一键式工作流，适合 n8n 集成。
- Cursor 规则生成：基于模板生成 `.cursor/rule/fe-mcp.md`，便于前端代码协作。

## 主要工具（MCP 可调用）
- `fetch-diff-from-repo`: 克隆仓库并返回 diff + `workspaceId`。
- `detect-project-config`: 根据 `workspaceId` 检测项目/Monorepo/测试框架信息。
- `analyze-test-matrix` / `analyze-test-matrix-worker`: 基于 diff 生成测试矩阵。worker 版优先用 worker，失败回退。
- `generate-tests` / `generate-tests-worker`: 生成测试用例。worker 版支持回退。
- `run-tests`: 运行 Vitest/Jest，非 watch/coverage 模式优先用 worker，失败回退。
- `fix-failing-tests`: 调用 TestFixAgent 修复失败测试，可多轮尝试（最多 3 次，置信度阈值 ≥ 0.5）。
- `test-generation-workflow`: 一键式完整流程：获取 diff → 分析 → 生成 → 运行 → 自动修复（含耗时记录与错误处理）。
- `generate-cursor-rule`: 读取项目配置，基于模板生成或更新 `.cursor/rule/fe-mcp.md`。

## 典型流程
1) `fetch-diff-from-repo` 获取 `workspaceId` + diff  
2) `detect-project-config` 识别项目/测试框架  
3) `analyze-test-matrix-worker` 生成测试矩阵（如 worker 不可用则回退）  
4) `generate-tests-worker` 生成测试用例  
5) `run-tests` 运行测试（优先 worker）  
6) 若失败，`fix-failing-tests` 尝试自动修复并重跑  
7) 可使用 `test-generation-workflow` 直接串联上述步骤

## 关键配置
- `WORKER_ENABLED` (默认 true): 控制是否启用 worker。
- `WORKER_MAX_POOL` (默认 3): 最大并发 worker 数。
- 其它环境变量与工具参数见 `README.md` / `.env.example`。

## 当前验证状态
- 功能实现：M1–M5 全部完成（工作区、检测、worker、修复、n8n、一键工作流、规则生成）。
- 手工回归待补充：真实仓库场景下的 worker 超时 / 回退 / 崩溃恢复测试。

