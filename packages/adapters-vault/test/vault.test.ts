import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VaultError } from '../src/vault';
import { FsVault } from '../src/vault';
import { parseCommitSha, parseRawPath } from '@sb/domain';

let dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-vault-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function seedRaw(root: string, rel: string, content: string): void {
  const absolute = path.join(root, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

describe('FsVault：初始化与读取', () => {
  it('open 会创建 raw/ wiki/ 与 git 仓库，初始 head 为空', async () => {
    const root = tmpDir();
    const vault = FsVault.open({ root });

    expect(fs.existsSync(path.join(root, 'raw'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'wiki'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.git'))).toBe(true);
    expect(await vault.head()).toBeNull();
    expect(await vault.isClean()).toBe(true);
  });

  it('listRaw 返回路径、字节数与 sha256 前缀哈希', async () => {
    const root = tmpDir();
    const vault = FsVault.open({ root });
    seedRaw(root, 'raw/knowledge/cubox/a.md', '# a\n');
    seedRaw(root, 'raw/knowledge/podcast/b.md', '# b\n');

    const refs = await vault.listRaw();
    expect(refs.map((ref) => ref.path)).toEqual(['raw/knowledge/cubox/a.md', 'raw/knowledge/podcast/b.md']);
    expect(refs[0]?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(refs[0]?.sizeBytes).toBe(4);
  });

  it('readRaw 读取内容；不存在时报 FILE_NOT_FOUND', async () => {
    const root = tmpDir();
    const vault = FsVault.open({ root });
    seedRaw(root, 'raw/knowledge/cubox/a.md', '# hello\n');

    expect(await vault.readRaw(parseRawPathOk('raw/knowledge/cubox/a.md'))).toBe('# hello\n');
    await expect(vault.readRaw(parseRawPathOk('raw/knowledge/cubox/missing.md'))).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });

  it('readNode 只允许 wiki/ 路径', async () => {
    const root = tmpDir();
    const vault = FsVault.open({ root });
    seedRaw(root, 'wiki/concepts/反脆弱.md', '# 反脆弱\n');

    expect(await vault.readNode('wiki/concepts/反脆弱.md')).toBe('# 反脆弱\n');
    await expect(vault.readNode('raw/knowledge/cubox/a.md')).rejects.toBeInstanceOf(VaultError);
  });
});

describe('FsVault：写入与路径约束', () => {
  it('writeNode 原子写入并可按路径读回', async () => {
    const root = tmpDir();
    const vault = FsVault.open({ root });

    await vault.writeNode('wiki/concepts/幂律分布.md', '# 幂律分布\n');
    expect(await vault.readNode('wiki/concepts/幂律分布.md')).toBe('# 幂律分布\n');
    expect(await vault.isClean()).toBe(false);

    const leftovers = fs.readdirSync(path.join(root, 'wiki/concepts')).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('writeNode 拒绝 raw/ 与非 wiki 路径', async () => {
    const root = tmpDir();
    const vault = FsVault.open({ root });

    await expect(vault.writeNode('raw/knowledge/cubox/a.md', 'x')).rejects.toMatchObject({
      code: 'NOT_WIKI_PATH',
    });
  });

  it('拒绝路径逃逸（.. 与绝对路径）', async () => {
    const root = tmpDir();
    const vault = FsVault.open({ root });

    await expect(vault.writeNode('wiki/../../evil.md', 'x')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    await expect(vault.writeNode('/tmp/evil.md', 'x')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
    await expect(vault.readNode('../outside.md')).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  });
});

describe('FsVault：git 提交与回滚', () => {
  it('commitFiles 返回 sha，提交后工作区干净', async () => {
    const root = tmpDir();
    const vault = FsVault.open({ root });
    seedRaw(root, 'raw/knowledge/cubox/a.md', '# a\n');

    const sha = await vault.commitFiles(['raw/knowledge/cubox/a.md'], 'init');
    expect(parseCommitSha(sha).ok).toBe(true);
    expect(await vault.head()).toBe(sha);
    expect(await vault.isClean()).toBe(true);
  });

  it('没有变更时提交抛出 NO_CHANGES（不产生空 commit）', async () => {
    const root = tmpDir();
    const vault = FsVault.open({ root });
    seedRaw(root, 'raw/knowledge/cubox/a.md', '# a\n');
    await vault.commitFiles(['raw/knowledge/cubox/a.md'], 'init');

    await expect(vault.commitFiles(['raw/knowledge/cubox/a.md'], 'again')).rejects.toMatchObject({
      code: 'NO_CHANGES',
    });
  });

  it('resetHard 回滚到指定提交，文件内容恢复', async () => {
    const root = tmpDir();
    const vault = FsVault.open({ root });
    await vault.writeNode('wiki/concepts/a.md', 'v1');
    const first = await vault.commitFiles(['wiki/concepts/a.md'], 'v1');

    await vault.writeNode('wiki/concepts/a.md', 'v2');
    await vault.commitFiles(['wiki/concepts/a.md'], 'v2');
    expect(await vault.readNode('wiki/concepts/a.md')).toBe('v2');

    await vault.resetHard(first);
    expect(await vault.readNode('wiki/concepts/a.md')).toBe('v1');
    expect(await vault.head()).toBe(first);
  });

  it('提交信息写入 git log（可追溯）', async () => {
    const root = tmpDir();
    const vault = FsVault.open({ root });
    await vault.writeNode('wiki/concepts/a.md', 'x');
    await vault.commitFiles(['wiki/concepts/a.md'], 'digest: raw/knowledge/cubox/a.md');

    const log = fs.readFileSync(path.join(root, '.git/logs/HEAD'), 'utf8');
    expect(log).toContain('digest: raw/knowledge/cubox/a.md');
  });
});

function parseRawPathOk(value: string) {
  const parsed = parseRawPath(value);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

describe('FsVault：远端同步检测（P7.1）', () => {
  it('本地落后远端时 remoteBehind 返回提交数', async () => {
    const { execFileSync } = await import('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sync-'));
    try {
      const remote = path.join(tmp, 'remote.git');
      execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote]);
      const a = path.join(tmp, 'a');
      const b = path.join(tmp, 'b');
      execFileSync('git', ['clone', '-q', remote, a]);
      execFileSync('git', ['clone', '-q', remote, b]);

      execFileSync('git', ['-C', a, 'config', 'user.name', 'test']);
      execFileSync('git', ['-C', a, 'config', 'user.email', 'test@example.com']);
      fs.writeFileSync(path.join(a, 'x.md'), '# x\n');
      execFileSync('git', ['-C', a, 'add', '-A']);
      execFileSync('git', ['-C', a, 'commit', '-q', '-m', 'first']);
      execFileSync('git', ['-C', a, 'push', '-q', 'origin', 'main']);

      const vault = FsVault.open({ root: b });
      await vault.fetch();
      expect(await vault.remoteBehind()).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
