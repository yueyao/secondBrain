import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ArticleCitation,
  ArticleStatus,
  ArticleVersionRecord,
  DeAiPort,
  DeAiRequest,
  DeAiResult,
} from '@sb/contracts';
import { extractCitationSources } from '@sb/domain';
import { createHarness, FIXED_NOW, hashPort, MockDeAi, type TestHarness } from '@sb/testing';
import type { AppContext } from '../src/context';
import { createArticle } from '../src/compose';
import { deAiArticleVersion, deAiLengthTarget, deAiText } from '../src/deai';

const CITATION_A = 'raw/knowledge/cubox/a.md';
const CITATION_B = 'raw/knowledge/cubox/b.md';

/** 一段 AI 味明显的正文：框架路标词 + 黑话 + 两条独立引用。 */
const AI_TEXT = [
  '首先，我们需要打造一个从想法到落地的闭环，赋能一线团队。',
  '其次，底层逻辑至关重要，构建统一抓手才能助力协作。',
  '此外，值得注意的是，极致体验不可或缺，深入探讨之后还要形成闭环。',
  '最后，综上所述，我们打造的方案由此可见有效，不难发现它的价值。',
  '与此同时，换句话说，众所周知，不可否认，再者，归根结底，这些判断都要落回具体动作。',
  '这些判断来自实际项目复盘。（来源：[[raw/knowledge/cubox/a.md]]）',
  '另一条依据见团队访谈记录。（来源：[[raw/knowledge/cubox/b.md]]）',
].join('');

const DEFAULT_CITATIONS: readonly ArticleCitation[] = [
  { source: CITATION_A, text: '判断 A：反脆弱不是坚强，而是从波动中获益。' },
  { source: CITATION_B, text: '判断 B：长期主义不是坚持得久，而是让选择进入复利轨道。' },
];

const charCount = (text: string): number => [...text].length;

function ctxOf(harness: TestHarness, deAi: DeAiPort | null = new MockDeAi()): AppContext {
  const base: AppContext = {
    store: harness.store,
    vault: harness.vault,
    search: harness.search,
    agent: harness.agent,
    clock: harness.clock,
    ids: harness.ids,
    hash: hashPort,
    config: { longTextThreshold: 60_000, enabledSources: ['cubox', 'notions', 'podcast', 'dedao', 'general'] },
  };
  return deAi === null ? base : { ...base, deAi };
}

interface SeedOptions {
  readonly id?: string;
  readonly status?: ArticleStatus;
  /** 不传表示"还没有正文"：只建文章，currentVersionId 保持 null。 */
  readonly content?: string;
  readonly citations?: readonly ArticleCitation[];
}

/** 建文章 + v1 当前版本 +（可选）状态，返回文章 id。 */
async function seedArticle(ctx: AppContext, options: SeedOptions = {}): Promise<string> {
  const id = options.id ?? 'article-deai-1';
  await createArticle(ctx, id, { title: '反脆弱与长期主义', theme: '写作', nodeIds: ['反脆弱'] });
  if (options.content !== undefined) {
    const now = ctx.clock.now();
    const record: ArticleVersionRecord = {
      id: `${id}-v1`,
      articleId: id,
      versionNo: 1,
      contentMd: options.content,
      citations: options.citations ?? DEFAULT_CITATIONS,
      basedOnVersionId: null,
      source: 'ai_initial',
      instruction: null,
      provider: 'mock',
      model: 'heuristic-v1',
      promptVersion: 1,
      inputTokens: 900,
      outputTokens: 500,
      cost: 0.002,
      note: null,
      createdAt: now,
    };
    await ctx.store.transaction(async (tx) => {
      await tx.articleVersions.append(record);
      await tx.articles.setCurrentVersion(id, record.id, now);
    });
  }
  if (options.status !== undefined) {
    await ctx.store.transaction(async (tx) => tx.articles.setStatus(id, options.status as ArticleStatus, ctx.clock.now()));
  }
  return id;
}

/** 故意丢掉引用标记的假端口：用来验证应用层的引用覆盖校验。 */
class CitationStrippingDeAi implements DeAiPort {
  private readonly inner = new MockDeAi();

