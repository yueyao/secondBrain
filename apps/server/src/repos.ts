/**
 * GitHub 仓库运维（运维中心）：列出项目依赖的几个 git 仓库、展示同步状态、提供拉取与远端切换入口。
 *
 * 设计目标（ADR 0007 修订 / docs/MAINTAINERS.md）：
 * - 项目完整恢复只依赖「服务器 + GitHub」，不依赖任何个人电脑；
 * - 运维页能看到每个仓库的地址、分支、HEAD、是否落后，并能一键 fast-forward / 修改远端（换 owner / 迁移）。
 *
 * 这里只做 git 命令的薄封装；不写 vault、不改业务状态，所有动作由运维页人工触发。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 日常状态查询超时（`git fetch` 走网络，单独放宽到 10s）。 */
const GIT_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 10_000;
/** 拉取可能下载大量内容（vault/raw），给足时间。 */
const PULL_TIMEOUT_MS = 120_000;

export interface RepoDescriptor {
  readonly key: string;
  readonly label: string;
  readonly path: string;
  readonly remoteOverride?: string;
}

export interface RepoHeadInfo {
  readonly sha: string;
  readonly date: string;
  readonly author: string;
  readonly subject: string;
}

export interface RepoStatus {
  readonly key: string;
  readonly label: string;
  readonly path: string;
  readonly exists: boolean;
  readonly remote: string | null;
  readonly branch: string | null;
  readonly head: RepoHeadInfo | null;
  /** 工作区未提交改动条数（含未跟踪文件）。 */
  readonly dirtyCount: number;
  /** 本地领先 / 落后 remote 的提交数；null 表示未知（未 fetch 或无 upstream）。 */
  readonly ahead: number | null;
  readonly behind: number | null;
  /** 本次 `git fetch` 失败原因（如网络/权限）；不 fetch 时为 null。 */
  readonly fetchError: string | null;
  /** 仓库不可用原因（目录不存在 / 不是 git 仓库）。 */
  readonly error: string | null;
}

export type RepoOverrides = Readonly<Record<string, { readonly path?: string; readonly remote?: string }>>;

/** 代码仓库根目录：优先 CODE_REPO_ROOT，否则由本文件位置推导（apps/server/src → 仓库根）。 */
export function codeRepoRoot(): string {
  const fromEnv = process.env.CODE_REPO_ROOT;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  return fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
}

/** 运维页展示/操作的三个仓库（代码 / 知识库 / 原文）。 */
export function repoDescriptors(input: { readonly dataDir: string; readonly vaultRoot: string }): readonly RepoDescriptor[] {
  const overrides = readRepoOverrides(input.dataDir);
  const base: readonly RepoDescriptor[] = [
    { key: 'code', label: '代码仓库（server/worker）', path: codeRepoRoot() },
    { key: 'vault', label: '知识库 vault', path: input.vaultRoot },
    { key: 'raw', label: '原文 raw', path: path.join(input.vaultRoot, 'raw') },
  ];
  return base.map((repo) => {
    const override = overrides[repo.key];
    return {
      ...repo,
      path: override?.path !== undefined && override.path !== '' ? path.resolve(override.path) : repo.path,
      ...(override?.remote !== undefined ? { remoteOverride: override.remote } : {}),
    };
  });
}

/** 读取 DATA_DIR/repos.json 中的路径/远端覆盖（运维页「修改远端」写入）。 */
export function readRepoOverrides(dataDir: string): RepoOverrides {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'repos.json'), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const result: Record<string, { path?: string; remote?: string }> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const next: { path?: string; remote?: string } = {};
      if (typeof entry.path === 'string' && entry.path.trim() !== '') next.path = entry.path.trim();
      if (typeof entry.remote === 'string' && entry.remote.trim() !== '') next.remote = entry.remote.trim();
      if (Object.keys(next).length > 0) result[key] = next;
    }
    return result;
  } catch {
    return {};
  }
}

export function writeRepoOverrides(dataDir: string, overrides: RepoOverrides): void {
  const target = path.join(dataDir, 'repos.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
}

/** 只接受 https / ssh / git@ 形式的远端地址（避免命令行注入与误配）。 */
export function isValidRemoteUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 300) return false;
  if (/\s/.test(trimmed)) return false;
  return /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/u.test(trimmed);
}

async function git(repoPath: string, args: readonly string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim().slice(0, 300);
    return error.message.slice(0, 300);
  }
  return String(error).slice(0, 300);
}

