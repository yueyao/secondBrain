/**
 * 事件回放一致性：设计文档 §7.2 不变式 3 的验收测试。
 * 状态与事件同事务写入；用事件重新走一遍状态机，必须与库里的状态逐字段一致。
 */
import { describe, expect, it } from 'vitest';
import type { Clock } from '@sb/contracts';
import {
  applyEvents,
  decideTriage,
  parseCommitSha,
  parseContentHash,
  parseDraftId,
  parseRawPath,
  transition,
  type RawEvent,
  type Result,
} from '@sb/domain';
import { migrate } from '../src/migrate';
import { SqliteStore } from '../src/sqlite-store';

const NOW = '2026-10-30T22:00:00+08:00';
const clock: Clock = { now: () => NOW };
const CTX = { now: NOW, targetHashesUnchanged: true } as const;

function must<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const RAW = must(parseRawPath('raw/knowledge/podcast/e999.md'));
const DRAFT_ID = must(parseDraftId('draft-abc123'));
const SHA = must(parseCommitSha('abc1234'));
const HASH = must(parseContentHash(`sha256:${'a'.repeat(64)}`));
const TRIAGE = decideTriage({ judgments: 6, charCount: 1200 });

const EVENTS: readonly RawEvent[] = [
  { type: 'INGESTED' },
  { type: 'TRIAGE_QUEUED', triage: TRIAGE },
  { type: 'DRAFT_START', draftId: DRAFT_ID },
  { type: 'DRAFT_OK', draftId: DRAFT_ID, findings: [] },
  { type: 'REVIEW_OPEN', findings: [] },
  { type: 'ACCEPT', actor: 'owner' },
  { type: 'COMMIT_INTENT', intentId: 'intent-1', preCommitSha: null },
  { type: 'COMMIT_OK', commitSha: SHA },
];

async function openStore(): Promise<SqliteStore> {
  const store = SqliteStore.open({ path: ':memory:', clock });
  migrate(store.database, clock);
  await store.transaction(async (tx) =>
    tx.rawItems.upsert({
      id: 0,
      rawPath: RAW,
      contentHash: HASH,
      sourceKey: 'podcast',
      eventId: 'e999',
      title: '长期主义与时间套利',
      charCount: 1200,
      state: { kind: 'ingested' },
      version: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  return store;
}

/** 一笔事务内完成：状态迁移 + 乐观锁 + 事件追加（模拟真实用例）。 */
async function applyStep(store: SqliteStore, event: RawEvent): Promise<void> {
  await store.transaction(async (tx) => {
    const record = await tx.rawItems.getByPath(RAW);
    if (!record) throw new Error('raw_item 不存在');
    const next = transition(record.state, event, CTX);
    if (!next.ok) throw new Error(`迁移失败：${next.error.code}`);
    const swapped = await tx.rawItems.compareAndSwapVersion(record.id, record.version, next.value);
    if (!swapped) throw new Error('乐观锁冲突');
    await tx.events.append({
      at: NOW,
      actor: 'test',
      type: event.type,
      aggregateId: RAW,
      payload: event as unknown as Record<string, unknown>,
    });
  });
}

describe('事件回放一致性', () => {
  it('8 个事件回放后，状态与库中逐字段一致', async () => {
    const store = await openStore();

    for (const event of EVENTS) await applyStep(store, event);

    const stored = await store.transaction(async (tx) => tx.rawItems.getByPath(RAW));
    expect(stored?.state.kind).toBe('committed');
    if (stored?.state.kind === 'committed') expect(stored.state.commitSha).toBe(SHA);
    expect(stored?.version).toBe(EVENTS.length);

    const recorded = await store.transaction(async (tx) => tx.events.listSince(0));
    expect(recorded).toHaveLength(EVENTS.length);

    const replayed = applyEvents(
      { kind: 'ingested' },
      recorded.map((event) => event.payload as unknown as RawEvent),
      CTX,
    );
    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect(replayed.value).toEqual(stored?.state);

    await store.close();
  });

  it('事件顺序被改写后，回放会失败（不会假装成功）', async () => {
    const store = await openStore();
    for (const event of EVENTS) await applyStep(store, event);

    const recorded = await store.transaction(async (tx) => tx.events.listSince(0));
    const tampered = [...recorded];
    const commitOk = tampered.splice(tampered.length - 1, 1)[0];
    if (!commitOk) throw new Error('missing event');
    tampered.splice(2, 0, commitOk); // 把 COMMIT_OK 提前到 DRAFT_START 之前

    const replayed = applyEvents(
      { kind: 'ingested' },
      tampered.map((event) => event.payload as unknown as RawEvent),
      CTX,
    );
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) expect(replayed.error.code).toBe('INVALID_TRANSITION');

    await store.close();
  });

  it('非法迁移不落库：状态与事件都不变', async () => {
    const store = await openStore();
    await applyStep(store, { type: 'INGESTED' });
    await applyStep(store, { type: 'TRIAGE_QUEUED', triage: TRIAGE });

    const before = await store.transaction(async (tx) => tx.rawItems.getByPath(RAW));
    await expect(applyStep(store, { type: 'COMMIT_OK', commitSha: SHA })).rejects.toThrow(/迁移失败/);

    const after = await store.transaction(async (tx) => tx.rawItems.getByPath(RAW));
    expect(after?.state).toEqual(before?.state);
    expect(after?.version).toBe(before?.version);
    const events = await store.transaction(async (tx) => tx.events.listSince(0));
    expect(events).toHaveLength(2);

    await store.close();
  });

  it('同一时刻只有一个写者能推进版本（乐观锁并发）', async () => {
    const store = await openStore();
    const record = await store.transaction(async (tx) => tx.rawItems.getByPath(RAW));
    if (!record) throw new Error('missing');

    const results = await store.transaction(async (tx) => {
      const a = await tx.rawItems.compareAndSwapVersion(record.id, record.version, { kind: 'triaged' });
      const b = await tx.rawItems.compareAndSwapVersion(record.id, record.version, { kind: 'triaged' });
      return [a, b];
    });

    expect(results).toEqual([true, false]);
    await store.close();
  });
});
