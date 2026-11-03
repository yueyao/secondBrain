import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComposePort, ComposeRequest, ComposeResult } from '@sb/contracts';
import { createHarness, hashPort, type TestHarness } from '@sb/testing';
import type { AppContext } from '../src/context';
import {
  createArticle,
  generateArticleBody,
  generateArticleOutline,
  MAX_CLAIMS_PER_NODE,
  sampleClaimsForPrompt,
} from '../src/compose';

const NODES = ['反脆弱', '长期主义'] as const;

const PROVENANCE = {
  profileId: 'mock-profile',
  provider: 'mock',
  model: 'heuristic-v1',
  promptId: 'compose-body',
  promptVersion: 1,
  promptSha256: 'mock',
  inputTokens: 900,
  outputTokens: 500,
  latencyMs: 300,
  fallbackChain: [],
  cacheHit: false,
} as const;

const PARAGRAPH =
  '这是一段用于测试的主编台正文，说明知识库里的判断如何在文章中被复用，并标注来源以便回溯核对。';

function sourceOf(request: ComposeRequest): string {
  return request.nodes.flatMap((node) => node.claims.map((claim) => claim.source))[0] ?? 'raw/x.md';
}

/** 可编程假 Composer：默认返回合法大纲/正文，可按需覆盖。 */
function fakeComposer(overrides: {
  readonly outline?: () => ComposeResult;
  readonly body?: (request: ComposeRequest) => ComposeResult;
} = {}): ComposePort {
  return {
    async write(request: ComposeRequest): Promise<ComposeResult> {
      if (request.kind === 'outline') {
        return overrides.outline?.() ?? {
          text: `## 一、反脆弱的来源\n- 从波动中获益的判断${'，并说明其边界'.repeat(6)}\n## 二、长期主义\n- 让选择进入复利轨道${'，并说明其前提'.repeat(6)}`,
          citations: [],
          provenance: { ...PROVENANCE, promptId: 'compose-outline' },
          cost: 0.001,
        };
      }
      return overrides.body?.(request) ?? {
        text: [
          '## 一、导语',
          '',
          `${PARAGRAPH}${PARAGRAPH}`,
          `（来源：[[${sourceOf(request)}]]）`,
          '',
          '## 二、机制',
          '',
          `${PARAGRAPH}${PARAGRAPH}`,
          `（来源：[[${sourceOf(request)}]]）`,
          '',
          '## 三、结论',
          '',
          `${PARAGRAPH}${PARAGRAPH}`,
        ].join('\n'),
        citations: [],
        provenance: PROVENANCE,
        cost: 0.002,
      };
    },
  };
}

