/**
 * CodeChangeSource - 代码变更来源抽象
 *
 * 目标：统一处理来自不同来源的代码变更（Phabricator、Git、GitLab、GitHub 等）
 */

import type { Diff } from '../schemas/diff.js';

export interface CodeChangeMetadata {
  source: 'phabricator' | 'git' | 'gitlab' | 'github' | 'raw';
  identifier: string; // D123456, commit-hash, MR-123 等
  title?: string;
  author?: string;
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * CodeChangeSource 接口
 */
export interface CodeChangeSource {
  /**
   * 获取变更内容
   */
  fetchChanges(): Promise<Diff>;

  /**
   * 获取元数据
   */
  getMetadata(): CodeChangeMetadata;

  /**
   * 获取唯一标识符（用于缓存和状态管理）
   */
  getIdentifier(): string;
}

/**
 * Phabricator Diff Source
 */
export class PhabricatorDiffSource implements CodeChangeSource {
  constructor(
    private revisionId: string,
    private fetchFn: (revisionId: string) => Promise<Diff>
  ) {}

  async fetchChanges(): Promise<Diff> {
    return this.fetchFn(this.revisionId);
  }

  getMetadata(): CodeChangeMetadata {
    return {
      source: 'phabricator',
      identifier: this.revisionId,
    };
  }

  getIdentifier(): string {
    return this.revisionId;
  }
}

/**
 * Git Commit Source
 */
export class GitCommitSource implements CodeChangeSource {
  constructor(
    private commitHash: string,
    private repoPath: string,
    private fetchFn: (commitHash: string, repoPath: string) => Promise<Diff>
  ) {}

  async fetchChanges(): Promise<Diff> {
    return this.fetchFn(this.commitHash, this.repoPath);
  }

  getMetadata(): CodeChangeMetadata {
    return {
      source: 'git',
      identifier: this.commitHash,
      repoPath: this.repoPath,
    };
  }

  getIdentifier(): string {
    return `commit:${this.commitHash}`;
  }
}

/**
 * Raw Diff Source（外部传入）
 */
export class RawDiffSource implements CodeChangeSource {
  constructor(
    private identifier: string,
    private diff: Diff,
    private metadata?: Partial<CodeChangeMetadata>
  ) {}

  async fetchChanges(): Promise<Diff> {
    return this.diff;
  }

  getMetadata(): CodeChangeMetadata {
    return {
      source: 'raw',
      identifier: this.identifier,
      ...this.metadata,
    };
  }

  getIdentifier(): string {
    return this.identifier;
  }
}
