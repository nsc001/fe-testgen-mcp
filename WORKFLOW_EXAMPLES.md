# 工作流示例

本文档展示使用 MCP 工具的完整工作流示例。

## 工作流 1: Phabricator Diff 审查和测试生成

### 场景
收到一个 Phabricator Diff（如 D123456），需要进行代码审查并生成测试用例。

### 步骤

#### 1. 查看 Diff 内容
```json
{
  "tool": "fetch-diff",
  "arguments": {
    "revisionId": "D123456"
  }
}
```

**输出**: Diff 详细信息（带 NEW_LINE_xxx 行号标记）

#### 2. 执行代码审查
```json
{
  "tool": "review-frontend-diff",
  "arguments": {
    "revisionId": "D123456",
    "mode": "incremental",
    "publish": true
  }
}
```

**输出**: 识别的问题列表，自动发布到 Phabricator

#### 3. 分析测试矩阵（获取当前目录）
```bash
pwd
# 假设输出: /home/user/my-project
```

```json
{
  "tool": "analyze-test-matrix",
  "arguments": {
    "revisionId": "D123456",
    "projectRoot": "/home/user/my-project"
  }
}
```

**输出**: 功能清单、测试矩阵、projectRoot（保存此值）

#### 4. 生成测试用例
```json
{
  "tool": "generate-tests",
  "arguments": {
    "revisionId": "D123456",
    "projectRoot": "/home/user/my-project",
    "mode": "incremental"
  }
}
```

**输出**: 测试用例代码列表

#### 5. 写入测试文件
```json
{
  "tool": "write-test-file",
  "arguments": {
    "files": [
      {
        "filePath": "/home/user/my-project/src/components/Button.test.tsx",
        "content": "// test code here...",
        "overwrite": false
      }
    ]
  }
}
```

**输出**: 写入成功/失败的结果

---

## 工作流 2: Commit-based 测试生成和执行

### 场景
代码已合并到主分支，需要根据 commit 生成测试并执行。

### 步骤

#### 1. 查看 Commit 变更
```json
{
  "tool": "fetch-commit-changes",
  "arguments": {
    "commitHash": "abc1234",
    "repoPath": "/home/user/my-project"
  }
}
```

**输出**: commit 信息和 diff 详情（带 NEW_LINE_xxx 行号）

#### 2. 分析测试矩阵
```json
{
  "tool": "analyze-commit-test-matrix",
  "arguments": {
    "commitHash": "abc1234",
    "repoPath": "/home/user/my-project",
    "projectRoot": "/home/user/my-project"
  }
}
```

**输出**: 功能清单和测试矩阵

#### 3. 生成测试用例
```json
{
  "tool": "generate-tests",
  "arguments": {
    "revisionId": "commit:abc1234",
    "projectRoot": "/home/user/my-project",
    "mode": "full"
  }
}
```

**输出**: 生成的测试代码

#### 4. 写入测试文件
```json
{
  "tool": "write-test-file",
  "arguments": {
    "files": [
      {
        "filePath": "/home/user/my-project/src/utils/helper.test.ts",
        "content": "// test code...",
        "overwrite": false
      }
    ]
  }
}
```

#### 5. 执行测试
```json
{
  "tool": "run-tests",
  "arguments": {
    "projectRoot": "/home/user/my-project",
    "command": "npm",
    "args": ["test", "--", "--runInBand"],
    "timeoutMs": 600000
  }
}
```

**输出**: 
```json
{
  "success": true,
  "exitCode": 0,
  "stdout": "Test Suites: 5 passed, 5 total...",
  "stderr": "",
  "durationMs": 12345
}
```

---

## 工作流 3: 仅执行测试（不生成）

### 场景
测试文件已存在，只需要执行测试验证代码质量。

### 步骤

#### 1. 执行测试
```json
{
  "tool": "run-tests",
  "arguments": {
    "projectRoot": "/home/user/my-project"
  }
}
```

默认会执行 `npm test -- --runInBand`。

