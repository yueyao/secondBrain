/**
 * 契约冒烟测试：证明端口"可实现"、DTO 形状稳定。
 * 这里不测业务逻辑（那是 @sb/domain 的事），只测契约本身可用。
 */
import { describe, expect, it } from 'vitest';
import type {
  AgentPort,
  Clock,
  LockPort,
  ReviewViewV1,
  ScoredHit,
  SearchIndex,
  StateStore,
  Transaction,
  VaultPort,
} from '@sb/contracts';
import { QUEUE_ITEM_SCHEMA_VERSION, REVIEW_VIEW_SCHEMA_VERSION } from '@sb/contracts';
import {
  decideTriage,
  makeFinding,
  parseCommitSha,
  parseContentHash,
  parseDraftId,
  parseNodeId,
  parseRawPath,
  type DraftProposal,
  type Result,
} from '@sb/domain';

function must<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const RAW_A = must(parseRawPath('raw/knowledge/cubox/a.md'));
const DRAFT_ID = must(parseDraftId('draft-abc123'));
const COMMIT_SHA = must(parseCommitSha('abc1234'));
const CONTENT_HASH = must(parseContentHash(`sha256:${'a'.repeat(64)}`));

const clock: Clock = { now: () => '2026-10-30T22:00:00+08:00' };

const lock: LockPort = {
  acquire: async (key: string) => {
    if (key.length === 0) throw new Error('lock key 不能为空');
    return async () => undefined;
  },
};

function fakeTransaction(): Transaction {
  const nope = (label: string) => () => {
    throw new Error(`${label} 未实现（冒烟测试）`);
  };
  return {
    rawItems: {
      getByPath: nope('getByPath'),
      upsert: nope('upsert'),
      compareAndSwapVersion: nope('compareAndSwapVersion'),
      listByState: nope('listByState'),
      listAll: nope('listAll'),
    },
    drafts: { insert: nope('insert'), get: nope('get'), setStatus: nope('setStatus') },
    decisions: { append: nope('append') },
    commits: { append: nope('append') },
    jobs: { enqueue: nope('enqueue'), claimNext: nope('claimNext'), finish: nope('finish') },
    events: { append: nope('append'), listSince: nope('listSince') },
  };
}

const store: StateStore = {
  transaction: async <T,>(fn: (tx: Transaction) => Promise<T>): Promise<T> => fn(fakeTransaction()),
  close: async () => undefined,
};

const files = new Map<string, string>();
const vault: VaultPort = {
  listRaw: async () => [{ path: RAW_A, sizeBytes: 10, contentHash: CONTENT_HASH }],
  readRaw: async (path) => files.get(path) ?? '',
  listNodes: async () => [...files.keys()].filter((file) => file.startsWith('wiki/')),
  readNode: async (file) => files.get(file) ?? '',
  writeNode: async (file, content) => {
    files.set(file, content);
  },
  head: async () => COMMIT_SHA,
  isClean: async () => true,
  commitFiles: async (changed, message) => {
    expect(changed.length).toBeGreaterThan(0);
    expect(message.length).toBeGreaterThan(0);
    return COMMIT_SHA;
  },
  resetHard: async (sha) => {
    expect(sha).toBe(COMMIT_SHA);
  },
};

const index: SearchIndex = {
  upsert: async () => undefined,
  remove: async () => undefined,
  query: async (q, limit = 10) => {
    const hits: ScoredHit[] = [
      {
        nodeId: must(parseNodeId('concept:反脆弱')),
        name: '反脆弱',
        file: 'wiki/concepts/反脆弱.md',
        score: 100,
        matchType: 'name_exact',
      },
    ];
    return q === '反脆弱' ? hits.slice(0, limit) : [];
  },
};

