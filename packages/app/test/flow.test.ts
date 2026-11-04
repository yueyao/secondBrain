import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRawPath, type RawPath } from '@sb/domain';
import type { AppContext } from '../src/context';
import { decideReview, draftDigest, ingestAndTriage } from '../src/commands';
import { preflightDrafts } from '../src/preflight';
import { repairPendingDrafts } from '../src/repair';
import { listPendingDrafts, listQueue, reviewView, usageSummary } from '../src/queries';
import { createHarness, hashPort, type TestHarness } from '@sb/testing';

function rawPath(value: string): RawPath {
  const parsed = parseRawPath(value);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function ctxOf(harness: TestHarness): AppContext {
  return {
    store: harness.store,
    vault: harness.vault,
    search: harness.search,
    agent: harness.agent,
    clock: harness.clock,
    ids: harness.ids,
    hash: hashPort,
    config: {
      longTextThreshold: 60_000,
      enabledSources: ['cubox', 'notions', 'podcast', 'dedao', 'general'],
    },
    agentMeta: { provider: 'mock', model: 'heuristic-v1', promptId: 'digest', promptVersion: 1 },
    pricing: { 'mock-profile': { inPerMTokens: 1, outPerMTokens: 3 } },
  };
}

async function findRaw(harness: TestHarness, needle: string): Promise<RawPath> {
  const raws = await harness.vault.listRaw();
  const found = raws.map((ref) => String(ref.path)).find((path) => path.includes(needle));
  if (!found) throw new Error(`找不到 raw：${needle}`);
  return rawPath(found);
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('应用层：完整流程', () => {
  it('ingestAndTriage 幂等：4 篇入队、1 篇低价值、1 篇超长延后', async () => {
    const ctx = ctxOf(harness);
    const first = await ingestAndTriage(ctx);
    const second = await ingestAndTriage(ctx);

    expect(second.map((item) => item.state)).toEqual(first.map((item) => item.state));
    const states = first.map((item) => item.state);
    expect(states.filter((state) => state === 'queued')).toHaveLength(4);
    // deferred 同时涵盖 low_value 与 too_long 两种原因
    expect(states.filter((state) => state === 'deferred')).toHaveLength(3);
    expect(first.filter((item) => item.reason === 'low_value')).toHaveLength(2);
    const tooLong = first.find((item) => item.reason === 'too_long');
    expect(tooLong?.state).toBe('deferred');
  });

  it('digest → 预览 → accept：写入 wiki 并产生 git commit', async () => {
    const ctx = ctxOf(harness);
    const target = await findRaw(harness, '反脆弱');
    await ingestAndTriage(ctx);

    const { draftId, findings } = await draftDigest(ctx, target);
    expect(findings.some((finding) => finding.severity === 'block')).toBe(false);

    const view = await reviewView(ctx, draftId);
    expect(view.schemaVersion).toBe(1);
    expect(view.actions.accept).toBe(true);
    expect(view.nodes[0]?.action).toBe('patch');

    const result = await decideReview(ctx, draftId, 'accept', { actor: 'owner', note: '已核对' });
    expect(result.ok).toBe(true);
    expect(result.commit).toBeTruthy();

    const content = await harness.vault.readNode('wiki/concepts/反脆弱.md');
    expect(content).toContain('（来源：[[raw/knowledge/cubox/mock-2026-10-01 反脆弱的第二条证据.md]]）');
    expect(await harness.vault.head()).toBe(result.commit);
  });

  it('同一事件的第二份来源被阻断，只能 reject', async () => {
    const ctx = ctxOf(harness);
    await ingestAndTriage(ctx);

    const first = await draftDigest(ctx, await findRaw(harness, 'mock-E999 长期主义'));
    await decideReview(ctx, first.draftId, 'accept', { actor: 'owner' });

    const { draftId, findings } = await draftDigest(ctx, await findRaw(harness, 'mock-E999b'));
    expect(findings.map((finding) => finding.ruleId)).toContain('r-event-already-digested');

    await expect(decideReview(ctx, draftId, 'accept', { actor: 'owner' })).rejects.toMatchObject({
      code: 'GATE_BLOCKED',
    });

    const rejected = await decideReview(ctx, draftId, 'reject', { actor: 'owner', note: '重复源' });
    expect(rejected.state).toBe('rejected');
  });

  it('同批重基：显式 rebaseFiles 允许对被改过的目标节点追加写入', async () => {
    const ctx = ctxOf(harness);
    await ingestAndTriage(ctx);
    const { draftId } = await draftDigest(ctx, await findRaw(harness, '反脆弱的第二条证据'));

    const target = 'wiki/concepts/反脆弱.md';
    const before = await harness.vault.readNode(target);
    await harness.vault.writeNode(target, `${before}\n- 外部追加的一行。\n`);

    // 同批场景：允许把 claims 追加到最新内容，保留外部追加（无授权时的拒绝由 recovery 测试覆盖）
    const result = await decideReview(ctx, draftId, 'accept', { actor: 'owner', rebaseFiles: new Set([target]) });
    expect(result.ok).toBe(true);
    const after = await harness.vault.readNode(target);
    expect(after).toContain('外部追加的一行');
    expect(after).toContain('（来源：[[raw/knowledge/cubox/mock-2026-10-01 反脆弱的第二条证据.md]]）');
  });

  it('批量重试：rebaseAll 允许对已被改过的节点追加写入', async () => {
    const ctx = ctxOf(harness);
    await ingestAndTriage(ctx);
    const { draftId } = await draftDigest(ctx, await findRaw(harness, '反脆弱的第二条证据'));
    const target = 'wiki/concepts/反脆弱.md';
    const before = await harness.vault.readNode(target);
    await harness.vault.writeNode(target, `${before}\n- 批量重试前的外部追加。\n`);

    const result = await decideReview(ctx, draftId, 'accept', { actor: 'owner', note: '批量通过', rebaseAll: true });
    expect(result.ok).toBe(true);
    const after = await harness.vault.readNode(target);
    expect(after).toContain('批量重试前的外部追加');
    expect(after).toContain('（来源：[[raw/knowledge/cubox/mock-2026-10-01 反脆弱的第二条证据.md]]）');
  });

  it('patch 目标用别名也能解析到同一节点文件', async () => {
    const ctx = ctxOf(harness);
    await ingestAndTriage(ctx);
    const { draftId } = await draftDigest(ctx, await findRaw(harness, '反脆弱的第二条证据'));
    // 把 patch 目标的 name 换成该节点的别名，模拟模型输出别名的情况
    const draft = await ctx.store.transaction(async (tx) => tx.drafts.get(draftId));
    if (!draft) throw new Error('draft missing');
    const nodes = draft.proposal.nodes.map((node) => (node.action === 'patch' ? { ...node, name: 'antifragile' } : node));
    await ctx.store.transaction(async (tx) => tx.drafts.updateReview(draftId, { ...draft.proposal, nodes }, draft.findings, draft.targetHashes));

    const result = await decideReview(ctx, draftId, 'accept', { actor: 'owner' });
    expect(result.ok).toBe(true);
    const content = await harness.vault.readNode('wiki/concepts/反脆弱.md');
    expect(content).toContain('（来源：[[raw/knowledge/cubox/mock-2026-10-01 反脆弱的第二条证据.md]]）');
  });

  it('修复来源缺失：按 raw 真实路径回填，解除 source-exists', async () => {
    const ctx = ctxOf(harness);
    await ingestAndTriage(ctx);
    const { draftId } = await draftDigest(ctx, await findRaw(harness, '反脆弱的第二条证据'));
    const draft = await ctx.store.transaction(async (tx) => tx.drafts.get(draftId));
    if (!draft) throw new Error('draft missing');
    const claims = draft.proposal.claims.map((claim, index) => (index === 0 ? { ...claim, source: 'raw/knowledge/cubox/missing.md' as never } : claim));
    await ctx.store.transaction(async (tx) => tx.drafts.updateReview(draftId, { ...draft.proposal, claims }, draft.findings, draft.targetHashes));

    const report = await repairPendingDrafts(ctx);
    expect(report.repaired).toBeGreaterThanOrEqual(1);
    const after = await ctx.store.transaction(async (tx) => tx.drafts.get(draftId));
    expect(String(after?.proposal.claims[0]?.source)).toContain('反脆弱的第二条证据');
  });

  it('批量预检：正常草稿 ok，未知 id invalid，避免整批先 approved 再回滚', async () => {
    const ctx = ctxOf(harness);
    await ingestAndTriage(ctx);
    const { draftId } = await draftDigest(ctx, await findRaw(harness, '反脆弱的第二条证据'));
    const report = await preflightDrafts(ctx, [draftId, 'draft-000000000000']);
    expect(report.ok).toBe(1);
    expect(report.invalid).toBe(1);
    expect(report.blocked).toBe(0);
    expect(report.rows.find((row) => row.draftId === draftId)?.status).toBe('ok');
    expect(report.rows.find((row) => row.draftId === 'draft-000000000000')?.status).toBe('invalid');
  });

  it('全新概念走 new 分支并生成节点文件', async () => {
    const ctx = ctxOf(harness);
    await ingestAndTriage(ctx);

    const { draftId, proposal } = await draftDigest(ctx, await findRaw(harness, '幂律分布'));
    expect(proposal.nodes[0]?.action).toBe('new');

    await decideReview(ctx, draftId, 'accept', { actor: 'owner' });
    const content = await harness.vault.readNode('wiki/concepts/幂律分布.md');
    expect(content).toContain('name: "幂律分布"');
    expect(content).toContain('confirmed: true');
  });

  it('队列与待审读模型可用于 UI', async () => {
    const ctx = ctxOf(harness);
    await ingestAndTriage(ctx);
    await draftDigest(ctx, await findRaw(harness, '幂律分布'));

    const queue = await listQueue(ctx);
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.every((item) => item.schemaVersion === 1)).toBe(true);

    const pending = await listPendingDrafts(ctx);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.actions.accept).toBe(true);
  });
});


