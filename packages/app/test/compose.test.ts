import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArticleVersionRecord, ComposePort, ComposeRequest, ComposeResult } from '@sb/contracts';
import { createHarness, hashPort, type TestHarness } from '@sb/testing';
import type { AppContext } from '../src/context';
import {
  composeArticleDiff,
  composeArticleView,
  createArticle,
  generateArticleBody,
  generateArticleOutline,
  MAX_CLAIMS_PER_NODE,
  refineArticle,
  restoreArticleVersion,
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

/** 造一篇有 v1 正文的文章；返回 v1 记录（含 articleId）。 */
async function articleWithBody(ctx: AppContext): Promise<ArticleVersionRecord> {
  await createTestArticle(ctx);
  await generateArticleOutline(ctx, 'article-test-1');
  return generateArticleBody(ctx, 'article-test-1');
}

/** 改稿用正文：≥300 字、含 1 条引用，便于和 v1 对比。 */
const REFINED_PARAGRAPH = '改写后的正文段落，强调语气更克制，并把结论提前，方便主编快速核对判断与来源。';
const REFINED_BODY = [
  '# 反脆弱与长期主义',
  '',
  '## 一、导语',
  '',
  REFINED_PARAGRAPH.repeat(8),
  '',
  '（来源：[[raw/refined.md]]）',
  '',
  '## 二、结论',
  '',
  REFINED_PARAGRAPH.repeat(4),
].join('\n');

/** 只关心正文内容的 Composer：用于制造与 v1 不同的改稿结果。 */
function bodyOnlyComposer(text: string, cost = 0.001): ComposePort {
  return {
    async write(): Promise<ComposeResult> {
      return { text, citations: [], provenance: PROVENANCE, cost };
    },
  };
}

/** 手工造一条版本记录（版本对比用例只需要算 diff，不必真的调模型）。 */
function versionRecord(
  at: string,
  input: {
    readonly id: string;
    readonly articleId: string;
    readonly versionNo: number;
    readonly contentMd: string;
    readonly source?: ArticleVersionRecord['source'];
    readonly instruction?: string | null;
    readonly note?: string | null;
  },
): ArticleVersionRecord {
  return {
    id: input.id,
    articleId: input.articleId,
    versionNo: input.versionNo,
    contentMd: input.contentMd,
    citations: [],
    basedOnVersionId: null,
    source: input.source ?? 'ai_initial',
    instruction: input.instruction ?? null,
    provider: null,
    model: null,
    promptVersion: null,
    inputTokens: null,
    outputTokens: null,
    cost: null,
    note: input.note ?? null,
    createdAt: at,
  };
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

describe('主编台 C3：改稿、恢复与版本对比', () => {
  it('按指令改稿生成 v2：source、instruction 与 basedOn 正确', async () => {
    const sent: (string | null)[] = [];
    const inner = fakeComposer();
    const recording: ComposePort = {
      async write(request: ComposeRequest): Promise<ComposeResult> {
        if (request.kind === 'body') sent.push(request.instruction);
        return inner.write(request);
      },
    };
    const ctx = ctxOf(harness, recording);
    const v1 = await articleWithBody(ctx);
    const version = await refineArticle(ctx, 'article-test-1', '  把结论提前，语气更克制  ');

    expect(version.versionNo).toBe(2);
    expect(version.source).toBe('ai_refine');
    expect(version.instruction).toBe('把结论提前，语气更克制');
    expect(version.basedOnVersionId).toBe(v1.id);
    expect(version.provider).toBe('mock');
    expect(version.model).toBe('heuristic-v1');
    expect(version.promptVersion).toBe(1);
    expect(version.cost).toBe(0.002);
    expect(version.citations.length).toBeGreaterThan(0);
    // 指令去空白后透传给模型端口
    expect(sent.at(-1)).toBe('把结论提前，语气更克制');

    const article = await harness.store.transaction(async (tx) => tx.articles.get('article-test-1'));
    expect(article?.currentVersionId).toBe('article-test-1-v2');
    expect(article?.status).toBe('review');
    const versions = await harness.store.transaction(async (tx) => tx.articleVersions.listByArticle('article-test-1'));
    expect(versions.map((entry) => entry.versionNo)).toEqual([2, 1]);
    const events = await harness.store.transaction(async (tx) => tx.events.listSince(0));
    const created = events.filter((event) => event.type === 'article:version_created' && event.payload.versionNo === 2);
    expect(created).toHaveLength(1);
    expect(created[0]?.payload.source).toBe('ai_refine');
    expect(created[0]?.payload.instruction).toBe('把结论提前，语气更克制');
  });

  it('改稿指令少于 4 个字时拒绝，且不落库', async () => {
    const ctx = ctxOf(harness, fakeComposer());
    await articleWithBody(ctx);
    await expect(refineArticle(ctx, 'article-test-1', ' 再写 ')).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: '改稿指令至少 4 个字',
    });
    const versions = await harness.store.transaction(async (tx) => tx.articleVersions.listByArticle('article-test-1'));
    expect(versions).toHaveLength(1);
  });

  it('还没有正文时不能改稿（先生成 v1）', async () => {
    const ctx = ctxOf(harness, fakeComposer());
    await createTestArticle(ctx);
    await expect(refineArticle(ctx, 'article-test-1', '把结论提前，语气更克制')).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: '当前还没有正文，先生成 v1',
    });
  });

  it('已定稿文章改稿后回到待主编审（review）', async () => {
    const ctx = ctxOf(harness, fakeComposer());
    const v1 = await articleWithBody(ctx);
    expect(v1.source).toBe('ai_initial');
    await harness.store.transaction(async (tx) => tx.articles.setStatus('article-test-1', 'final', harness.clock.now()));

    const version = await refineArticle(ctx, 'article-test-1', '把结论提前，语气更克制');
    expect(version.versionNo).toBe(2);
    const article = await harness.store.transaction(async (tx) => tx.articles.get('article-test-1'));
    expect(article?.status).toBe('review');
  });

  it('恢复旧版本：生成新版本、内容等于目标、note 记录来源', async () => {
    const ctx = ctxOf(harness, fakeComposer());
    const v1 = await articleWithBody(ctx);
    const refineCtx = ctxOf(harness, bodyOnlyComposer(REFINED_BODY));
    const v2 = await refineArticle(refineCtx, 'article-test-1', '把结论提前，语气更克制');
    expect(v2.contentMd).toBe(REFINED_BODY);

    const restored = await restoreArticleVersion(ctx, 'article-test-1', v1.id);
    expect(restored.versionNo).toBe(3);
    expect(restored.source).toBe('restore');
    expect(restored.contentMd).toBe(v1.contentMd);
    expect(restored.citations).toEqual(v1.citations);
    expect(restored.basedOnVersionId).toBe(v2.id);
    expect(restored.note).toBe('恢复自 v1');
    expect(restored.instruction).toBeNull();
    // 恢复没有调用模型，模型/tokens/成本全部置空
    expect(restored.provider).toBeNull();
    expect(restored.model).toBeNull();
    expect(restored.promptVersion).toBeNull();
    expect(restored.inputTokens).toBeNull();
    expect(restored.outputTokens).toBeNull();
    expect(restored.cost).toBeNull();

    const article = await harness.store.transaction(async (tx) => tx.articles.get('article-test-1'));
    expect(article?.currentVersionId).toBe('article-test-1-v3');
    expect(article?.status).toBe('review');
    const events = await harness.store.transaction(async (tx) => tx.events.listSince(0));
    const restoredEvent = events.find(
      (event) => event.type === 'article:version_created' && event.payload.restoredFrom === 1,
    );
    expect(restoredEvent?.payload.versionNo).toBe(3);
    expect(restoredEvent?.payload.source).toBe('restore');
  });

  it('恢复当前版本被拒绝', async () => {
    const ctx = ctxOf(harness, fakeComposer());
    const v1 = await articleWithBody(ctx);
    await expect(restoreArticleVersion(ctx, 'article-test-1', v1.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: '已经是当前版本',
    });
    const versions = await harness.store.transaction(async (tx) => tx.articleVersions.listByArticle('article-test-1'));
    expect(versions).toHaveLength(1);
  });

  it('恢复不存在或不属于该文章的版本返回 NOT_FOUND', async () => {
    const ctx = ctxOf(harness, fakeComposer());
    const v1 = await articleWithBody(ctx);
    await expect(restoreArticleVersion(ctx, 'article-test-1', 'article-test-1-v99')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const at = harness.clock.now();
    await createArticle(ctx, 'article-other-1', { title: '另一篇文章', theme: '写作', nodeIds: ['反脆弱'] });
    await harness.store.transaction(async (tx) => {
      await tx.articleVersions.append(versionRecord(at, {
        id: 'article-other-1-v1', articleId: 'article-other-1', versionNo: 1, contentMd: '另一篇文章的正文',
      }));
    });
    await expect(restoreArticleVersion(ctx, v1.articleId, 'article-other-1-v1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('版本对比：新增/删除行与统计正确', async () => {
    const ctx = ctxOf(harness);
    await createTestArticle(ctx);
    const at = harness.clock.now();
    await harness.store.transaction(async (tx) => {
      await tx.articleVersions.append(versionRecord(at, {
        id: 'article-test-1-v1', articleId: 'article-test-1', versionNo: 1,
        contentMd: '第一段\n第二段\n第三段',
      }));
      await tx.articleVersions.append(versionRecord(at, {
        id: 'article-test-1-v2', articleId: 'article-test-1', versionNo: 2,
        contentMd: '第一段\n新增行\n第三段', source: 'ai_refine', instruction: '调整结构',
      }));
      await tx.articles.setCurrentVersion('article-test-1', 'article-test-1-v2', at);
      await tx.articles.setStatus('article-test-1', 'review', at);
    });

    const diff = await composeArticleDiff(ctx, 'article-test-1', 'article-test-1-v1', 'article-test-1-v2');
    expect(diff).not.toBeNull();
    expect(diff?.articleId).toBe('article-test-1');
    expect(diff?.title).toBe('反脆弱与长期主义');
    expect(diff?.from).toMatchObject({ id: 'article-test-1-v1', versionNo: 1, source: 'ai_initial', createdAt: at });
    expect(diff?.to).toMatchObject({ id: 'article-test-1-v2', versionNo: 2, source: 'ai_refine', createdAt: at });
    expect(diff?.lines.map((line) => [line.kind, line.text])).toEqual([
      ['same', '第一段'],
      ['del', '第二段'],
      ['add', '新增行'],
      ['same', '第三段'],
    ]);
    expect(diff?.stats).toEqual({ added: 1, removed: 1, same: 2 });
  });

  it('文章或版本不存在时版本对比返回 null', async () => {
    const ctx = ctxOf(harness);
    await createTestArticle(ctx);
    expect(await composeArticleDiff(ctx, 'article-missing', 'a', 'b')).toBeNull();
    expect(await composeArticleDiff(ctx, 'article-test-1', 'article-test-1-v1', 'article-test-1-v2')).toBeNull();
  });

  it('文章视图的版本列表带改稿指令与恢复备注', async () => {
    const ctx = ctxOf(harness, fakeComposer());
    const v1 = await articleWithBody(ctx);
    const refineCtx = ctxOf(harness, bodyOnlyComposer(REFINED_BODY));
    await refineArticle(refineCtx, 'article-test-1', '把结论提前，语气更克制');
    await restoreArticleVersion(ctx, 'article-test-1', v1.id);

    const view = await composeArticleView(ctx, 'article-test-1');
    expect(view).not.toBeNull();
    expect(view?.versions.map((entry) => entry.versionNo)).toEqual([3, 2, 1]);
    expect(view?.versions[0]?.note).toBe('恢复自 v1');
    expect(view?.versions[0]?.instruction).toBeNull();
    expect(view?.versions[1]?.instruction).toBe('把结论提前，语气更克制');
    expect(view?.versions[1]?.note).toBeNull();
    expect(view?.versions[2]?.instruction).toBeNull();
    // current 字段维持不变：指向新的当前版本
    expect(view?.current?.versionNo).toBe(3);
    expect(view?.current?.contentMd).toBe(v1.contentMd);
  });
});