#### 2. 自定义测试命令
```json
{
  "tool": "run-tests",
  "arguments": {
    "projectRoot": "/home/user/my-project",
    "command": "pnpm",
    "args": ["test", "src/components"]
  }
}
```

仅测试 `src/components` 目录。

---

## 工作流 4: 完整的自动化流程（CI/CD 集成）

### 场景
在 CI/CD 管道中自动执行：代码审查 → 生成测试 → 执行测试 → 发布结果。

### 伪代码流程

```javascript
// 1. 获取 commit hash（来自 CI 环境变量）
const commitHash = process.env.CI_COMMIT_SHA;

// 2. 分析测试矩阵
const matrixResult = await callTool('analyze-commit-test-matrix', {
  commitHash,
  projectRoot: process.cwd(),
});

// 3. 生成测试用例
const testsResult = await callTool('generate-tests', {
  revisionId: `commit:${commitHash}`,
  projectRoot: process.cwd(),
  mode: 'full',
});

// 4. 写入测试文件
const writeResult = await callTool('write-test-file', {
  files: testsResult.tests.map(t => ({
    filePath: t.file,
    content: t.code,
    overwrite: true, // CI 中可以覆盖
  })),
});

// 5. 执行所有测试
const testResult = await callTool('run-tests', {
  projectRoot: process.cwd(),
  timeoutMs: 10 * 60 * 1000, // 10 分钟
});

// 6. 根据结果决定是否通过 CI
if (!testResult.success) {
  console.error('Tests failed!');
  process.exit(1);
}

console.log('All tests passed!');
```

---

## 工作流 5: 增量更新流程

### 场景
Diff 更新了，只生成新增的测试用例（不重复生成）。

### 步骤

#### 1. 分析测试矩阵（使用 forceRefresh）
```json
{
  "tool": "analyze-test-matrix",
  "arguments": {
    "revisionId": "D123456",
    "projectRoot": "/home/user/my-project",
    "forceRefresh": true
  }
}
```

强制刷新缓存，确保获取最新的 diff。

#### 2. 生成测试用例（增量模式）
```json
{
  "tool": "generate-tests",
  "arguments": {
    "revisionId": "D123456",
    "projectRoot": "/home/user/my-project",
    "mode": "incremental"
  }
}
```

**增量模式**: 只生成新的测试，跳过已存在的测试。

---

## 常见问题

### Q: projectRoot 参数为什么重要？
A: 因为 Phabricator diff 中的文件路径是相对路径，需要 projectRoot 来解析为绝对路径。同时用于检测测试框架（Vitest/Jest）。

### Q: 如何确定 projectRoot？
A: 使用 `pwd` 命令或 `process.cwd()` 获取当前工作目录。如果是 monorepo，可能需要手动指定子包的根目录。

### Q: write-test-file 的 overwrite 参数何时使用？
A: 
- `false`（默认）: 开发环境，避免误删已有的测试
- `true`: CI/CD 环境，需要覆盖旧的自动生成的测试

### Q: run-tests 超时了怎么办？
A: 增加 `timeoutMs` 参数，或者分批执行测试（使用 `args` 参数指定测试范围）。

### Q: 如何处理测试执行失败？
A: 检查 `testResult.stderr` 和 `testResult.stdout`，分析失败原因。可能需要：
1. 修复代码问题
2. 调整生成的测试代码
3. 更新测试环境配置

---

## 最佳实践

1. **总是提供 projectRoot**: 虽然是可选参数，但强烈建议提供，避免自动检测失败。

2. **使用增量模式**: 在迭代开发时使用 `mode: 'incremental'` 避免重复生成。

3. **先审查后测试**: 先执行 `review-frontend-diff`，修复明显问题后再生成测试。

4. **测试前先 forceRefresh**: 确保测试矩阵基于最新的 diff 内容。

5. **批量写入测试文件**: 使用 `write-test-file` 的 `files` 数组，一次性写入多个文件。

6. **合理设置超时**: 根据项目大小调整 `run-tests` 的 `timeoutMs`。

7. **保存 projectRoot**: `analyze-test-matrix` 返回的 `projectRoot` 字段应该保存并传递给后续工具。
