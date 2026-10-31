/**
 * 简化版 P5 的四个恢复场景：
 * 1) 文件已写、无 commit → 启动重放补 commit；
 * 2) commit 已存在、DB 仍是 approved → 只更新 DB，不重复提交；
 * 3) 存在无关脏改动且无待恢复草稿 → 拒绝启动；
 * 4) 目标文件在起草后被修改 → 拒绝覆盖并回滚。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDraftId, parseRawPath, transition, type RawPath, type RawState, type Result } from '@sb/domain';
import type { AppContext } from '../src/context';
import { decideReview, draftDigest, ingestAndTriage, recoverPending } from '../src/commands';
import { nodeFile, renderNewNode, renderPatchedNode } from '../src/render';
import { createHarness, hashPort, type TestHarness } from '@sb/testing';

function must<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function rawPathOf(value: string): RawPath {
  return must(parseRawPath(value));
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
    pricing: {},
    agentMeta: { provider: 'mock', model: 'heuristic-v1', promptId: 'digest', promptVersion: 1 },
  };
}

async function findRaw(harness: TestHarness, needle: string): Promise<RawPath> {
  const raws = await harness.vault.listRaw();
  const found = raws.map((ref) => String(ref.path)).find((path) => path.includes(needle));
  if (!found) throw new Error(`找不到 raw：${needle}`);
  return rawPathOf(found);
}

/** 模拟"批准后、提交前崩溃"：状态 approved + 文件已写，但没有 commit。 */
async function approveAndWriteWithoutCommit(
  ctx: AppContext,
  harness: TestHarness,
  rawPath: RawPath,
): Promise<string> {
  const { draftId } = await draftDigest(ctx, rawPath);
  const draft = await ctx.store.transaction(async (tx) => tx.drafts.get(draftId));
  if (!draft) throw new Error('draft 丢失');
  const now = ctx.clock.now();

  await ctx.store.transaction(async (tx) => {
    const item = await tx.rawItems.getByPath(rawPath);
    if (!item) throw new Error('item 丢失');
    let state: RawState = item.state;
    if (state.kind === 'draft_ready') {
      state = must(transition(state, { type: 'REVIEW_OPEN', findings: draft.findings }, { now }));
    }
    state = must(transition(state, { type: 'ACCEPT', actor: 'owner' }, { now }));
    const swapped = await tx.rawItems.compareAndSwapVersion(item.id, item.version, state);
    if (!swapped) throw new Error('CAS 失败');
    await tx.drafts.setStatus(draftId, 'approved');
  });

  const sourcePath = String(rawPath);
  for (const node of draft.proposal.nodes) {
    const file = node.action === 'new'
      ? nodeFile(node)
      : (ctx.search.allDocs().find((doc) => doc.name === node.name)?.file ?? nodeFile(node));
    const existing = node.action === 'new' ? null : await harness.vault.readNode(file).catch(() => null);
    const content = node.action === 'new'
      ? renderNewNode(node, draft.proposal.claims, sourcePath, now.slice(0, 10))
      : renderPatchedNode(existing ?? '', draft.proposal.claims, sourcePath, now.slice(0, 10));
    await harness.vault.writeNode(file, content);
  }
  return draftId;
}

let harness: TestHarness;
let ctx: AppContext;

beforeEach(async () => {
  harness = await createHarness();
  ctx = ctxOf(harness);
  await ingestAndTriage(ctx);
});

afterEach(async () => {
  await harness.cleanup();
});

describe('启动重放（简化版 P5）', () => {
  it('文件已写、无 commit：重放补提交，状态变 committed', async () => {
    const rawPath = await findRaw(harness, '反脆弱');
    const draftId = await approveAndWriteWithoutCommit(ctx, harness, rawPath);

    const report = await recoverPending(ctx);
    expect(report.recovered).toContain(draftId);

    const item = await ctx.store.transaction(async (tx) => tx.rawItems.getByPath(rawPath));
    expect(item?.state.kind).toBe('committed');
    const message = await harness.vault.lastCommitMessage();
    expect(message).toContain(`[${draftId}]`);
    expect(await harness.vault.isClean()).toBe(true);
  });

  it('commit 已存在、DB 仍是 approved：只更新 DB，不重复提交', async () => {
    const rawPath = await findRaw(harness, '幂律分布');
    const { draftId } = await draftDigest(ctx, rawPath);
    await decideReview(ctx, draftId, 'accept', { actor: 'owner' });
    const headAfterAccept = await harness.vault.head();

    // 模拟"commit 成功，但 DB 回写前崩溃"：把状态手动退回 approved
    const item = await ctx.store.transaction(async (tx) => tx.rawItems.getByPath(rawPath));
    if (!item || item.state.kind !== 'committed') throw new Error('前置状态不对');
    const back: RawState = {
      kind: 'approved',
      draftId: must(parseDraftId(item.state.draftId)),
      triage: item.state.triage,
      actor: 'owner',
      approvedAt: ctx.clock.now(),
    };
    await ctx.store.transaction(async (tx) => {
      await tx.rawItems.compareAndSwapVersion(item.id, item.version, back);
      await tx.drafts.setStatus(draftId, 'approved');
    });

    const report = await recoverPending(ctx);
    expect(report.recovered).toContain(draftId);
    expect(await harness.vault.head()).toBe(headAfterAccept);
    const restored = await ctx.store.transaction(async (tx) => tx.rawItems.getByPath(rawPath));
    expect(restored?.state.kind).toBe('committed');
  });

  it('无待恢复草稿但工作区脏：拒绝启动', async () => {
    await harness.vault.writeNode('wiki/concepts/外部修改.md', '# 外部修改\n');
    await expect(recoverPending(ctx)).rejects.toMatchObject({ code: 'DIRTY_VAULT' });
  });

  it('目标文件在起草后被修改：拒绝覆盖并回滚', async () => {
    const rawPath = await findRaw(harness, '反脆弱');
    const { draftId } = await draftDigest(ctx, rawPath);

    const target = 'wiki/concepts/反脆弱.md';
    const before = await harness.vault.readNode(target);
    await harness.vault.writeNode(target, `${before}\n- 外部追加的一行。\n`);

    await expect(decideReview(ctx, draftId, 'accept', { actor: 'owner' })).rejects.toMatchObject({
      code: 'TARGET_MOVED',
    });

    const after = await harness.vault.readNode(target);
    expect(after).toContain('外部追加的一行');
    const item = await ctx.store.transaction(async (tx) => tx.rawItems.getByPath(rawPath));
    expect(item?.state.kind).toBe('rolled_back');
    const draft = await ctx.store.transaction(async (tx) => tx.drafts.get(draftId));
    expect(draft?.status).toBe('pending');
  });
});
