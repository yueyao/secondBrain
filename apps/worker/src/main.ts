/**
 * 服务端 worker：定时 ingest + 为 queued 条目生成草稿。
 * 铁律：不自动入库（accept 只能由人在审核台点击）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { draftDigest, ingestAndTriage, listQueue, type AppContext } from '@sb/app';
import { parseRawPath } from '@sb/domain';
import { createRuntime } from '../../server/src/runtime';

export interface TickOptions {
  readonly maxJobsPerTick: number;
  readonly onStatus?: (status: WorkerStatus) => void;
  /** 返回 true 时：当前文章处理完后不再开始新的文章 */
  readonly shouldPause?: () => boolean;
  /** 待审草稿达到该数量时停止起草（背压） */
  readonly maxPendingDrafts?: number;
}

export interface WorkerStatus {
  readonly phase: 'starting' | 'ingesting' | 'drafting' | 'sleeping' | 'paused' | 'stopping';
  readonly updatedAt: string;
  readonly rawPath?: string;
  readonly title?: string;
  readonly startedAt?: string;
  readonly lastTickAt?: string;
  readonly lastTick?: TickResult;
}

export interface TickResult {
  readonly ingested: number;
  readonly drafted: number;
  readonly failed: number;
  readonly queueLength: number;
  readonly paused: boolean;
  readonly pausedReason?: 'user' | 'pending_limit';
}

/** 单次 tick：ingest 全部新原文，再为最多 N 个 queued 条目起草。 */
export async function runTick(ctx: AppContext, options: TickOptions): Promise<TickResult> {
  if (options.shouldPause?.()) {
    options.onStatus?.({ phase: 'paused', updatedAt: new Date().toISOString() });
    return { ingested: 0, drafted: 0, failed: 0, queueLength: 0, paused: true };
  }

  options.onStatus?.({ phase: 'ingesting', updatedAt: new Date().toISOString() });
  const outcomes = await ingestAndTriage(ctx);
  const queue = await listQueue(ctx);
  const maxPendingDrafts = options.maxPendingDrafts ?? Number(process.env.WORKER_MAX_PENDING_DRAFTS ?? 300);
  const pendingDrafts = (await ctx.store.transaction(async (tx) => tx.drafts.listByStatus('pending'))).length;
  if (pendingDrafts >= maxPendingDrafts) {
    const result: TickResult = { ingested: outcomes.length, drafted: 0, failed: 0, queueLength: queue.length, paused: true, pausedReason: 'pending_limit' };
    options.onStatus?.({ phase: 'sleeping', updatedAt: new Date().toISOString(), lastTickAt: new Date().toISOString(), lastTick: result });
    return result;
  }
  const candidates = queue.filter((entry) => entry.state === 'queued').slice(0, options.maxJobsPerTick);

  let drafted = 0;
  let failed = 0;
  let paused = false;
  for (const entry of candidates) {
    if (options.shouldPause?.()) {
      paused = true;
      break;
    }
    const parsed = parseRawPath(entry.rawPath);
    if (!parsed.ok) {
      failed += 1;
      console.error(JSON.stringify({ level: 'warn', event: 'invalid_raw_path', rawPath: entry.rawPath }));
      continue;
    }
    options.onStatus?.({
      phase: 'drafting',
      updatedAt: new Date().toISOString(),
      rawPath: entry.rawPath,
      title: entry.title,
      startedAt: new Date().toISOString(),
    });
    try {
      await draftDigest(ctx, parsed.value);
      drafted += 1;
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({
        level: 'error',
        event: 'digest_failed',
        rawPath: entry.rawPath,
        error: String((error as Error).message ?? error),
      }));
    }
  }

  const result: TickResult = { ingested: outcomes.length, drafted, failed, queueLength: queue.length, paused };
  options.onStatus?.({
    phase: 'sleeping',
    updatedAt: new Date().toISOString(),
    lastTickAt: new Date().toISOString(),
    lastTick: result,
  });
  return result;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main(): Promise<void> {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error('缺少 DATA_DIR');
  const intervalMs = envNumber('WORKER_INTERVAL_MS', 300_000);
  const maxJobsPerTick = envNumber('WORKER_MAX_JOBS', 5);
  const once = process.env.WORKER_ONCE === '1';

  if (!process.env.MODEL_BASE_URL && process.env.WORKER_ALLOW_MOCK !== '1') {
    throw new Error('worker 拒绝以 mock 模式运行（会为真实文章生成假草稿）；请配置 MODEL_BASE_URL，或显式设置 WORKER_ALLOW_MOCK=1 用于演示');
  }

  const runtime = await createRuntime({
    dataDir,
    ...(process.env.VAULT_ROOT ? { vaultRoot: process.env.VAULT_ROOT } : {}),
    seedDemo: false,
  });

  const statusFile = path.join(dataDir, 'worker-status.json');
  const writeStatus = (status: WorkerStatus): void => {
    const tmp = `${statusFile}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(status), 'utf8');
      fs.renameSync(tmp, statusFile);
    } catch {
      // 状态文件写失败不影响主流程
    }
  };
  const pauseFile = path.join(dataDir, 'worker-pause.json');
  const isPaused = (): boolean => fs.existsSync(pauseFile);
  writeStatus({ phase: 'starting', updatedAt: new Date().toISOString() });

  const readPendingLimit = (): number => {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'ops-config.json'), 'utf8')) as { pendingLimit?: number };
      if (typeof config.pendingLimit === 'number' && config.pendingLimit > 0) return config.pendingLimit;
    } catch { /* 忽略，用默认 */ }
    return envNumber('WORKER_MAX_PENDING_DRAFTS', 300);
  };

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { stopping = true; });
  }

  try {
    while (!stopping) {
      if (isPaused()) {
        writeStatus({ phase: 'paused', updatedAt: new Date().toISOString() });
        await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, 10_000)));
        continue;
      }
      const result = await runTick(runtime.ctx, { maxJobsPerTick, onStatus: writeStatus, shouldPause: isPaused, maxPendingDrafts: readPendingLimit() });
      console.log(JSON.stringify({ level: 'info', event: 'tick', at: new Date().toISOString(), ...result }));
      if (once) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    writeStatus({ phase: 'stopping', updatedAt: new Date().toISOString() });
    await runtime.close();
  }
}

if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'fatal', error: String((error as Error).message ?? error) }));
    process.exit(1);
  });
}
