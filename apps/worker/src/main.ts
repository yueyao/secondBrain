/**
 * 服务端 worker：定时 ingest + 为 queued 条目生成草稿。
 * 铁律：不自动入库（accept 只能由人在审核台点击）。
 */
import { draftDigest, ingestAndTriage, listQueue, type AppContext } from '@sb/app';
import { parseRawPath } from '@sb/domain';
import { createRuntime } from '../../server/src/runtime';

export interface TickOptions {
  readonly maxJobsPerTick: number;
}

export interface TickResult {
  readonly ingested: number;
  readonly drafted: number;
  readonly failed: number;
  readonly queueLength: number;
}

/** 单次 tick：ingest 全部新原文，再为最多 N 个 queued 条目起草。 */
export async function runTick(ctx: AppContext, options: TickOptions): Promise<TickResult> {
  const outcomes = await ingestAndTriage(ctx);
  const queue = await listQueue(ctx);
  const candidates = queue.filter((entry) => entry.state === 'queued').slice(0, options.maxJobsPerTick);

  let drafted = 0;
  let failed = 0;
  for (const entry of candidates) {
    const parsed = parseRawPath(entry.rawPath);
    if (!parsed.ok) {
      failed += 1;
      console.error(JSON.stringify({ level: 'warn', event: 'invalid_raw_path', rawPath: entry.rawPath }));
      continue;
    }
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

  return { ingested: outcomes.length, drafted, failed, queueLength: queue.length };
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

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => { stopping = true; });
  }

  try {
    while (!stopping) {
      const result = await runTick(runtime.ctx, { maxJobsPerTick });
      console.log(JSON.stringify({ level: 'info', event: 'tick', at: new Date().toISOString(), ...result }));
      if (once) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    await runtime.close();
  }
}

if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'fatal', error: String((error as Error).message ?? error) }));
    process.exit(1);
  });
}
