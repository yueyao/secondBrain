import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArticleCitation, ArticleStatus, ArticleVersionRecord } from '@sb/contracts';
import { createHarness, hashPort, type TestHarness } from '@sb/testing';
import type { AppContext } from '../src/context';
import { createArticle } from '../src/compose';
import {
  articleExportFilename,
  exportArticleMarkdown,
  finalizeArticle,
  reopenArticle,
} from '../src/publish';

const NODES = ['反脆弱', '长期主义'] as const;
const BODY = '正文第一段：从波动中获益。\n\n正文第二段：让选择进入复利轨道。';
const DEFAULT_TITLE = '反脆弱与长期主义';
const DEFAULT_THEME = '写作';

function ctxOf(harness: TestHarness): AppContext {
  return {
    store: harness.store,
    vault: harness.vault,
    search: harness.search,
    agent: harness.agent,
    clock: harness.clock,
    ids: harness.ids,
    hash: hashPort,
    config: { longTextThreshold: 60_000, enabledSources: ['cubox', 'notions', 'podcast', 'dedao', 'general'] },
  };
}

/** 手工插入一个版本并设为当前版本（模拟 compose 生成后的版本链）。 */
async function appendVersion(
  ctx: AppContext,
  articleId: string,
  versionNo: number,
  contentMd: string,
  citations: readonly ArticleCitation[] = [],
): Promise<ArticleVersionRecord> {
  const now = ctx.clock.now();
  const record: ArticleVersionRecord = {
    id: `${articleId}-v${versionNo}`,
    articleId,
    versionNo,
    contentMd,
    citations,
    basedOnVersionId: versionNo === 1 ? null : `${articleId}-v${versionNo - 1}`,
    source: versionNo === 1 ? 'ai_initial' : 'ai_refine',
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
    await tx.articles.setCurrentVersion(articleId, record.id, now);
  });
  return record;
}

interface SeedOptions {
  readonly id?: string;
  readonly title?: string;
  readonly theme?: string;
  /** 不传表示"还没有正文"：不写版本、currentVersionId 保持 null。 */
  readonly version?: {
    readonly versionNo?: number;
    readonly contentMd?: string;
    readonly citations?: readonly ArticleCitation[];
  };
  readonly status?: ArticleStatus;
}

/** 建文章 +（可选）版本 +（可选）状态，返回文章 id。 */
async function seed(ctx: AppContext, options: SeedOptions = {}): Promise<string> {
  const id = options.id ?? 'article-publish-1';
  await createArticle(ctx, id, {
    title: options.title ?? DEFAULT_TITLE,
    theme: options.theme ?? DEFAULT_THEME,
    nodeIds: [...NODES],
  });
  if (options.version) {
    await appendVersion(
      ctx,
      id,
      options.version.versionNo ?? 1,
      options.version.contentMd ?? BODY,
      options.version.citations ?? [],
    );
  }
  const status = options.status;
  if (status !== undefined) {
    const now = ctx.clock.now();
    await ctx.store.transaction(async (tx) => tx.articles.setStatus(id, status, now));
  }
  return id;
}