  async humanize(request: DeAiRequest): Promise<DeAiResult> {
    const result = await this.inner.humanize(request);
    return { ...result, text: result.text.replace(/（来源：\[\[raw\/[^\]]+\]\]）/gu, '') };
  }
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('deAiText：文本改写用例', () => {
  it('正文过短或过长时拒绝改写（INVALID_STATE，提示长度）', async () => {
    const ctx = ctxOf(harness);
    await expect(deAiText(ctx, { text: '太短了，不够 80 字。' })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await expect(deAiText(ctx, { text: '太短了，不够 80 字。' })).rejects.toThrow(/正文长度/u);
    await expect(deAiText(ctx, { text: '字'.repeat(20_001) })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('没有配置 deAi 端口时拒绝（MODEL_UNAVAILABLE）', async () => {
    const ctx = ctxOf(harness, null);
    await expect(deAiText(ctx, { text: AI_TEXT })).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
      message: '未配置模型生成能力',
    });
  });

  it('正常改写：返回前后体检报告，且 AI 味分数不上升', async () => {
    const ctx = ctxOf(harness);
    const result = await deAiText(ctx, { text: AI_TEXT, title: '反脆弱与长期主义' });

    expect(result.original).toBe(AI_TEXT);
    expect(result.rewritten.length).toBeGreaterThan(0);
    // 用 AI 味明显的文本，改写前应当命中规则
    expect(result.before.score).toBeGreaterThan(0);
    expect(result.after.score).toBeLessThanOrEqual(result.before.score);
    expect(result.before.findings.length).toBeGreaterThan(0);
    // 结果长度在应用层防御区间内（原文 0.5~2 倍）
    expect(charCount(result.rewritten)).toBeGreaterThanOrEqual(Math.floor(charCount(AI_TEXT) * 0.5));
    expect(charCount(result.rewritten)).toBeLessThanOrEqual(Math.ceil(charCount(AI_TEXT) * 2));
    expect(result.cost).toBe(0);
    expect(result.provenance).toMatchObject({
      profileId: 'mock-profile',
      provider: 'mock',
      model: 'heuristic-v1',
      promptId: 'deai',
      promptVersion: 1,
      cacheHit: false,
    });
  });

  it('引用保留：改写后原文的引用来源一个都不少', async () => {
    const ctx = ctxOf(harness);
    const result = await deAiText(ctx, { text: AI_TEXT });

    expect(extractCitationSources(result.rewritten)).toEqual([CITATION_A, CITATION_B]);
    expect(result.rewritten).toContain(`（来源：[[${CITATION_A}]]）`);
    expect(result.rewritten).toContain(`（来源：[[${CITATION_B}]]）`);
  });

  it('改写结果丢失引用来源时拒收（INVALID_STATE）', async () => {
    const ctx = ctxOf(harness, new CitationStrippingDeAi());
    await expect(deAiText(ctx, { text: AI_TEXT })).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: '改写结果丢失了引用来源',
    });
  });
});

