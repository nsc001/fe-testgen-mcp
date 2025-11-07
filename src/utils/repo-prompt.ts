import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.js';

/**
 * 仓库级别 prompt 配置的候选文件列表（按优先级排序）
 * 
 * 支持多种 AI 工具和约定：
 * - Cursor: .cursorrules
 * - 自定义：.ai/rules.md, .ai/prompt.md
 * - MCP: .mcp/prompt.md, .mcp/rules.md
 * - 通用：.llmrules, .codingconvention.md
 */
const REPO_PROMPT_FILES = [
  '.cursorrules',
  '.ai/rules.md',
  '.ai/prompt.md',
  '.mcp/prompt.md',
  '.mcp/rules.md',
  '.llmrules',
  '.codingconvention.md',
  'CODING_CONVENTIONS.md',
] as const;

export interface RepoPromptConfig {
  /**
   * 仓库特定的 prompt 内容
   */
  content: string;
  
  /**
   * 配置来源文件路径
   */
  source: string;
  
  /**
   * 是否找到了配置
   */
  found: boolean;
}

/**
 * 从仓库中检测并读取 prompt 配置
 * 
 * 该函数会按优先级顺序查找以下文件：
 * 1. .cursorrules (Cursor AI 编辑器的规则文件)
 * 2. .ai/rules.md 或 .ai/prompt.md (自定义 AI 规则目录)
 * 3. .mcp/prompt.md 或 .mcp/rules.md (MCP 工具专用)
 * 4. .llmrules (通用 LLM 规则)
 * 5. .codingconvention.md 或 CODING_CONVENTIONS.md (编码规范)
 * 
 * @param projectRoot 项目根目录的绝对路径
 * @returns RepoPromptConfig 对象，包含配置内容和元信息
 * 
 * @example
 * ```typescript
 * const config = loadRepoPrompt('/path/to/project');
 * if (config.found) {
 *   console.log(`Found config from: ${config.source}`);
 *   console.log(config.content);
 * }
 * ```
 */
export function loadRepoPrompt(projectRoot: string): RepoPromptConfig {
  logger.debug('Searching for repo-level prompt config', { projectRoot });
  
  for (const filename of REPO_PROMPT_FILES) {
    const filePath = join(projectRoot, filename);
    
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8').trim();
        
        if (content.length === 0) {
          logger.warn(`Repo prompt file is empty: ${filePath}`);
          continue;
        }
        
        logger.info('Loaded repo-level prompt config', {
          source: filename,
          path: filePath,
          contentLength: content.length,
        });
        
        return {
          content,
          source: filePath,
          found: true,
        };
      } catch (error) {
        logger.warn(`Failed to read repo prompt file: ${filePath}`, { error });
        continue;
      }
    }
  }
  
  logger.debug('No repo-level prompt config found', {
    projectRoot,
    searchedFiles: REPO_PROMPT_FILES,
  });
  
  return {
    content: '',
    source: '',
    found: false,
  };
}

/**
 * 合并多个 prompt 配置源
 * 
 * 优先级：手动配置 > 仓库配置 > 全局配置
 * 
 * @param globalPrompt 全局配置的 prompt（来自 config.yaml）
 * @param repoPrompt 仓库级别的 prompt（从项目根目录读取）
 * @param manualPrompt 手动指定的 prompt（最高优先级）
 * @returns 合并后的 prompt 字符串
 */
export function mergePromptConfigs(
  globalPrompt: string | undefined,
  repoPrompt: string | undefined,
  manualPrompt?: string | undefined
): string | undefined {
  // 手动配置优先级最高
  if (manualPrompt && manualPrompt.trim().length > 0) {
    logger.debug('Using manual prompt config');
    return manualPrompt;
  }
  
  // 仓库配置次之
  if (repoPrompt && repoPrompt.trim().length > 0) {
    logger.debug('Using repo-level prompt config');
    return repoPrompt;
  }
  
  // 最后使用全局配置
  if (globalPrompt && globalPrompt.trim().length > 0) {
    logger.debug('Using global prompt config');
    return globalPrompt;
  }
  
  logger.debug('No prompt config available');
  return undefined;
}