async function eventsOf(ctx: AppContext) {
  return ctx.store.transaction(async (tx) => tx.events.listSince(0));
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('定稿与重新打开', () => {
  it('定稿：待主编审文章转为已定稿，并记录 article:finalized 事件', async () => {
    const ctx = ctxOf(harness);
    const id = await seed(ctx, { version: {}, status: 'review' });

    const article = await finalizeArticle(ctx, id);

    expect(article.id).toBe(id);
    expect(article.status).toBe('final');
    expect(article.currentVersionId).toBe(`${id}-v1`);
    const stored = await harness.store.transaction(async (tx) => tx.articles.get(id));
    expect(stored?.status).toBe('final');

    const events = await eventsOf(ctx);
    const finalized = events.find((event) => event.type === 'article:finalized');
    expect(finalized).toMatchObject({ aggregateId: id, payload: { versionNo: 1 } });
  });

  it('没有正文时不能定稿（INVALID_STATE）', async () => {
    const ctx = ctxOf(harness);
    const id = await seed(ctx);

    await expect(finalizeArticle(ctx, id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: '还没有正文，不能定稿',
    });

    const stored = await harness.store.transaction(async (tx) => tx.articles.get(id));
    expect(stored?.status).toBe('draft');
    const events = await eventsOf(ctx);
    expect(events.some((event) => event.type === 'article:finalized')).toBe(false);
  });

  it('重复定稿被拒（已是定稿状态）', async () => {
    const ctx = ctxOf(harness);
    const id = await seed(ctx, { version: {}, status: 'review' });
    await finalizeArticle(ctx, id);

    await expect(finalizeArticle(ctx, id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: '已经是定稿状态',
    });

    const stored = await harness.store.transaction(async (tx) => tx.articles.get(id));
    expect(stored?.status).toBe('final');
    // 状态与事件同事务：只记一次定稿
    const events = await eventsOf(ctx);
    expect(events.filter((event) => event.type === 'article:finalized')).toHaveLength(1);
  });

  it('重新打开：已定稿文章回到待主编审，并记录 article:reopened 事件', async () => {
    const ctx = ctxOf(harness);
    const id = await seed(ctx, { version: {}, status: 'final' });

    const article = await reopenArticle(ctx, id);

    expect(article.status).toBe('review');
    const stored = await harness.store.transaction(async (tx) => tx.articles.get(id));
    expect(stored?.status).toBe('review');
    expect(stored?.currentVersionId).toBe(`${id}-v1`);

    const events = await eventsOf(ctx);
    expect(events.some((event) => event.type === 'article:reopened' && event.aggregateId === id)).toBe(true);
  });

  it('非定稿文章不能重新打开（INVALID_STATE）', async () => {
    const ctx = ctxOf(harness);
    const draftId = await seed(ctx, { id: 'article-draft' });
    await expect(reopenArticle(ctx, draftId)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: '只有定稿文章可以重新打开',
    });

    const reviewId = await seed(ctx, { id: 'article-review', version: {}, status: 'review' });
    await expect(reopenArticle(ctx, reviewId)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('文章不存在时定稿 / 重新打开 / 导出都返回 NOT_FOUND', async () => {
    const ctx = ctxOf(harness);
    await expect(finalizeArticle(ctx, 'article-missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(reopenArticle(ctx, 'article-missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(exportArticleMarkdown(ctx, 'article-missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('Markdown 导出', () => {
  it('按当前版本导出：文件名、标题、主题、状态、正文与引用来源齐全', async () => {
    const ctx = ctxOf(harness);
    const citations: readonly ArticleCitation[] = [
      { source: 'raw/knowledge/cubox/a.md', text: '判断 A' },
      { source: 'raw/knowledge/cubox/b.md', text: '判断 B' },
      // 重复来源按顺序去重，只输出一次
      { source: 'raw/knowledge/cubox/a.md', text: '判断 A' },
    ];
    const id = await seed(ctx, { version: { versionNo: 1, contentMd: 'v1 旧正文' }, status: 'review' });
    await appendVersion(ctx, id, 2, 'v2 第一段：反脆弱。\n\nv2 第二段：长期主义。', citations);

    const result = await exportArticleMarkdown(ctx, id);

    expect(result.status).toBe('review');
    expect(result.versionNo).toBe(2);
    expect(result.filename).toBe(`${DEFAULT_TITLE}-v2.md`);
    expect(result.markdown).toBe(
      [
        `# ${DEFAULT_TITLE}`,
        '',
        `> 主题：${DEFAULT_THEME} · 状态：待主编审 · 版本 v2 · 导出时间 2026-10-30 23:00`,
        '',
        'v2 第一段：反脆弱。',
        '',
        'v2 第二段：长期主义。',
        '',
        '---',
        '',
        '## 引用来源',
        '',
        '- [[raw/knowledge/cubox/a.md]]',
        '- [[raw/knowledge/cubox/b.md]]',
        '',
      ].join('\n'),
    );
    // 重复来源只出现一次；旧版本正文不导出
    expect(result.markdown.split('raw/knowledge/cubox/a.md')).toHaveLength(2);
    expect(result.markdown).not.toContain('v1 旧正文');
  });

  it('没有正文时不能导出（INVALID_STATE）', async () => {
    const ctx = ctxOf(harness);
    const id = await seed(ctx);

    await expect(exportArticleMarkdown(ctx, id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: '还没有正文，无法导出',
    });
  });

  it('引用为空时导出省略「引用来源」章节；主题为空回退未设主题', async () => {
    const ctx = ctxOf(harness);
    const id = await seed(ctx, {
      theme: '',
      version: { versionNo: 2, contentMd: '正文内容' },
      status: 'final',
    });

    const result = await exportArticleMarkdown(ctx, id);

    expect(result.markdown).toBe(
      [
        `# ${DEFAULT_TITLE}`,
        '',
        `> 主题：未设主题 · 状态：已定稿 · 版本 v2 · 导出时间 2026-10-30 23:00`,
        '',
        '正文内容',
        '',
      ].join('\n'),
    );
    expect(result.markdown).not.toContain('引用来源');
    expect(result.markdown).not.toContain('---');
  });

  it('导出状态使用中文标签（草稿 / 待主编审 / 已定稿）', async () => {
    const ctx = ctxOf(harness);
    const cases: readonly (readonly [ArticleStatus, string])[] = [
      ['draft', '草稿'],
      ['review', '待主编审'],
      ['final', '已定稿'],
    ];
    for (const [status, label] of cases) {
      const id = await seed(ctx, { id: `article-status-${status}`, version: {}, status });
      const result = await exportArticleMarkdown(ctx, id);
      expect(result.markdown).toContain(`状态：${label} · 版本 v1`);
      expect(result.status).toBe(status);
    }
  });
});

describe('导出文件名清洗', () => {
  it('非法字符替换为 -，合并连续分隔符并去掉首尾 -', () => {
    expect(articleExportFilename(' 反脆弱 / 长期主义: 第1版? ', 3)).toBe('反脆弱-长期主义-第1版-v3.md');
    expect(articleExportFilename('a\\b|c"d<e>f*g?h', 1)).toBe('a-b-c-d-e-f-g-h-v1.md');
    expect(articleExportFilename('标题--副标题', 1)).toBe('标题-副标题-v1.md');
    expect(articleExportFilename('a - b', 1)).toBe('a-b-v1.md');
  });

  it('超长标题按码点截断到 60 字', () => {
    expect(articleExportFilename('知'.repeat(80), 7)).toBe(`${'知'.repeat(60)}-v7.md`);

    // 按码点而不是 UTF-16 单元截断：emoji 不会被截成半个代理对
    const emoji = articleExportFilename('😀'.repeat(70), 1);
    expect(emoji).toBe(`${'😀'.repeat(60)}-v1.md`);
    expect([...emoji].filter((char) => char === '😀')).toHaveLength(60);
  });

  it('空标题 / 全非法字符回退 article', () => {
    expect(articleExportFilename('', 1)).toBe('article-v1.md');
    expect(articleExportFilename('   ', 2)).toBe('article-v2.md');
    expect(articleExportFilename('***??|', 1)).toBe('article-v1.md');
  });
});
