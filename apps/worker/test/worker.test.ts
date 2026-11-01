import { describe, expect, it } from 'vitest';
import type { AppContext } from '@sb/app';
import { createHarness, hashPort, type TestHarness } from '@sb/testing';
import { runTick } from '../src/main';

function ctxOf(harness: TestHarness): AppContext {
  return {
    store: harness.store,
    vault: harness.vault,
    search: harness.search,
    agent: harness.agent,
    clock: harness.clock,
    ids: harness.ids,
    hash: hashPort,
    config: { longTextThreshold: 200_000, enabledSources: ['cubox', 'notions', 'podcast', 'dedao', 'general'] },
    pricing: {},
    agentMeta: { provider: 'mock', model: 'heuristic-v1', promptId: 'digest', promptVersion: 1 },
  };
}

describe('worker tick', () => {
  it('ingest 后为 queued 条目起草，但绝不自动入库', async () => {
    const harness = await createHarness();
    try {
      const ctx = ctxOf(harness);
      const result = await runTick(ctx, { maxJobsPerTick: 10 });

      expect(result.ingested).toBeGreaterThan(0);
      expect(result.drafted).toBe(result.queueLength);
      expect(result.drafted).toBeGreaterThan(0);
      expect(result.failed).toBe(0);

      const drafts = await ctx.store.transaction(async (tx) => tx.drafts.listByStatus('pending'));
      expect(drafts.length).toBe(result.drafted);

      const committed = await ctx.store.transaction(async (tx) => tx.rawItems.listByState(['committed']));
      expect(committed.length).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  it('再次 tick 不会重复起草已有草稿的条目', async () => {
    const harness = await createHarness();
    try {
      const ctx = ctxOf(harness);
      await runTick(ctx, { maxJobsPerTick: 10 });
      const second = await runTick(ctx, { maxJobsPerTick: 10 });

      expect(second.drafted).toBe(0);
      const drafts = await ctx.store.transaction(async (tx) => tx.drafts.listByStatus('pending'));
      expect(drafts.length).toBe(4);
    } finally {
      await harness.cleanup();
    }
  });
});