describe('deAiArticleVersion：文章去 AI 味版本', () => {
  it('生成 v2：source=deai、basedOn 指向 v1、note 记录前后分数', async () => {
    const ctx = ctxOf(harness);
    const id = await seedArticle(ctx, { content: AI_TEXT, status: 'review' });
    const before = await ctx.store.transaction(async (tx) => tx.articles.get(id));

    const version = await deAiArticleVersion(ctx, id);

    expect(version.versionNo).toBe(2);
    expect(version.id).toBe(`${id}-v2`);
    expect(version.articleId).toBe(id);
    expect(version.source).toBe('deai');
    expect(version.basedOnVersionId).toBe(`${id}-v1`);
    expect(version.instruction).toBeNull();
    expect(version.note).toMatch(/^去 AI 味：AI 味分 \d+ → \d+$/u);
    expect(version.provider).toBe('mock');
    expect(version.model).toBe('heuristic-v1');
    expect(version.promptVersion).toBe(1);
    expect(version.inputTokens).toBeGreaterThan(0);
    expect(version.outputTokens).toBeGreaterThan(0);
    expect(version.cost).toBe(0);
    // 引用记录：来源取改写结果，判断句沿用原版本
    expect(version.citations).toEqual(DEFAULT_CITATIONS);
    expect(version.createdAt).toBe(FIXED_NOW);

    const stored = await ctx.store.transaction(async (tx) => tx.articles.get(id));
    expect(stored?.currentVersionId).toBe(`${id}-v2`);
    expect(stored?.status).toBe('review');
    expect(before?.currentVersionId).toBe(`${id}-v1`);
  });

  it('版本只增不改：旧版本保留，事件记录 source 与前后分数', async () => {
    const ctx = ctxOf(harness);
    const id = await seedArticle(ctx, { content: AI_TEXT, status: 'review' });
    await deAiArticleVersion(ctx, id);

    const versions = await ctx.store.transaction(async (tx) => tx.articleVersions.listByArticle(id));
    // 版本链按版本号倒序（最新在前），旧版本只读保留
    expect(versions.map((version) => version.versionNo)).toEqual([2, 1]);
    expect(versions[1]?.contentMd).toBe(AI_TEXT);

    const events = await ctx.store.transaction(async (tx) => tx.events.listSince(0));
    const created = events.find(
      (event) => event.type === 'article:version_created' && event.payload.versionNo === 2,
    );
    expect(created?.aggregateId).toBe(id);
    expect(created?.payload).toMatchObject({
      versionNo: 2,
      source: 'deai',
      scoreBefore: expect.any(Number) as number,
      scoreAfter: expect.any(Number) as number,
    });
  });

  it('没有正文时拒绝改写（INVALID_STATE）；文章不存在时 NOT_FOUND', async () => {
    const ctx = ctxOf(harness);
    const id = await seedArticle(ctx);
    await expect(deAiArticleVersion(ctx, id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: '当前还没有正文，先生成 v1',
    });
    await expect(deAiArticleVersion(ctx, 'article-missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('已定稿文章改写后回到待主编审（review）', async () => {
    const ctx = ctxOf(harness);
    const id = await seedArticle(ctx, { content: AI_TEXT, status: 'final' });

    await deAiArticleVersion(ctx, id);

    const stored = await ctx.store.transaction(async (tx) => tx.articles.get(id));
    expect(stored?.status).toBe('review');
  });
});

describe('改写目标长度策略（按 AI 味分数自适应）', () => {
  it('重度 AI 味允许更深压缩，轻/中度逐级收紧', () => {
    expect(deAiLengthTarget(139, 68)).toEqual({ minChars: 62, maxChars: 195 });
    expect(deAiLengthTarget(139, 45)).toEqual({ minChars: 83, maxChars: 195 });
    expect(deAiLengthTarget(139, 10)).toEqual({ minChars: 104, maxChars: 195 });
  });

  it('短文本也给出合理区间（至少 1 字）', () => {
    expect(deAiLengthTarget(2, 90).minChars).toBe(1);
    expect(deAiLengthTarget(2, 90).maxChars).toBe(3);
  });
});

/** 第一次原样返回（分数不降），第二次才真正清洗：用于验证应用层质量重试。 */
class RetryingDeAi implements DeAiPort {
  private readonly inner = new MockDeAi();
  calls = 0;

  async humanize(request: DeAiRequest): Promise<DeAiResult> {
    this.calls += 1;
    const base = await this.inner.humanize(request);
    if (this.calls === 1) return { ...base, text: request.text };
    const text = request.text
      .replace(/首先|其次|此外|最后|综上所述|值得注意的是|与此同时|换句话说|众所周知|不可否认|再者|归根结底/gu, '')
      .replace(/打造|赋能|抓手|闭环|底层逻辑|助力|极致|深入探讨|不可或缺/g, '');
    return { ...base, text };
  }
}

/** 两次都原样返回：验证"重试一次仍不改善时保留第一次结果、不无限重试"。 */
class AlwaysSameDeAi implements DeAiPort {
  private readonly inner = new MockDeAi();
  calls = 0;

  async humanize(request: DeAiRequest): Promise<DeAiResult> {
    this.calls += 1;
    const base = await this.inner.humanize(request);
    return { ...base, text: request.text };
  }
}

describe('改写质量门（未降低 AI 味时自动重试一次）', () => {
  it('第一版分数不降 → 更彻底地重写一次并采用更低分结果', async () => {
    const port = new RetryingDeAi();
    const result = await deAiText(ctxOf(harness, port), { text: AI_TEXT, style: 'auto' });

    expect(port.calls).toBe(2);
    expect(result.after.score).toBeLessThan(result.before.score);
    expect(result.rewritten).not.toBe(result.original);
  });

  it('重试仍不改善 → 最多调用两次并保留第一次结果', async () => {
    const port = new AlwaysSameDeAi();
    const result = await deAiText(ctxOf(harness, port), { text: AI_TEXT, style: 'auto' });

    expect(port.calls).toBe(2);
    expect(result.rewritten).toBe(result.original);
    expect(result.after.score).toBe(result.before.score);
  });
});
