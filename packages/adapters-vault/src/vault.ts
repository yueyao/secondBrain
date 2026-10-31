/**
 * Vault 适配器：文件系统 + git（设计文档 §6 / §9）。
 *
 * 约束：
 * - 所有路径都必须落在 vault 根目录内（禁止 `..` 与绝对路径逃逸）
 * - 只有 wiki/ 下的文件可写；raw/ 只读
 * - 写入用 临时文件 + rename，避免半写文件
 * - 每次提交独立 commit，失败可 resetHard 回滚
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RawFileRef, VaultPort } from '@sb/contracts';
import type { CommitSha, ContentHash, RawPath } from '@sb/domain';

export type VaultErrorCode =
  | 'PATH_ESCAPE'
  | 'NOT_WIKI_PATH'
  | 'FILE_NOT_FOUND'
  | 'NO_CHANGES'
  | 'GIT_FAILED'
  | 'NOT_REPO';

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

export interface FsVaultOptions {
  readonly root: string;
  readonly gitAuthor?: { readonly name: string; readonly email: string };
}

const RAW_DIR = 'raw';
const WIKI_DIR = 'wiki';

export class FsVault implements VaultPort {
  private constructor(private readonly root: string) {}

  static open(options: FsVaultOptions): FsVault {
    const root = path.resolve(options.root);
    fs.mkdirSync(path.join(root, RAW_DIR), { recursive: true });
    fs.mkdirSync(path.join(root, WIKI_DIR), { recursive: true });
    const vault = new FsVault(root);
    vault.ensureRepo(options.gitAuthor ?? { name: 'secondBrain', email: 'dev@secondbrain.local' });
    return vault;
  }

  get rootDir(): string {
    return this.root;
  }

  // ---------- git ----------
  private git(args: readonly string[]): string {
    try {
      return execFileSync('git', ['-C', this.root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr;
      throw new VaultError('GIT_FAILED', `git ${args.join(' ')} 失败：${String(stderr ?? error)}`, error);
    }
  }

  private ensureRepo(author: { name: string; email: string }): void {
    if (!fs.existsSync(path.join(this.root, '.git'))) {
      this.git(['init', '-b', 'main']);
    }
    this.git(['config', 'user.name', author.name]);
    this.git(['config', 'user.email', author.email]);
    this.git(['config', 'core.quotePath', 'false']);
  }

  async head(): Promise<CommitSha | null> {
    try {
      const sha = this.git(['rev-parse', 'HEAD']).trim();
      return sha.length > 0 ? (sha as CommitSha) : null;
    } catch {
      return null;
    }
  }

  async lastCommitMessage(): Promise<string | null> {
    try {
      const subject = this.git(['log', '-1', '--pretty=%s']).trim();
      return subject.length > 0 ? subject : null;
    } catch {
      return null;
    }
  }

  async isClean(): Promise<boolean> {
    return this.git(['status', '--porcelain']).trim().length === 0;
  }

  async commitFiles(files: readonly string[], message: string): Promise<CommitSha> {
    const safeFiles = files.map((file) => this.relative(file));
    for (const file of safeFiles) this.assertInside(file);

    this.git(['add', '--', ...safeFiles]);
    const staged = this.git(['diff', '--cached', '--name-only']).trim();
    if (staged.length === 0) {
      throw new VaultError('NO_CHANGES', '没有任何文件变更，提交被跳过');
    }
    this.git(['commit', '-m', message]);
    const sha = this.git(['rev-parse', 'HEAD']).trim();
    return sha as CommitSha;
  }

  async resetHard(sha: CommitSha): Promise<void> {
    this.git(['reset', '--hard', sha]);
  }

  // ---------- 读 ----------
  async listRaw(): Promise<readonly RawFileRef[]> {
    const files = this.walk(path.join(this.root, RAW_DIR));
    return files.map((absolute) => {
      const relative = this.relative(absolute);
      const buffer = fs.readFileSync(absolute);
      return {
        path: relative as RawPath,
        sizeBytes: buffer.byteLength,
        contentHash: `sha256:${createHash('sha256').update(buffer).digest('hex')}` as ContentHash,
      };
    });
  }

  async listNodes(): Promise<readonly string[]> {
    return this.walk(path.join(this.root, WIKI_DIR)).map((absolute) => this.relative(absolute));
  }

  async readRaw(rawPath: RawPath): Promise<string> {
    return this.readFile(String(rawPath), 'raw/');
  }

  async readNode(file: string): Promise<string> {
    return this.readFile(file, 'wiki/');
  }

  // ---------- 写 ----------
  async writeNode(file: string, content: string): Promise<void> {
    const relative = this.relative(file);
    this.assertInside(relative);
    if (!relative.startsWith(`${WIKI_DIR}/`)) {
      throw new VaultError('NOT_WIKI_PATH', `只允许写 wiki/ 下的文件：${file}`);
    }
    const absolute = path.join(this.root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const tmp = `${absolute}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, absolute);
  }

  // ---------- 内部 ----------
  private readFile(file: string, requiredPrefix: string): string {
    const relative = this.relative(file);
    this.assertInside(relative);
    if (!relative.startsWith(requiredPrefix)) {
      throw new VaultError('PATH_ESCAPE', `路径必须在 ${requiredPrefix} 下：${file}`);
    }
    const absolute = path.join(this.root, relative);
    if (!fs.existsSync(absolute)) {
      throw new VaultError('FILE_NOT_FOUND', `文件不存在：${file}`);
    }
    return fs.readFileSync(absolute, 'utf8');
  }

  /** 统一成 vault 相对路径；绝对路径按相对 root 处理前先校验是否在 root 内。 */
  private relative(file: string): string {
    if (path.isAbsolute(file)) {
      const resolved = path.resolve(file);
      if (!this.isInside(resolved)) {
        throw new VaultError('PATH_ESCAPE', `路径逃出 vault：${file}`);
      }
      return path.relative(this.root, resolved);
    }
    const resolved = path.resolve(this.root, file);
    if (!this.isInside(resolved)) {
      throw new VaultError('PATH_ESCAPE', `路径逃出 vault：${file}`);
    }
    return path.relative(this.root, resolved);
  }

  private assertInside(relative: string): void {
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new VaultError('PATH_ESCAPE', `非法相对路径：${relative}`);
    }
  }

  private isInside(absolute: string): boolean {
    return absolute === this.root || absolute.startsWith(this.root + path.sep);
  }

  private walk(dir: string, acc: string[] = []): string[] {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        this.walk(full, acc);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        acc.push(full);
      }
    }
    return acc.sort();
  }
}