describe('用量账本', () => {
  it('每次起草记录 tokens / profile / 缓存命中，并能按天汇总', async () => {
    const ctx = ctxOf(harness);
    await ingestAndTriage(ctx);
    await draftDigest(ctx, await findRaw(harness, '反脆弱'));

    const summary = await usageSummary(ctx);
    expect(summary.totals.calls).toBe(1);
    expect(summary.totals.inputTokens).toBe(1200);
    expect(summary.totals.outputTokens).toBe(300);
    expect(summary.totals.cacheHits).toBe(0);
    expect(summary.byProfile[0]?.profileId).toBe('mock-profile');

    // 价格表：1/M in + 3/M out → 1200/1e6*1 + 300/1e6*3 = 0.0021
    expect(summary.totals.estimatedCost).toBeCloseTo(0.0021, 6);
    expect(summary.days[0]?.day).toBe('2026-10-30');
  });

  it('没有价格表时只统计 tokens，成本为 0', async () => {
    const ctx = { ...ctxOf(harness), pricing: {} };
    await ingestAndTriage(ctx);
    await draftDigest(ctx, await findRaw(harness, '反脆弱'));

    const summary = await usageSummary(ctx);
    expect(summary.totals.inputTokens).toBe(1200);
    expect(summary.totals.estimatedCost).toBe(0);
  });
});
