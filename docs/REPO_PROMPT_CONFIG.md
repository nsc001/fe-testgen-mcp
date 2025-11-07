# 仓库级别 Prompt 配置指南

## 概述

`fe-testgen-mcp` 支持为每个仓库配置独特的 prompt 规则，这些规则会自动注入到代码审查和测试生成的 AI 提示词中。这使得 AI 能够遵循项目特定的编码规范、架构模式和最佳实践。

## 支持的配置文件

系统会按以下优先级顺序查找仓库配置文件：

1. **`.cursorrules`** - Cursor AI 编辑器的规则文件
2. **`.ai/rules.md`** 或 **`.ai/prompt.md`** - 自定义 AI 规则目录
3. **`.mcp/prompt.md`** 或 **`.mcp/rules.md`** - MCP 工具专用配置
4. **`.llmrules`** - 通用 LLM 规则文件
5. **`.codingconvention.md`** 或 **`CODING_CONVENTIONS.md`** - 编码规范文档

找到第一个存在且非空的文件后，将使用该文件内容作为项目特定的 prompt。

## 配置优先级

Prompt 配置有三个优先级层次：

1. **手动指定**（最高优先级）- 通过工具输入参数 `projectRoot` 指定
2. **仓库级别** - 从项目根目录的配置文件自动读取
3. **全局配置**（最低优先级）- 来自 `config.yaml` 的 `projectContextPrompt`

## 使用方式

### 方式 1: 使用 Cursor 规则文件（推荐）

如果你的项目已经在使用 Cursor AI 编辑器，只需在项目根目录创建 `.cursorrules` 文件：

```bash
# 在项目根目录
touch .cursorrules
```

编辑 `.cursorrules`，添加项目特定的规则：

```markdown
# 项目编码规范

## React 组件规范
- 所有组件必须使用函数式组件 + Hooks
- 禁止使用 class 组件
- 组件必须有 TypeScript 类型定义

## 状态管理
- 使用 Zustand 进行全局状态管理
- 禁止直接使用 Redux
- 本地状态优先使用 useState

## 样式规范
- 使用 Tailwind CSS
- 禁止使用内联样式
- 组件样式文件使用 .module.css 后缀

## API 调用
- 所有 API 请求必须通过 src/api/client.ts
- 使用 React Query 进行数据获取和缓存
- 错误处理必须使用统一的 ErrorBoundary

## 测试要求
- 所有公共 API 必须有单元测试
- UI 组件必须有快照测试
- 使用 Vitest + React Testing Library
```

### 方式 2: 使用 .ai 目录

创建专门的 AI 配置目录：

```bash
mkdir -p .ai
echo "# AI 规则配置" > .ai/rules.md
```

### 方式 3: 使用 MCP 专用配置

```bash
mkdir -p .mcp
echo "# MCP Prompt 配置" > .mcp/prompt.md
```

## 配置示例

### 示例 1: 微前端架构规则

```markdown
# 微前端架构规范

## 模块划分
- 项目使用 qiankun 微前端架构
- 主应用位于 `/apps/main`
- 子应用位于 `/apps/micro-*` 目录

## 通信规范
- 子应用之间禁止直接通信
- 必须通过主应用的 EventBus 进行通信
- 共享状态必须通过 `@/shared/state` 模块

## 路由规则
- 子应用路由必须以 `/micro-{appName}/` 开头
- 禁止使用 hash 路由

## 代码审查重点
- 检查是否有子应用直接依赖
- 检查全局变量污染
- 检查样式隔离是否正确
```

### 示例 2: Monorepo 规则

```markdown
# Monorepo 开发规范

## 包管理
- 使用 pnpm workspace
- 所有共享包必须放在 `/packages` 目录
- 应用代码放在 `/apps` 目录

## 依赖管理
- 共享依赖在根 package.json 中管理
- 包特定依赖在各自的 package.json
- 禁止重复安装相同版本的依赖

## 导入规范
- 跨包导入必须使用 workspace 协议
- 示例: `"@myorg/shared": "workspace:*"`

## 构建顺序
- UI 组件库 → 工具库 → 业务应用
- 修改共享包后必须先构建才能在应用中使用
```

### 示例 3: 安全性规则

```markdown
# 安全性规范

## 数据处理
- 所有用户输入必须经过验证和清理
- 使用 DOMPurify 处理 HTML 内容
- 禁止使用 dangerouslySetInnerHTML（除非有充分理由）

## 认证授权
- 敏感操作必须验证用户权限
- Token 存储使用 httpOnly cookie
- 禁止在 localStorage 存储敏感信息

## API 安全
- 所有请求必须包含 CSRF token
- 使用 HTTPS 传输敏感数据
- 实现请求频率限制

## 第三方库
- 新增依赖前必须检查安全漏洞
- 定期运行 `npm audit`
- 优先使用经过审计的库
```

## 工作原理

### 代码审查流程

