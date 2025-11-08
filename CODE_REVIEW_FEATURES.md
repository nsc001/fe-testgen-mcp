# 代码审查功能详解

## 评论合并与去重机制

### 1. 同一行多个评论合并

当多个审查 Agent 对同一文件的同一行代码提出问题时，系统会自动合并这些评论：

#### 实现位置

**文件**: `src/tools/review-diff.ts` (419-462 行)

```typescript
// 按文件+行号分组评论
const mergedComments = new Map<string, {
  file: string;
  line: number;
  messages: string[];
  issueIds: string[];
}>();

for (const issue of publishableIssues) {
  const normalizedFile = normalizeFilePath(issue.file);
  const key = `${normalizedFile}:${issue.line}`;
  
  if (!mergedComments.has(key)) {
    mergedComments.set(key, {
      file: normalizedFile,
      line: issue.line,
      messages: [],
      issueIds: [],
    });
  }
  const merged = mergedComments.get(key)!;
  merged.messages.push(issue.message);
  merged.issueIds.push(issue.issueId);
}
```

#### 合并策略

1. **单条评论**：直接使用原评论内容
2. **多条评论**：调用 `mergeComments()` 方法，使用 LLM 智能合并

**LLM 合并逻辑**（145-169 行）：

```typescript
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
```

**Prompt 文件**: `src/prompts/comment-merger.md`
- 系统提示词，用于指导 LLM 合并策略
- 回退机制：LLM 失败时使用简单序号拼接

#### 示例

**输入（同一行的 3 条评论）**：

1. `[MEDIUM] 避免在渲染期间创建函数\n建议: 使用 useCallback 包裹\n(confidence=0.85)`
2. `[HIGH] 缺少必要的依赖项\n建议: 在 useCallback 的依赖数组中添加 count\n(confidence=0.92)`
3. `[LOW] 变量命名不清晰\n建议: 将 x 重命名为 handleClick\n(confidence=0.78)`

**输出（LLM 合并后）**：

```
[HIGH] 函数定义和依赖项管理存在问题
建议: 
1. 使用 useCallback 包裹函数，避免在每次渲染时创建新函数
2. 在依赖数组中添加 count，确保状态更新正确
3. 将 x 重命名为 handleClick，提高代码可读性
(confidence=0.85)
```

---

### 2. 重复 CR 问题去重

系统提供**两层去重机制**，避免在增量模式下发布重复评论：

#### 2.1 基于 Issue ID 的精确去重

**实现位置**: `src/orchestrator/workflow.ts` (93-98 行)

```typescript
// 增量模式：对比现有问题
let finalIssues = issues;
if (context.mode === 'incremental' && context.existingIssues) {
  const existingIds = new Set(context.existingIssues.map(i => i.id));
  finalIssues = issues.filter(issue => !existingIds.has(issue.id));
  logger.info(`Incremental mode: ${finalIssues.length} new issues (${issues.length} total)`);
}
```

**Issue ID 生成**（由 BaseAgent 计算）：
- 使用稳定的指纹算法（文件路径 + 行号 + 问题描述）
- 相同问题在多次 CR 中生成相同的 ID，自动过滤

#### 2.2 基于 Embedding 相似度的模糊去重

**实现位置**: `src/orchestrator/pipeline.ts` (172-215 行)

```typescript
private async deduplicateBySimilarity(issues: Issue[]): Promise<Issue[]> {
  if (!this.embeddingClient || issues.length <= 1) {
    return issues;
  }

  const messages = issues.map(issue => `${issue.message} ${issue.suggestion}`).filter(m => m.trim());
  if (messages.length === 0) {
    return issues;
  }

  try {
    const embeddings = await this.embeddingClient.encode(messages);
    const keepIndices: number[] = [];

    for (let i = 0; i < issues.length; i++) {
      let isDuplicate = false;

      for (const j of keepIndices) {
        const similarity = this.embeddingClient.cosineSimilarity(embeddings[i], embeddings[j]);
        if (similarity > this.config.filter.similarityThreshold) {
          // 相似，保留置信度更高的
          if (issues[i].confidence > issues[j].confidence) {
            const index = keepIndices.indexOf(j);
            keepIndices.splice(index, 1);
            keepIndices.push(i);
          }
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        keepIndices.push(i);
      }
    }

    return keepIndices.map(i => issues[i]);
  } catch (error) {
    logger.warn('Failed to deduplicate by similarity', { error });
    return issues;
  }
}
```

**去重策略**：
1. 为每个问题的 message + suggestion 计算 embedding 向量
2. 比较 cosine 相似度，如果超过阈值（`config.filter.similarityThreshold`）
3. 保留置信度更高的那个问题，丢弃另一个

**配置项**（`config.yaml`）：

```yaml
filter:
  similarityThreshold: 0.85  # 相似度阈值（0-1）
```

#### 2.3 状态持久化

**实现位置**: `src/state/manager.ts`

