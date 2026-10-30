import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileLock } from '../src/lock';

let dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lock-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('FileLock：单写者', () => {
  it('获取后可释放，释放后可再次获取', async () => {
    const lock = new FileLock({ dir: tmpDir() });

    const release = await lock.acquire('vault');
    await release();
    const again = await lock.acquire('vault');
    await again();
  });

  it('第二个持有者被拒绝（LOCK_HELD）', async () => {
    const lock = new FileLock({ dir: tmpDir() });
    const release = await lock.acquire('vault');

    await expect(lock.acquire('vault')).rejects.toMatchObject({ code: 'LOCK_HELD' });
    await release();
  });

  it('不同 key 互不影响', async () => {
    const lock = new FileLock({ dir: tmpDir() });
    const release = await lock.acquire('vault');
    const other = await lock.acquire('backup');
    await other();
    await release();
  });

  it('陈旧锁会被回收（超过 staleMs）', async () => {
    const dir = tmpDir();
    const lockDir = path.join(dir, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const lockFile = path.join(lockDir, 'vault.lock');
    fs.writeFileSync(lockFile, '{"pid":1}');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lockFile, old, old);

    const lock = new FileLock({ dir: lockDir, staleMs: 60_000 });
    const release = await lock.acquire('vault');
    const content = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number };
    expect(content.pid).toBe(process.pid);

    await release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('未过期的锁不会被回收', async () => {
    const dir = tmpDir();
    const lockDir = path.join(dir, 'locks');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'vault.lock'), '{"pid":1}');

    const lock = new FileLock({ dir: lockDir, staleMs: 60 * 60_000 });
    await expect(lock.acquire('vault')).rejects.toMatchObject({ code: 'LOCK_HELD' });
  });

  it('锁目录不存在时自动创建', async () => {
    const dir = tmpDir();
    const lock = new FileLock({ dir: path.join(dir, 'nested', 'locks') });
    const release = await lock.acquire('vault');
    expect(fs.existsSync(path.join(dir, 'nested', 'locks', 'vault.lock'))).toBe(true);
    await release();
  });
});