function ctxOf(harness: TestHarness, composer?: ComposePort): AppContext {
  return {
    store: harness.store,
    vault: harness.vault,
    search: harness.search,
    agent: harness.agent,
    ...(composer ? { composer } : {}),
    clock: harness.clock,
    ids: harness.ids,
    hash: hashPort,
    config: { longTextThreshold: 60_000, enabledSources: ['cubox', 'notions', 'podcast', 'dedao', 'general'] },
  };
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

async function createTestArticle(ctx: AppContext): Promise<string> {
  const article = await createArticle(ctx, 'article-test-1', {
    title: '反脆弱与长期主义', theme: '写作', nodeIds: [...NODES],
  });
  return article.id;
}

describe('主编台用例：大纲与正文版本链', () => {
  it('未配置 composer 时拒绝生成（MODEL_UNAVAILABLE）', async () => {
    const ctx = ctxOf(harness);
    await createTestArticle(ctx);
    await expect(generateArticleOutline(ctx, 'article-test-1')).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    await expect(generateArticleBody(ctx, 'article-test-1')).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('没有大纲时不能生成正文', async () => {
    const ctx = ctxOf(harness, fakeComposer());
    await createTestArticle(ctx);
    await expect(generateArticleBody(ctx, 'article-test-1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('AI 大纲落库并写事件', async () => {
    const ctx = ctxOf(harness, fakeComposer());
    await createTestArticle(ctx);
    const outline = await generateArticleOutline(ctx, 'article-test-1');
    expect(outline).toContain('反脆弱');
    const article = await harness.store.transaction(async (tx) => tx.articles.get('article-test-1'));
    expect(article?.outline).toBe(outline);
    const events = await harness.store.transaction(async (tx) => tx.events.listSince(0));
    expect(events.some((event) => event.type === 'article:outline_generated')).toBe(true);
  });

  it('生成正文 v1：引用可回溯、版本进入待主编审', async () => {
    const ctx = ctxOf(harness, fakeComposer());
    await createTestArticle(ctx);
    await generateArticleOutline(ctx, 'article-test-1');
    const version = await generateArticleBody(ctx, 'article-test-1');

    expect(version.versionNo).toBe(1);
    expect(version.source).toBe('ai_initial');
    expect(version.cost).toBe(0.002);
    expect(version.citations.length).toBeGreaterThan(0);
    expect(version.citations[0]?.source).toContain('raw/');
    // 引用记录补上了对应 claim 的判断句原文
    expect(version.citations[0]?.text.length).toBeGreaterThan(0);

    const article = await harness.store.transaction(async (tx) => tx.articles.get('article-test-1'));
    expect(article?.status).toBe('review');
    expect(article?.currentVersionId).toBe('article-test-1-v1');

    const events = await harness.store.transaction(async (tx) => tx.events.listSince(0));
    expect(events.some((event) => event.type === 'article:version_created')).toBe(true);
  });

  it('再次生成得到 v2（版本只增不改，ai_refine）', async () => {
    const ctx = ctxOf(harness, fakeComposer());
    await createTestArticle(ctx);
    await generateArticleOutline(ctx, 'article-test-1');
    await generateArticleBody(ctx, 'article-test-1');
    const v2 = await generateArticleBody(ctx, 'article-test-1');

    expect(v2.versionNo).toBe(2);
    expect(v2.source).toBe('ai_refine');
    expect(v2.basedOnVersionId).toBe('article-test-1-v1');
    const versions = await harness.store.transaction(async (tx) => tx.articleVersions.listByArticle('article-test-1'));
    expect(versions.map((entry) => entry.versionNo)).toEqual([2, 1]);
  });

  it('正文没有来源引用时不落库', async () => {
    const noCitations = fakeComposer({
      body: () => ({
        text: `${PARAGRAPH}${PARAGRAPH}${PARAGRAPH}${PARAGRAPH}${PARAGRAPH}${PARAGRAPH}`,
        citations: [],
        provenance: PROVENANCE,
        cost: 0.002,
      }),
    });
    const ctx = ctxOf(harness, noCitations);
    await createTestArticle(ctx);
    await generateArticleOutline(ctx, 'article-test-1');
    await expect(generateArticleBody(ctx, 'article-test-1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const versions = await harness.store.transaction(async (tx) => tx.articleVersions.listByArticle('article-test-1'));
    expect(versions).toHaveLength(0);
  });
});

describe('生成材料抽样（控制 prompt 与成本）', () => {
  it('不超过上限时原样返回', () => {
    const claims = Array.from({ length: 10 }, (_, index) => ({ text: `判断 ${index}`, source: `raw/k/${index}.md` }));
    expect(sampleClaimsForPrompt(claims)).toEqual(claims);
  });

  it('超过上限时等距抽样：保留首条与尾部代表，条数不超过上限', () => {
    const claims = Array.from({ length: 100 }, (_, index) => ({ text: `判断 ${index}`, source: `raw/k/${index}.md` }));
    const sampled = sampleClaimsForPrompt(claims);
    expect(sampled).toHaveLength(MAX_CLAIMS_PER_NODE);
    expect(sampled[0]?.text).toBe('判断 0');
    expect(sampled[sampled.length - 1]?.text).toBe('判断 98');
    // 抽样不改变时间顺序
    const indexes = sampled.map((claim) => Number(claim.text.replace('判断 ', '')));
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });

  it('重复文本只保留一条', () => {
    const claims = Array.from({ length: 100 }, (_, index) => ({ text: '同一判断', source: `raw/k/${index}.md` }));
    expect(sampleClaimsForPrompt(claims)).toHaveLength(1);
  });
});