const agent: AgentPort = {
  draft: async (request): Promise<DraftProposal> => {
    expect(request.tools).toEqual(['search_wiki', 'read_node', 'read_raw']);
    expect(request.tools).not.toContain('write_node');
    expect(request.budget.maxInputTokens).toBeGreaterThan(0);
    return {
      tier: 'patch',
      rationale: '命中已有节点',
      claims: [{ text: '一条判断', inference: false, source: request.rawPath }],
      nodes: [{ name: '反脆弱', nodeType: 'concept', action: 'patch', definition: null }],
    };
  },
};

describe('契约：端口可实现', () => {
  it('StateStore.transaction 把 tx 传给用例并返回结果', async () => {
    const result = await store.transaction(async (tx) => tx.events);
    expect(result).toBeDefined();
    await expect(store.transaction(async (tx) => tx.drafts.get(DRAFT_ID))).rejects.toThrow(/未实现/);
  });

  it('VaultPort 能在内存里完成读写提交回滚的完整闭环', async () => {
    await vault.writeNode('wiki/concepts/a.md', '# a');
    expect(await vault.readNode('wiki/concepts/a.md')).toBe('# a');
    expect(await vault.isClean()).toBe(true);
    expect(await vault.commitFiles(['wiki/concepts/a.md'], 'digest: a')).toBe('abc1234');
    expect(await vault.head()).toBe('abc1234');
  });

  it('SearchIndex 返回带得分与匹配类型的命中', async () => {
    const hits = await index.query('反脆弱');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ name: '反脆弱', score: 100, matchType: 'name_exact' });
    expect(await index.query('不存在')).toEqual([]);
  });

  it('AgentPort 收到只读工具白名单，返回 DraftProposal', async () => {
    const proposal = await agent.draft({
      rawPath: RAW_A,
      content: '正文',
      retrieved: [],
      tools: ['search_wiki', 'read_node', 'read_raw'],
      budget: { maxInputTokens: 40_000, maxOutputTokens: 4_000, maxToolCalls: 6 },
    });
    expect(proposal.tier).toBe('patch');
    expect(proposal.claims[0]?.source).toBe(RAW_A);
  });

  it('Clock / LockPort 是可注入的（不读系统时钟）', async () => {
    expect(clock.now()).toBe('2026-10-30T22:00:00+08:00');
    const release = await lock.acquire('vault');
    await expect(release()).resolves.toBeUndefined();
  });
});

describe('契约：跨端 DTO 形状', () => {
  it('ReviewViewV1 包含 UI/CLI 需要的全部字段，且 actions 可驱动按钮', () => {
    const triage = decideTriage({ judgments: 6, charCount: 1200 });
    const view: ReviewViewV1 = {
      schemaVersion: REVIEW_VIEW_SCHEMA_VERSION,
      draftId: DRAFT_ID,
      title: '幂律分布与头部效应',
      rawPath: RAW_A,
      charCount: 336,
      tier: 'standard',
      state: 'in_review',
      findings: [makeFinding('r-inferred-claims', 'warn', 'INFERRED_CLAIMS', '1 条推断')],
      claims: [{ text: '判断', inference: false, source: RAW_A }],
      nodes: [{ name: '幂律分布', nodeType: 'concept', action: 'new', definition: '定义' }],
      actions: { accept: true, blockedBy: [] },
      provenance: { provider: 'mock', model: 'none', promptVersion: 1, inputTokens: null, latencyMs: null },
      createdAt: '2026-10-30T22:00:00+08:00',
    };
    expect(view.schemaVersion).toBe(1);
    expect(view.actions.accept).toBe(true);
    expect(view.findings[0]?.severity).toBe('warn');
    expect(triage.status).toBe('high');
    expect(JSON.parse(JSON.stringify(view))).toMatchObject({ schemaVersion: 1, tier: 'standard' });
  });

  it('QueueItemV1 允许 triage/draftId 为空（未加工条目）', () => {
    const item = {
      schemaVersion: QUEUE_ITEM_SCHEMA_VERSION,
      rawPath: RAW_A,
      title: 'a',
      state: 'queued',
      charCount: 100,
      triage: null,
      draftId: null,
    } as const;
    expect(item.schemaVersion).toBe(1);
    expect(item.triage).toBeNull();
  });
});
