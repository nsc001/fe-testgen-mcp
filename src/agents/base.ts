import { readFileSync } from 'node:fs';
import { OpenAIClient } from '../clients/openai.js';
import { retry } from '../utils/retry.js';
import { logger } from '../utils/logger.js';

export interface AgentResult<T> {
  items: T[];
  confidence: number; // 平均置信度
}

export interface BaseAgentConfig {
  name: string;
  promptPath: string;
  description: string;
  projectContextPrompt?: string; // 项目特定规则 prompt（可选）
}

export abstract class BaseAgent<T> {
  protected openai: OpenAIClient;
  protected config: BaseAgentConfig;
  protected prompt: string;
  protected basePrompt: string;
  private currentProjectContext?: string;

  constructor(openai: OpenAIClient, config: BaseAgentConfig) {
    this.openai = openai;
    this.config = config;
    
    // 如果 promptPath 为空，说明该 Agent 不使用外部 prompt 文件
    if (config.promptPath) {
      this.basePrompt = this.loadPrompt(config.promptPath);
      this.currentProjectContext = config.projectContextPrompt;
      this.prompt = this.buildFullPrompt(this.basePrompt, this.currentProjectContext);
    } else {
      // 不使用外部 prompt，设置为空字符串
      this.basePrompt = '';
      this.prompt = '';
      this.currentProjectContext = undefined;
    }
  }

  /**
   * 构建完整的 prompt（基础 prompt + 项目特定规则）
   */
  private buildFullPrompt(base: string, projectContext?: string): string {
    if (projectContext) {
      if (base) {
        return `${base}\n\n## 项目特定规则\n\n${projectContext}`;
      }
      return projectContext;
    }
    return base;
  }

  /**
   * 动态更新项目上下文 prompt
   * 这允许在运行时更新 agent 的配置，而无需重新创建 agent 实例
   */
  updateProjectContext(projectContextPrompt?: string): void {
    if (this.currentProjectContext === projectContextPrompt) {
      return; // 没有变化，跳过更新
    }
    
    this.currentProjectContext = projectContextPrompt;
    this.prompt = this.buildFullPrompt(this.basePrompt, projectContextPrompt);
    
    logger.debug(`Updated project context for agent ${this.config.name}`, {
      hasContext: !!projectContextPrompt,
      contextLength: projectContextPrompt?.length || 0,
    });
  }

  /**
   * 加载提示词文件
   */
  protected loadPrompt(path: string): string {
    try {
      return readFileSync(path, 'utf-8');
    } catch (error) {
      logger.error(`Failed to load prompt from ${path}`, { error });
      throw error;
    }
  }

  /**
   * 获取 Agent 描述
   */
  getDescription(): string {
    return this.config.description;
  }

  /**
   * 获取 Agent 名称
   */
  getName(): string {
    return this.config.name;
  }

  /**
   * 执行 Agent（抽象方法）
   */
  abstract execute(context: {
    diff: string;
    files: Array<{ path: string; content: string }>;
    metadata?: Record<string, unknown>;
  }): Promise<AgentResult<T>>;

  /**
   * 带重试的执行
   */
  protected async executeWithRetry<TResult>(
    fn: () => Promise<TResult>
  ): Promise<TResult> {
    return retry(fn, {
      maxRetries: 3,
      initialDelay: 1000,
      maxDelay: 10000,
    });
  }

  /**
   * 调用 LLM
   */
  protected async callLLM(
    systemPrompt: string,
    userPrompt: string,
    options?: {
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    }
  ): Promise<string> {
    return this.executeWithRetry(async () => {
      return this.openai.complete(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        options
      );
    });
  }

  /**
   * 生成文件路径列表字符串
   */
  protected buildFilePathsList(files: Array<{ path: string; content: string }>): string {
    return files.map(f => f.path).join('\n- ');
  }