```typescript
export interface RevisionState {
  revisionId: string;
  diffId: string;
  diffFingerprint: string; // 基于 diff 内容的 hash
  lastReviewAt?: string;
  issues: Array<{
    id: string;
    file: string;
    line?: number;
    codeSnippet?: string;
    severity: string;
    category: string;
    message: string;
    confidence: number;
    createdAt: string;
    publishedAt?: string;
  }>;
  // ...
}
```

- **diffFingerprint**: 基于 diff 内容的 hash，用于判断 diff 是否变化
- **issues**: 历史 CR 问题列表，增量模式下作为去重依据

**工作流程**：

1. 第一次 CR：
   - 分析 diff，生成 issues，保存到 state
   - 发布评论

2. 第二次 CR（diff 未变）：
   - 读取 state，获取 existingIssues
   - 新生成的 issues 与 existingIssues 比对
   - 过滤掉已存在的 issue（基于 ID）
   - 仅发布新增的 issues

3. 第二次 CR（diff 已变）：
   - diffFingerprint 不同，认为是新的 diff
   - 不加载 existingIssues，执行全量 CR

---

### 3. 置信度过滤

**实现位置**: `src/orchestrator/pipeline.ts` (150-156 行)

```typescript
private filterByConfidence(issues: Issue[]): Issue[] {
  const { confidenceMinGlobal, scenarioConfidenceMin } = this.config.filter;

  return issues.filter(issue => {
    const minConfidence = scenarioConfidenceMin[issue.severity] || confidenceMinGlobal;
    return issue.confidence >= minConfidence;
  });
}
```

**配置项**（`config.yaml`）：

```yaml
filter:
  confidenceMinGlobal: 0.7  # 全局最低置信度
  scenarioConfidenceMin:
    critical: 0.6  # 严重问题的阈值可以更低
    high: 0.7
    medium: 0.8
    low: 0.9       # 低优先级问题需要更高置信度
```

**应用位置**：
- `review-diff.ts` (280 行): 发布时默认 `confidence >= 0.8`
- `publish-comments.ts`: 支持自定义最低置信度

---

## 行号验证与修正

### 1. NEW_LINE_xxx 标记机制

**实现位置**: `src/utils/diff-parser.ts`

#### 1.1 生成带标记的 diff

```typescript
export function generateNumberedDiff(diff: Diff): string {
  let numberedDiff = '';
  
  for (const file of diff.files) {
    numberedDiff += `diff --git a/${file.path} b/${file.path}\n`;
    numberedDiff += `index ${file.oldMode}..${file.newMode}\n`;
    numberedDiff += `--- a/${file.path}\n`;
    numberedDiff += `+++ b/${file.path}\n`;
    
    for (const hunk of file.hunks) {
      numberedDiff += `@@ ${hunk.header} @@\n`;
      
      for (const line of hunk.lines) {
        if (line.type === 'added') {
          numberedDiff += `NEW_LINE_${line.newLineNumber}: ${line.content} ← REVIEWABLE (ADDED)\n`;
        } else if (line.type === 'context') {
          numberedDiff += `NEW_LINE_${line.newLineNumber}: ${line.content} ← REVIEWABLE (CONTEXT)\n`;
        } else if (line.type === 'deleted') {
          numberedDiff += `DELETED (was line ${line.oldLineNumber}): ${line.content} ← NOT REVIEWABLE\n`;
        }
      }
    }
  }
  
  return numberedDiff;
}
```

**标记类型**：
- `NEW_LINE_xxx: ... ← REVIEWABLE (ADDED)` - 新增行，可评论
- `NEW_LINE_xxx: ... ← REVIEWABLE (CONTEXT)` - 上下文行，可评论
- `DELETED (was line xxx): ... ← NOT REVIEWABLE` - 已删除行，不可评论

#### 1.2 行号验证

**函数**: `validateAndCorrectLineNumber()`

```typescript
export function validateAndCorrectLineNumber(
  file: FileChange,
  lineNumber: number,
  searchRadius = 3
): {
  valid: boolean;
  line?: number;
  reason?: string;
  suggestion?: number;
} {
  const reviewableLines = getReviewableLines(file);
  
  // 1. 直接检查行号是否可评论
  if (reviewableLines.has(lineNumber)) {
    return { valid: true, line: lineNumber };
  }
  
  // 2. 在附近搜索可评论行（容错修正）
  for (let offset = 1; offset <= searchRadius; offset++) {
    if (reviewableLines.has(lineNumber + offset)) {
      return {
        valid: false,
        reason: `Line ${lineNumber} not reviewable, but line ${lineNumber + offset} is`,
        suggestion: lineNumber + offset,
      };
    }
    if (reviewableLines.has(lineNumber - offset)) {
      return {
        valid: false,
        reason: `Line ${lineNumber} not reviewable, but line ${lineNumber - offset} is`,
        suggestion: lineNumber - offset,
      };
    }
  }
  
  return {
    valid: false,
    reason: `Line ${lineNumber} is not reviewable (not added or context)`,
  };
}
```

