# gen-test MCP 规则草稿（自动生成）

> 快捷触发：在 Cursor 输入“帮我配置下 gen-test mcp”
> 生成时间：{{GENERATED_AT}}，以下字段已自动探测；请逐项确认 TODO 备注并按需调整。

## 仓库上下文
- 项目名：{{PROJECT_NAME}}
- 仓库：{{REPO_URL}}
- 工作分支：{{BRANCH}}（基线：{{BASELINE_BRANCH}}）
- 项目类型：{{PROJECT_TYPE}}（monorepo 类型：{{MONOREPO_TYPE}}）
- 包根目录：{{PACKAGE_ROOT}} <!-- 如自动识别为空，请填写主要子项目根目录 -->
- 受影响子项目：
{{AFFECTED_SUBPROJECTS}}
- 可测子项目：
{{TESTABLE_SUBPROJECTS}}

## 测试框架
- 测试框架：{{TEST_FRAMEWORK}} <!-- 自动检测，如不符请改为 vitest/jest -->
- 测试文件模式：{{TEST_PATTERN}} <!-- 若有自定义后缀/目录，请调整 -->
- 已有测试：{{HAS_EXISTING_TESTS}} <!-- 如已有历史测试，请遵循其风格 -->

## 生成/修复参数
- 最大生成用例数：{{MAX_TESTS}} <!-- 性能敏感时可下调 -->
- 自动修复尝试次数：{{MAX_FIX_ATTEMPTS}} <!-- 失败重试次数 -->
- 修复置信度阈值：{{FIX_CONFIDENCE_THRESHOLD}} <!-- 建议 0.5-0.8 -->

## 场景与策略
- 目标：围绕变更区域覆盖正常 / 异常 / 边界 / 状态变更场景
- 代码规范：TODO 填写项目约束（类型、状态管理、国际化、UI 库等）
- Mock 策略：默认使用 vi.fn/jest.fn；请求优先 mock fetch/axios；TODO：若有全局 mock/拦截器写明
- 断言约定：默认 `expect` + Testing Library；TODO：若需 snapshot、特定 matcher、数据工厂请补充
- 异步处理：优先 async/await；组件测试需使用 act/等待渲染完成；避免裸 setTimeout

## 目录/文件排除
- 默认忽略：node_modules、dist、build、coverage
- TODO：若需跳过特定子包/目录/文件模式，请在此列出

## 手动校验提示
- 确认并补齐上方 TODO 块，写明全局初始化、环境变量、CI 限制等
- 若后续仓库信息有变化，可再次运行“帮我配置下 gen-test mcp”更新自动字段
