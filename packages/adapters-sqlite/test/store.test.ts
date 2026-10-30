import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, DraftRecord, RawItemRecord } from '@sb/contracts';
import {
  decideTriage,
  parseCommitSha,
  parseContentHash,
  parseDraftId,
  parseRawPath,
  type RawState,
  type Result,
} from '@sb/domain';
import { migrate } from '../src/migrate';
import { SqliteStore } from '../src/sqlite-store';

const NOW = '2026-10-30T22:00:00+08:00';
const clock: Clock = { now: () => NOW };

function must<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const RAW = must(parseRawPath('raw/knowledge/cubox/a.md'));
const HASH = must(parseContentHash(`sha256:${'a'.repeat(64)}`));
const DRAFT = must(parseDraftId('draft-abc123'));
const SHA = must(parseCommitSha('abc1234'));

function item(overrides: Partial<RawItemRecord> = {}): RawItemRecord {
  return {
    id: 0,
    rawPath: RAW,
    contentHash: HASH,
    sourceKey: 'cubox',
    eventId: null,
    title: '一篇原文',
    charCount: 1200,
    state: { kind: 'ingested' },
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function draftRecord(): DraftRecord {
  return {
    id: DRAFT,
    rawItemId: 1,
    proposal: {
      tier: 'patch',
      rationale: '命中已有节点',
      claims: [{ text: '一条判断', inference: false, source: RAW }],
      nodes: [{ name: '反脆弱', nodeType: 'concept', action: 'patch', definition: null }],
    },
    findings: [{ ruleId: 'r-inferred-claims', severity: 'warn', code: 'INFERRED_CLAIMS', message: 'x', detail: {} }],
    provider: 'mock',
    model: 'mock',
    promptId: 'digest',
    promptVersion: 1,
    promptSha256: 'x'.repeat(64),
    inputTokens: 100,
    outputTokens: 20,
    latencyMs: 5,
    status: 'pending',
    createdAt: NOW,
  };
}

let store: SqliteStore;

beforeEach(() => {
  store = SqliteStore.open({ path: ':memory:', clock });
  migrate(store.database, clock);
});

afterEach(async () => {
  await store.close();
});

function count(table: string): number {
  const rows = store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all() as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

describe('事务', () => {
  it('成功提交后数据可见', async () => {
    await store.transaction(async (tx) => {
      await tx.rawItems.upsert(item());
    });
    expect(count('raw_item')).toBe(1);
  });

  it('抛错时整体回滚：状态与事件都不落库', async () => {
    await expect(
      store.transaction(async (tx) => {
        await tx.rawItems.upsert(item());
        await tx.events.append({ at: NOW, actor: 'test', type: 'INGESTED', aggregateId: RAW, payload: {} });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(count('raw_item')).toBe(0);
    expect(count('event')).toBe(0);
  });

  it('嵌套调用复用外层事务（不会重复 BEGIN）', async () => {
    await store.transaction(async (tx) => {
      await tx.events.append({ at: NOW, actor: 'test', type: 'A', aggregateId: RAW, payload: {} });
      await store.transaction(async (inner) => {
        await inner.events.append({ at: NOW, actor: 'test', type: 'B', aggregateId: RAW, payload: {} });
      });
    });
    expect(count('event')).toBe(2);
  });
});

describe('raw_item 仓储与乐观锁', () => {
  it('upsert / getByPath 往返一致，状态被编码为 kind + JSON', async () => {
    await store.transaction(async (tx) => {
      await tx.rawItems.upsert(item({ state: { kind: 'triaged' } }));
    });
    const stored = await store.transaction(async (tx) => tx.rawItems.getByPath(RAW));

    expect(stored).toMatchObject({ rawPath: RAW, version: 0, state: { kind: 'triaged' } });
    expect(stored?.id).toBeGreaterThan(0);
  });

  it('版本匹配时迁移成功，版本号自增', async () => {
    await store.transaction(async (tx) => tx.rawItems.upsert(item()));
    const record = await store.transaction(async (tx) => tx.rawItems.getByPath(RAW));
    if (!record) throw new Error('missing');

    const triage = decideTriage({ judgments: 6, charCount: 1200 });
    const next: RawState = { kind: 'queued', triage };

    const swapped = await store.transaction(async (tx) =>
      tx.rawItems.compareAndSwapVersion(record.id, record.version, next),
    );
    expect(swapped).toBe(true);

    const after = await store.transaction(async (tx) => tx.rawItems.getByPath(RAW));
    expect(after?.version).toBe(1);
    expect(after?.state.kind).toBe('queued');
    if (after?.state.kind === 'queued') {
      expect(after.state.triage.policyId).toBe('triage-policy');
      expect(after.state.triage.policyVersion).toBe(1);
    }
  });

  it('版本陈旧时拒绝写入（乐观锁生效）', async () => {
    await store.transaction(async (tx) => tx.rawItems.upsert(item()));
    const record = await store.transaction(async (tx) => tx.rawItems.getByPath(RAW));
    if (!record) throw new Error('missing');

    const first = await store.transaction(async (tx) =>
      tx.rawItems.compareAndSwapVersion(record.id, record.version, { kind: 'triaged' }),
    );
    const stale = await store.transaction(async (tx) =>
      tx.rawItems.compareAndSwapVersion(record.id, record.version, { kind: 'quarantined', reason: 'x' }),
    );

    expect(first).toBe(true);
    expect(stale).toBe(false);
    const after = await store.transaction(async (tx) => tx.rawItems.getByPath(RAW));
    expect(after?.state.kind).toBe('triaged');
    expect(after?.version).toBe(1);
  });

  it('listByState / listAll 可按状态与全量查询', async () => {
    await store.transaction(async (tx) => {
      await tx.rawItems.upsert(item({ state: { kind: 'ingested' } }));
      await tx.rawItems.upsert(
        item({ rawPath: must(parseRawPath('raw/knowledge/cubox/b.md')), state: { kind: 'triaged' } }),
      );
    });

    const triaged = await store.transaction(async (tx) => tx.rawItems.listByState(['triaged']));
    const all = await store.transaction(async (tx) => tx.rawItems.listAll());

    expect(triaged).toHaveLength(1);
    expect(triaged[0]?.rawPath).toBe('raw/knowledge/cubox/b.md');
    expect(all).toHaveLength(2);
    expect(await store.transaction(async (tx) => tx.rawItems.listByState([]))).toEqual([]);
  });
});

describe('draft / decision / commit', () => {
  it('草稿写入后可读回，状态可更新', async () => {
    await store.transaction(async (tx) => tx.rawItems.upsert(item()));
    await store.transaction(async (tx) => tx.drafts.insert(draftRecord()));

    const loaded = await store.transaction(async (tx) => tx.drafts.get(DRAFT));
    expect(loaded).toMatchObject({ id: DRAFT, status: 'pending', provider: 'mock', promptVersion: 1 });
    expect(loaded?.proposal.claims).toHaveLength(1);
    expect(loaded?.findings[0]?.ruleId).toBe('r-inferred-claims');

    await store.transaction(async (tx) => tx.drafts.setStatus(DRAFT, 'approved'));
    const after = await store.transaction(async (tx) => tx.drafts.get(DRAFT));
    expect(after?.status).toBe('approved');
  });

  it('决策与提交记录可追加（审计留痕）', async () => {
    await store.transaction(async (tx) => {
      await tx.rawItems.upsert(item());
      await tx.drafts.insert(draftRecord());
      await tx.decisions.append({
        draftId: DRAFT,
        action: 'accept',
        note: '已核对',
        actor: 'owner',
        createdAt: NOW,
      });
      await tx.commits.append({ draftId: DRAFT, gitSha: SHA, files: ['wiki/concepts/a.md'], createdAt: NOW });
    });

    expect(count('review_decision')).toBe(1);
    expect(count('commit_record')).toBe(1);
    const committed = store.database.prepare('SELECT files FROM commit_record').all() as Array<{ files: string }>;
    expect(JSON.parse(String(committed[0]?.files))).toEqual(['wiki/concepts/a.md']);
  });
});

describe('job 队列：租约与围栏令牌', () => {
  it('enqueue → claimNext 领取并自增围栏令牌与尝试次数', async () => {
    await store.transaction(async (tx) => tx.jobs.enqueue({ kind: 'digest', target: RAW }));

    const claimed = await store.transaction(async (tx) => tx.jobs.claimNext('digest', 90_000));
    expect(claimed).toMatchObject({ kind: 'digest', state: 'running', attempts: 1, fencingToken: 1 });
    expect(claimed?.leaseUntil).toBe(new Date(new Date(NOW).getTime() + 90_000).toISOString());
  });

  it('队列为空时返回 null，不会误领其他 kind', async () => {
    await store.transaction(async (tx) => tx.jobs.enqueue({ kind: 'triage', target: 'raw/' }));
    expect(await store.transaction(async (tx) => tx.jobs.claimNext('digest', 1000))).toBeNull();
  });

  it('finish 后可再次领取没有新任务；同一条不会重复领取', async () => {
    await store.transaction(async (tx) => tx.jobs.enqueue({ kind: 'digest', target: RAW }));
    const first = await store.transaction(async (tx) => tx.jobs.claimNext('digest', 1000));
    if (!first) throw new Error('expected job');

    await store.transaction(async (tx) => tx.jobs.finish(first.id, 'done', null));
    expect(await store.transaction(async (tx) => tx.jobs.claimNext('digest', 1000))).toBeNull();
  });
});

describe('event 流', () => {
  it('seq 单调递增，listSince 只返回增量', async () => {
    const first = await store.transaction(async (tx) =>
      tx.events.append({ at: NOW, actor: 'a', type: 'X', aggregateId: RAW, payload: { n: 1 } }),
    );
    const second = await store.transaction(async (tx) =>
      tx.events.append({ at: NOW, actor: 'a', type: 'Y', aggregateId: RAW, payload: { n: 2 } }),
    );

    expect(first.seq).toBeGreaterThan(0);
    expect(second.seq).toBeGreaterThan(first.seq);

    const since = await store.transaction(async (tx) => tx.events.listSince(first.seq));
    expect(since).toHaveLength(1);
    expect(since[0]?.type).toBe('Y');
    expect(since[0]?.payload).toEqual({ n: 2 });
  });
});
