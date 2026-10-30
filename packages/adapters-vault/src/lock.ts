/**
 * 单写者文件锁（设计文档 §8）。
 * 用 O_EXCL 原子创建锁文件；带 pid/时间戳与过期回收。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LockPort, Release } from '@sb/contracts';

export interface FileLockOptions {
  /** 锁文件目录（通常是 vault 下的 .sb/） */
  readonly dir: string;
  /** 超过该时长视为陈旧锁，可强制回收 */
  readonly staleMs?: number;
  /** 便于测试注入时间 */
  readonly now?: () => number;
}

export class FileLockError extends Error {
  constructor(
    readonly code: 'LOCK_HELD' | 'LOCK_IO',
    message: string,
  ) {
    super(message);
    this.name = 'FileLockError';
  }
}

export class FileLock implements LockPort {
  constructor(private readonly options: FileLockOptions) {}

  async acquire(key: string): Promise<Release> {
    const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = path.join(this.options.dir, `${safeKey}.lock`);
    const staleMs = this.options.staleMs ?? 5 * 60_000;
    const now = this.options.now ?? Date.now;

    fs.mkdirSync(this.options.dir, { recursive: true });

    const tryCreate = (): void => {
      try {
        const fd = fs.openSync(file, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
        fs.closeSync(fd);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw new FileLockError('LOCK_IO', `无法创建锁文件：${String(code)}`);
        }
      }

      const stat = fs.statSync(file);
      if (now() - stat.mtimeMs > staleMs) {
        fs.unlinkSync(file);
        tryCreate();
        return;
      }
      throw new FileLockError('LOCK_HELD', `锁被占用：${key}`);
    };

    tryCreate();

    return async () => {
      try {
        fs.unlinkSync(file);
      } catch {
        // 已释放或被回收：幂等
      }
    };
  }
}