1. 调用 `review-frontend-diff` 工具
2. 系统从 diff 文件路径自动检测项目根目录
3. 在项目根目录查找配置文件（按优先级）
4. 如果找到配置，将其附加到所有 CR agent 的 prompt 中
5. AI 在审查代码时会参考这些规则

示例日志：

```
[INFO] Project root detected for code review: /path/to/project
[INFO] Using repo-level prompt config for code review
  source: /path/to/project/.cursorrules
  length: 1234
[INFO] Re-initialized agents with repo-level prompt config
```

### 测试生成流程

测试生成目前主要使用预定义的 prompt 模板，仓库级配置主要影响代码审查阶段。

未来版本将支持测试生成阶段的仓库级配置。

## 配置验证

### 检查配置是否生效

1. **查看日志**：检查 MCP 服务器日志中是否有 "Using repo-level prompt config" 消息

2. **测试效果**：提交一个明显违反规则的代码变更，看 AI 是否能识别

3. **手动验证**：调用工具时指定 `forceRefresh: true` 确保使用最新配置

### 常见问题排查

#### 配置文件未被读取

**原因**：
- 文件不在项目根目录
- 文件名拼写错误
- 文件为空

**解决方案**：
```bash
# 检查文件是否存在且非空
ls -la .cursorrules
cat .cursorrules
```

#### 项目根目录检测错误

**原因**：
- MCP 服务器在错误的目录启动
- 项目缺少 `package.json`

**解决方案**：
```bash
# 方式 1: 手动指定项目根目录（推荐）
{
  "revisionId": "D123",
  "projectRoot": "/absolute/path/to/project"
}

# 方式 2: 设置环境变量
export PROJECT_ROOT=/absolute/path/to/project
```

#### 配置未生效

**原因**：
- 缓存的 agents 仍在使用旧配置

**解决方案**：
- 使用 `forceRefresh: true` 参数
- 或重启 MCP 服务器

## 最佳实践

### 1. 配置文件组织

```
project-root/
├── .cursorrules          # Cursor 用户的规则
├── .ai/
│   ├── rules.md         # 通用 AI 规则
│   ├── review.md        # 代码审查专用规则
│   └── testing.md       # 测试生成专用规则
├── .mcp/
│   └── prompt.md        # MCP 工具专用配置
└── CODING_CONVENTIONS.md # 人类可读的编码规范文档
```

### 2. 规则编写建议

- **具体明确**：使用具体的例子而不是抽象描述
- **分类组织**：按主题（组件、样式、API 等）分组
- **优先级标记**：标注哪些是严格要求，哪些是建议
- **提供反例**：说明什么是不应该做的

### 3. 版本控制

将配置文件提交到版本控制系统：

```bash
git add .cursorrules
git commit -m "chore: add project-specific AI rules"
```

### 4. 团队协作

- 在团队中讨论并达成共识
- 定期回顾和更新规则
- 记录规则变更的原因

### 5. 配置测试

在 CI/CD 中验证配置文件：

```yaml
# .github/workflows/validate-ai-config.yml
name: Validate AI Config
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Check .cursorrules exists
        run: test -f .cursorrules
      - name: Validate config format
        run: |
          if [ ! -s .cursorrules ]; then
            echo "Error: .cursorrules is empty"
            exit 1
          fi
```

## 与全局配置的区别

### 全局配置（config.yaml）

```yaml
projectContextPrompt: src/prompts/global-rules.md
```

- 适用于所有项目
- 通用的最佳实践
- MCP 服务器级别的配置

### 仓库级配置（.cursorrules 等）

- 特定于单个项目
- 项目架构和技术栈相关
- 自动检测和加载

## 高级用法

### 组合多个配置源

虽然系统只会使用第一个找到的配置文件，但你可以在该文件中引用其他文档：

```markdown
# .cursorrules

基础规则请参考：CODING_CONVENTIONS.md

## 额外的 AI 审查规则

[这里添加特定于 AI 的指示...]
```

### 条件性规则

在配置中使用明确的条件：

```markdown
# React 组件规则

## 对于新组件
- 必须使用 TypeScript
- 必须有 Props 类型定义

## 对于旧组件（维护模式）
- 可以保持 JavaScript
- 重构时才升级到 TypeScript
```

### 动态规则（未来功能）

未来版本计划支持：

- 基于文件路径的规则变化
- 基于 git 分支的规则切换
- 环境相关的规则（dev/staging/prod）

## 示例项目

查看完整示例：

```bash
# 克隆示例项目
git clone https://github.com/your-org/mcp-config-examples

# 查看不同场景的配置
cd mcp-config-examples
ls -la configs/
```

## 相关文档

- [项目根目录检测](./PROJECT_ROOT_DETECTION.md)
- [配置文件格式](./CONFIG_SCHEMA.md)
- [代码审查指南](./CODE_REVIEW_GUIDE.md)

## 反馈和贡献

如果你有更好的配置方案或发现问题，请提交 Issue 或 PR。
