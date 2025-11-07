import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { parseDiff, generateNumberedDiff } from '../utils/diff-parser.js';
import type { Diff } from '../schemas/diff.js';

export interface FetchCommitChangesInput {
  commitHash: string;
  repoPath?: string;
}

export interface FetchCommitChangesOutput {
  diff: Diff;
  commitInfo: {
    hash: string;
    author: string;
    date: string;
    message: string;
  };
}

export class FetchCommitChangesTool {
  async fetch(input: FetchCommitChangesInput): Promise<FetchCommitChangesOutput> {
    const { commitHash, repoPath = process.cwd() } = input;

    try {
      // 验证 repo 路径
      if (!existsSync(repoPath)) {
        throw new Error(`Repository path does not exist: ${repoPath}`);
      }

      // 验证是否是 git 仓库
      try {
        execSync('git rev-parse --git-dir', {
          cwd: repoPath,
          stdio: 'pipe',
        });
      } catch {
        throw new Error(`Not a git repository: ${repoPath}`);
      }

      logger.info(`Fetching commit changes for ${commitHash}...`);

      // 获取 commit 信息
      const commitInfoRaw = execSync(
        `git show --no-patch --format="%H%n%an%n%ai%n%s" ${commitHash}`,
        {
          cwd: repoPath,
          encoding: 'utf-8',
        }
      );

      const [hash, author, date, message] = commitInfoRaw.trim().split('\n');

      // 获取 diff
      const diffRaw = execSync(`git show ${commitHash}`, {
        cwd: repoPath,
        encoding: 'utf-8',
      });

      // 解析 diff
      const diff = parseDiff(diffRaw, `commit:${commitHash}`, {
        title: message,
        summary: `Commit by ${author} on ${date}`,
        author,
      });

      // 生成带行号的 diff
      diff.numberedRaw = generateNumberedDiff(diff);

      logger.info(
        `Fetched commit ${commitHash.substring(0, 7)} with ${diff.files.length} files changed`
      );

      return {
        diff,
        commitInfo: {
          hash,
          author,
          date,
          message,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to fetch commit changes: ${commitHash}`, { error: errorMessage });
      throw new Error(`Failed to fetch commit changes: ${errorMessage}`);
    }
  }

  /**
   * 获取多个 commits 的变更（用于分析一系列提交）
   */
  async fetchRange(
    commitRange: string,
    repoPath?: string
  ): Promise<FetchCommitChangesOutput[]> {
    try {
      // 获取 commit 列表
      const commitHashes = execSync(`git log --format=%H ${commitRange}`, {
        cwd: repoPath || process.cwd(),
        encoding: 'utf-8',
      })
        .trim()
        .split('\n')
        .filter(Boolean);

      logger.info(`Fetching ${commitHashes.length} commits in range ${commitRange}...`);

      // 并行获取所有 commits
      const results = await Promise.all(
        commitHashes.map(hash =>
          this.fetch({ commitHash: hash, repoPath })
        )
      );

      return results;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to fetch commit range: ${commitRange}`, { error: errorMessage });
      throw new Error(`Failed to fetch commit range: ${errorMessage}`);
    }
  }
}