**应用场景**：
- AI 可能返回错误行号（偏移 1-2 行）
- 自动修正到最近的可评论行
- 避免在已删除行上发布评论

#### 1.3 代码片段匹配（最优先）

**函数**: `findLineNumberByCodeSnippet()`

```typescript
export function findLineNumberByCodeSnippet(
  file: FileChange,
  codeSnippet: string
): number | null {
  const reviewableLineDetails = getReviewableLineDetails(file);
  
  const normalizedSnippet = normalizeCodeForMatching(codeSnippet);
  
  for (const { newLineNumber, content } of reviewableLineDetails) {
    const normalizedContent = normalizeCodeForMatching(content);
    
    if (normalizedContent.includes(normalizedSnippet)) {
      return newLineNumber;
    }
  }
  
  return null;
}
```

**优先级**：
1. 优先使用代码片段匹配（精确）
2. 回退到行号验证（有修正）
3. 最后使用 `findNewLineNumber()` 确认

#### 1.4 在 review-diff.ts 中的应用

```typescript
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
    } else {
      return null;
    }
  } else {
    resolvedLine = validation.line ?? issue.line;
    resolvedSource = 'line';
  }
}

// 3. 最终验证
const newLine = findNewLineNumber(file, resolvedLine);
if (newLine === null) {
  logger.error('Line validation failed');
  return null;
}
```

---

## n8n 工作流集成

### 1. CR 工作流

```
[GitLab Trigger: MR Created/Updated]
  ↓
[GitLab Node: Get MR Diff]
  ↓ (输出: rawDiff, MR metadata)
[MCP Node: review-raw-diff]
  ↓ (输出: issues[])
[Code Node: 筛选高置信度问题]
  ↓
[Code Node: 格式化为 GitLab 评论]
  ↓
[GitLab Node: Post MR Comment]
```

**关键点**：
- ✅ `review-raw-diff` 已包含完整去重逻辑
- ✅ 同一行的多条评论已自动合并
- ✅ 输出的 issues 有稳定 ID，便于 n8n 过滤和排序
- ✅ 支持增量模式，避免在 MR 更新时重复评论

### 2. 评论格式化示例（n8n Code 节点）

```javascript
const issues = $input.item.json.issues;

// 过滤高置信度问题
const highConfidenceIssues = issues.filter(issue => issue.confidence >= 0.8);

// 按文件分组
const byFile = {};
for (const issue of highConfidenceIssues) {
  if (!byFile[issue.file]) {
    byFile[issue.file] = [];
  }
  byFile[issue.file].push(issue);
}

// 生成 GitLab 评论格式
const comments = [];
for (const [file, fileIssues] of Object.entries(byFile)) {
  for (const issue of fileIssues) {
    comments.push({
      position: {
        base_sha: $json.base_sha,
        start_sha: $json.start_sha,
        head_sha: $json.head_sha,
        position_type: 'text',
        new_path: file,
        new_line: issue.line,
      },
      body: `**[${issue.severity.toUpperCase()}]** ${issue.message}\n\n${issue.suggestion ? `💡 **建议**: ${issue.suggestion}\n\n` : ''}_(置信度: ${(issue.confidence * 100).toFixed(0)}%)_`,
    });
  }
}

return { json: { comments } };
```

---

## 配置说明

### 1. 全局配置（`config.yaml`）

```yaml
orchestrator:
  parallelAgents: true      # 启用并行执行
  maxConcurrency: 3         # 最多同时运行 3 个 Agent

filter:
  confidenceMinGlobal: 0.7  # 全局最低置信度
  similarityThreshold: 0.85 # Embedding 相似度阈值
  scenarioConfidenceMin:
    critical: 0.6
    high: 0.7
    medium: 0.8
    low: 0.9

embedding:
  enabled: true             # 启用 Embedding 去重
  model: text-embedding-3-small
```

### 2. 仓库级 Prompt 配置

**优先级顺序**（从高到低）：
1. `fe-mcp.md` / `fe-mcp` / `fe-mcp.mdc` （**推荐**）
2. `.cursorrules`
3. `.ai/rules.md` 或 `.ai/prompt.md`
4. `.mcp/prompt.md` 或 `.mcp/rules.md`
5. `.llmrules`
6. `.codingconvention.md` 或 `CODING_CONVENTIONS.md`

**Monorepo 支持**：
- 优先使用子项目配置（如 `packages/foo/fe-mcp.md`）
- 回退到根目录配置

---

## 总结

✅ **同一行多评论合并**：使用 LLM 智能合并，保留所有关键信息  
✅ **重复 CR 去重**：Issue ID + Embedding 双重去重，增量模式下高效过滤  
✅ **行号验证**：NEW_LINE_xxx 标记 + 代码片段匹配 + 容错修正  
✅ **置信度过滤**：灵活配置不同严重度的阈值  
✅ **n8n 集成**：直接输出结构化数据，便于外部节点格式化和发布  

所有机制已集成到 `review-raw-diff` 和 `review-frontend-diff` 工具中，开箱即用。