/** 采集一个仓库的状态；`fetch=true` 时先 fetch 再算 ahead/behind（会走网络）。 */
export async function collectRepoStatus(descriptor: RepoDescriptor, options: { readonly fetch?: boolean } = {}): Promise<RepoStatus> {
  const base = {
    key: descriptor.key,
    label: descriptor.label,
    path: descriptor.path,
    exists: false,
    remote: descriptor.remoteOverride ?? null,
    branch: null,
    head: null,
    dirtyCount: 0,
    ahead: null as number | null,
    behind: null as number | null,
    fetchError: null as string | null,
    error: null as string | null,
  };

  if (!fs.existsSync(descriptor.path)) return { ...base, error: '目录不存在' };
  if (!fs.existsSync(path.join(descriptor.path, '.git'))) {
    // 服务端 git 安全目录检查可能让 .git 不可读，用 rev-parse 再确认一次
    try {
      await git(descriptor.path, ['rev-parse', '--git-dir']);
    } catch {
      return { ...base, error: '不是 git 仓库（或无权读取）' };
    }
  }

  let fetchError: string | null = null;
  if (options.fetch === true) {
    try {
      await git(descriptor.path, ['fetch', '--prune', '--quiet', 'origin'], FETCH_TIMEOUT_MS);
    } catch (error) {
      fetchError = errorMessage(error);
    }
  }

  let remote: string | null = descriptor.remoteOverride ?? null;
  try {
    const url = (await git(descriptor.path, ['remote', 'get-url', 'origin'])).trim();
    if (url !== '') remote = url;
  } catch {
    // 没有 origin：保留 override / null，由页面提示"未配置远端"
  }

  let branch: string | null = null;
  try {
    branch = (await git(descriptor.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    branch = null;
  }

  let head: RepoHeadInfo | null = null;
  try {
    const [sha, date, author, subject] = (await git(descriptor.path, ['log', '-1', '--format=%h%x1f%cI%x1f%an%x1f%s'])).trim().split('\x1f');
    if (sha !== undefined) {
      head = {
        sha,
        date: date ?? '',
        author: author ?? '',
        subject: subject ?? '',
      };
    }
  } catch {
    head = null;
  }

  let dirtyCount = 0;
  try {
    const dirty = await git(descriptor.path, ['status', '--porcelain']);
    dirtyCount = dirty.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    dirtyCount = 0;
  }

  let ahead: number | null = null;
  let behind: number | null = null;
  try {
    const counts = (await git(descriptor.path, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim().split(/\s+/);
    const left = Number(counts[0]);
    const right = Number(counts[1]);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      ahead = left;
      behind = right;
    }
  } catch {
    // 没有 upstream（如裸仓库/未设置 tracking）：保持 null
  }

  return {
    ...base,
    exists: true,
    remote,
    branch,
    head,
    dirtyCount,
    ahead,
    behind,
    fetchError,
    error: null,
  };
}

/** 对一个仓库执行 `git pull --ff-only`；失败返回原因（不回滚、不强制）。 */
export async function pullRepo(descriptor: RepoDescriptor): Promise<{ readonly ok: boolean; readonly detail: string }> {
  if (!fs.existsSync(descriptor.path)) return { ok: false, detail: '目录不存在' };
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', descriptor.path, 'pull', '--ff-only'], {
      timeout: PULL_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const text = `${stdout}\n${stderr}`.trim().split('\n').filter((line) => line.trim() !== '').slice(-3).join(' / ');
    return { ok: true, detail: text.slice(0, 300) || '已是最新' };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

/** 把本地提交推送到 origin（服务器写 vault 后必须做，否则知识只存在本机磁盘）。 */
export async function pushRepo(descriptor: RepoDescriptor): Promise<{ readonly ok: boolean; readonly detail: string }> {
  if (!fs.existsSync(descriptor.path)) return { ok: false, detail: '目录不存在' };
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', descriptor.path, 'push', 'origin', 'HEAD'], {
      timeout: PULL_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const text = `${stdout}\n${stderr}`.trim().split('\n').filter((line) => line.trim() !== '').slice(-3).join(' / ');
    return { ok: true, detail: text.slice(0, 300) || '已推送' };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

/** 修改仓库 origin 地址（换 GitHub 账号 / 迁移到自建 Git 服务时使用）。 */
export async function setRepoRemote(descriptor: RepoDescriptor, remote: string): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const trimmed = remote.trim();
  if (!isValidRemoteUrl(trimmed)) {
    return { ok: false, detail: '远端地址必须是 https://、ssh:// 或 git@ 开头且不含空白' };
  }
  try {
    await git(descriptor.path, ['remote', 'set-url', 'origin', trimmed]);
    return { ok: true, detail: `origin 已更新为 ${trimmed}` };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

/** 把 git remote 转成可点击的网页地址（GitHub/GitLab 的 https 形式）；无法识别时返回 null。 */
export function webRepoUrl(remote: string | null): string | null {
  if (remote === null) return null;
  const trimmed = remote.trim().replace(/\/+$/, '');
  const https = /^(https?:\/\/[^/]+\/.+?)(?:\.git)?$/.exec(trimmed);
  if (https) return (https[1] as string).replace(/\.git$/u, '');
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) {
    const host = ssh[1] as string;
    // SSH 别名（如 github-raw）不是真实域名：含 github 的一律视为 github.com
    const webHost = host.includes('github') ? 'github.com' : host;
    return `https://${webHost}/${(ssh[2] as string).replace(/\.git$/u, '')}`;
  }
  return null;
}
