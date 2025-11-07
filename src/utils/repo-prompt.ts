import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from './logger.js';

/**
 * 仓库级别 prompt 配置的候选文件列表（按优先级排序）
 * 
 * 支持多种 AI 工具和约定：
 * - FE MCP 专用：fe-mcp.md, fe-mcp.mdc（最高优先级，推荐使用）
 * - Cursor: .cursorrules
 * - 自定义：.ai/rules.md, .ai/prompt.md
 * - MCP: .mcp/prompt.md, .mcp/rules.md
 * - 通用：.llmrules, .codingconvention.md
 */
const REPO_PROMPT_FILES = [
  'fe-mcp',
  'fe-mcp.md',
  'fe-mcp.mdc',
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
 * 在指定目录中查找 prompt 配置文件
 * 
 * @param searchDir 要搜索的目录
 * @returns 找到的配置，如果没找到返回 null
 */
function findPromptInDirectory(searchDir: string): RepoPromptConfig | null {
  for (const filename of REPO_PROMPT_FILES) {
    const filePath = join(searchDir, filename);
    
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
  
  return null;
}

/**
 * 基于示例文件路径收集待检查的目录（支持 monorepo 子项目）
 * 
 * @param projectRoot 项目根目录
 * @param sampleFilePaths 示例文件路径列表（相对于项目根目录）
 * @returns 按优先级排序的候选目录列表
 */
function collectCandidateDirectories(
  projectRoot: string,
  sampleFilePaths: string[]
): string[] {
  const candidateDirs: string[] = [];
  const seenDirs = new Set<string>();

  const addDir = (dir: string) => {
    const normalized = dir;
    if (!normalized.startsWith(projectRoot)) {
      return;
    }
    if (seenDirs.has(normalized)) {
      return;
    }
    seenDirs.add(normalized);
    candidateDirs.push(normalized);
  };

  for (const sampleFilePath of sampleFilePaths) {
    if (!sampleFilePath) {
      continue;
    }

    const absolutePath = join(projectRoot, sampleFilePath);
    let currentDir = dirname(absolutePath);
    const packageDirs: string[] = [];
    const otherDirs: string[] = [];

    while (currentDir.startsWith(projectRoot) && currentDir !== projectRoot) {
      const packageJsonPath = join(currentDir, 'package.json');
      if (existsSync(packageJsonPath)) {
        packageDirs.push(currentDir);
      } else {
        otherDirs.push(currentDir);
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    for (const dir of packageDirs) {
      addDir(dir);
    }
    for (const dir of otherDirs) {
      addDir(dir);
    }
  }

  // 项目根目录作为最后的兜底
  addDir(projectRoot);

  return candidateDirs;
}

/**
 * 从仓库中检测并读取 prompt 配置
 * 
 * 该函数会按优先级顺序查找以下文件：
 * 1. fe-mcp / fe-mcp.md / fe-mcp.mdc (FE MCP 专用配置，最高优先级)
 * 2. .cursorrules (Cursor AI 编辑器的规则文件)
 * 3. .ai/rules.md 或 .ai/prompt.md (自定义 AI 规则目录)
 * 4. .mcp/prompt.md 或 .mcp/rules.md (MCP 工具专用)
 * 5. .llmrules (通用 LLM 规则)
 * 6. .codingconvention.md 或 CODING_CONVENTIONS.md (编码规范)
 * 
 * 对于 monorepo 项目，支持子项目级别的配置：
 * - 如果提供了 sampleFilePath，会先在子项目根目录查找
 * - 如果子项目没有配置，再在 monorepo 根目录查找
 * 
 * @param projectRoot 项目根目录的绝对路径
 * @param sampleFilePath 示例文件路径（相对于项目根目录，可选）
 * @returns RepoPromptConfig 对象，包含配置内容和元信息
 * 
 * @example
 * ```typescript
 * // 普通项目
 * const config = loadRepoPrompt('/path/to/project');
 * 
 * // Monorepo 子项目
 * const config = loadRepoPrompt('/path/to/monorepo', 'packages/foo/src/index.ts');
 * ```
 */
export function loadRepoPrompt(
  projectRoot: string,
  sampleFilePaths?: string | string[]
): RepoPromptConfig {
  const samplePathsArray = Array.isArray(sampleFilePaths)
    ? sampleFilePaths
    : sampleFilePaths
      ? [sampleFilePaths]
      : [];

  logger.debug('Searching for repo-level prompt config', {
    projectRoot,
    sampleFilePaths: samplePathsArray,
  });
  
  // 收集候选目录（如果提供了示例文件，会优先包含子项目根目录）
  const candidateDirs = samplePathsArray.length > 0
    ? collectCandidateDirectories(projectRoot, samplePathsArray)
    : [projectRoot];
  
  // 依次在候选目录中查找配置
  for (const dir of candidateDirs) {
    const config = findPromptInDirectory(dir);
    
    if (config) {
      const isSubPackage = dir !== projectRoot;
      logger.info(`Using ${isSubPackage ? 'package-level' : 'repo-level'} prompt config`, {
        directory: dir,
        source: config.source,
      });
      return config;
    }
  }
  
  logger.debug('No repo-level prompt config found', {
    projectRoot,
    searchedDirs: candidateDirs,
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
