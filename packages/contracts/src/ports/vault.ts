/**
 * Vault 端口（设计文档 §6 / §9）。
 * 刻意拆成读写两个接口：只有 commit 用例可以依赖 VaultWriter。
 */
import type { CommitSha, ContentHash, RawPath } from '@sb/domain';

export interface RawFileRef {
  readonly path: RawPath;
  readonly sizeBytes: number;
  readonly contentHash: ContentHash;
}

export interface VaultReader {
  listRaw(): Promise<readonly RawFileRef[]>;
  readRaw(path: RawPath): Promise<string>;
  /** wiki 下全部节点文件（vault 相对路径），供检索索引与 doctor 使用。 */
  listNodes(): Promise<readonly string[]>;
  readNode(file: string): Promise<string>;
  head(): Promise<CommitSha | null>;
  /** 工作区是否干净；脏工作区必须拒绝提交。 */
  isClean(): Promise<boolean>;
}

export interface VaultWriter {
  /** 仅 application/commands/commit-draft 允许调用。 */
  writeNode(file: string, content: string): Promise<void>;
  commitFiles(files: readonly string[], message: string): Promise<CommitSha>;
  resetHard(sha: CommitSha): Promise<void>;
}

export interface VaultPort extends VaultReader, VaultWriter {}