  /**
   * 生成标准的代码片段使用说明（所有 CR agents 共用）
   * 
   * ✨ 新方法：使用代码片段而不是行号，更可靠！
   */
  protected getCodeSnippetInstructions(): string {
    return `**重要说明 - 如何报告问题位置（请仔细阅读）**：

1. **使用代码片段，不要使用行号**：
   ✅ 推荐：返回 "codeSnippet" 字段，包含问题代码的特征性片段
   ✅ 例如：如果看到 "+const foo = 1;" 有问题，返回 "codeSnippet": "const foo = 1"
   ✅ 例如：如果看到 "useEffect(() => {" 有问题，返回 "codeSnippet": "useEffect(() => {"
   ❌ 不推荐：返回 "line" 字段（容易出错，工具会自动根据代码片段定位行号）

2. **代码片段选择技巧**：
   - 选择有特征的代码片段（不要太短，至少 5-10 个字符）
   - 可以是完整的一行，也可以是行的一部分
   - 优先选择问题代码的核心部分（如函数名、变量名、关键语法）
   - 如果是多行问题，选择最有代表性的那一行
   
3. **示例**：
   问题代码: \`NEW_LINE_42: +const [count] = useState(0); ← REVIEWABLE (ADDED)\`
   正确返回: \`"codeSnippet": "const [count] = useState(0)"\` 或 \`"codeSnippet": "useState(0)"\`
   
   问题代码: \`NEW_LINE_15: :enable-reset="false" ← REVIEWABLE (CONTEXT)\`
   正确返回: \`"codeSnippet": ":enable-reset=\\"false\\""\` 或 \`"codeSnippet": "enable-reset"\`

4. **其他注意事项**：
   - diff 中只显示了变更的行及其上下文，未显示的行不代表不存在
   - 在判断某个导入是否使用时，请检查完整的文件内容
   - 如果你不确定某个问题是否真的存在，请降低置信度至 0.5 以下或不报告
   - 返回的 file 字段必须使用下面"变更的文件列表"中的准确路径
   - 不要报告已删除的行（标记为 "DELETED" 或 "NOT REVIEWABLE" 的行）`;
  }

  /**
   * 生成标准的行号说明（向后兼容，建议使用 getCodeSnippetInstructions）
   * @deprecated 建议使用 getCodeSnippetInstructions() 代替
   */
  protected getLineNumberInstructions(): string {
    return `**重要说明 - 行号格式（请仔细阅读）**：
1. 下面的 diff 使用特殊格式标记行号，并明确哪些行可评论：
   - NEW_LINE_10: +import React from 'react'; ← REVIEWABLE (ADDED)  ← 这是新文件的第10行（新增的行，可评论）
   - NEW_LINE_15:  const a = 1; ← REVIEWABLE (CONTEXT)  ← 这是新文件的第15行（未改变的上下文行，也可评论）
   - DELETED (was line 8): -const old = 1; ← NOT REVIEWABLE  ← 这一行已被删除，不在新文件中

2. **关键规则 - 必须严格遵守**：
   ✅ 返回的 line 字段必须使用 NEW_LINE_xxx 中的数字，并且只针对带有 "← REVIEWABLE" 标记的行（ADDED 或 CONTEXT 均可）
   ✅ 例如看到 "NEW_LINE_42: +const foo = 1; ← REVIEWABLE (ADDED)" 应该返回 "line": 42
   ❌ 绝对不要报告 DELETED / NOT REVIEWABLE 的行（这些行已不存在于新文件中）
   ❌ 如果看到 "DELETED (was line 8)"，不要使用数字 8

3. 其他注意事项：
   - diff 中只显示了变更的行及其上下文，未显示的行不代表不存在
   - 在判断某个导入是否使用时，请务必检查完整的文件内容，不要仅根据 diff 片段判断
   - 如果你不确定某个问题是否真的存在（如上下文不足），请降低置信度至 0.5 以下或不报告
   - 返回的 file 字段必须使用下面"变更的文件列表"中的准确路径，不要修改扩展名（如不要把 .less 改成 .css）`;
  }

  /**
   * 修正文件路径（处理 AI 可能返回的错误扩展名）
   * @param reportedPath AI 返回的文件路径
   * @param files 实际的文件列表
   * @returns 修正后的路径，如果找不到则返回 null
   */
  protected correctFilePath(
    reportedPath: string,
    files: Array<{ path: string; content: string }>
  ): string | null {
    // 如果路径完全匹配，直接返回
    if (files.some(f => f.path === reportedPath)) {
      return reportedPath;
    }

    // 创建路径映射（不带扩展名 -> 实际路径）
    const filePathMap = new Map<string, string>();
    for (const file of files) {
      const pathWithoutExt = file.path.replace(/\.(tsx?|jsx?|vue|svelte|css|scss|less|json|ya?ml|mdx)$/, '');
      filePathMap.set(pathWithoutExt, file.path);
    }

    // 尝试修正：去掉扩展名后匹配
    const pathWithoutExt = reportedPath.replace(/\.(tsx?|jsx?|vue|svelte|css|scss|less|json|ya?ml|mdx)$/, '');
    const correctedPath = filePathMap.get(pathWithoutExt);
    
    if (correctedPath) {
      logger.warn(`Correcting file path from "${reportedPath}" to "${correctedPath}"`);
      return correctedPath;
    }

    logger.warn(`File path "${reportedPath}" not found in diff`);
    return null;
  }
}

