import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArticleCitation, ArticleVersionRecord } from '@sb/contracts';
import { stringifyFrontmatter } from '@sb/domain';
import { FIXED_NOW, MockQa, createHarness, hashPort, type TestHarness } from '@sb/testing';
import type { AppContext } from '../src/context';
import { createArticle } from '../src/compose';
import { qaArticle, qaTopic } from '../src/qa';

const RAW_A = 'raw/knowledge/cubox/mock-legacy.md';

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

async function writeTopic(harness: TestHarness, name: string, claims: number): Promise<void> {
  const body = [
    `# ${name}`,
    '',
    '## 一句话定义',
    '',
    `${name}的一句话定义。`,
    '',
    '## 核心判断',
    '',
    ...Array.from({ length: claims }, (_, index) => `- ${name}的第 ${index + 1} 条判断。（来源：[[raw/knowledge/cubox/mock-legacy.md]]）`),
    '',
    '## 来源',
    '',
    '- [[raw/knowledge/cubox/mock-legacy.md]]',
    '',
  ].join('\n');
  await harness.vault.writeNode(`wiki/topics/${name}.md`, stringifyFrontmatter(
    { type: 'node', node_type: 'topic', name, aliases: [], review_status: 'active', updated_at: '2026-10-31', confirmed: true, tags: ['layer/wiki', 'node/topic'] },
    body,
  ));
  await harness.search.refresh();
}

async function seedArticleWithBody(ctx: AppContext, id: string, content: string, citations: readonly ArticleCitation[]): Promise<void> {
  await createArticle(ctx, id, { title: '问答链测试文章', theme: '测试', nodeIds: ['反脆弱'] });
  const version: ArticleVersionRecord = {
    id: `${id}-v1`,
    articleId: id,
    versionNo: 1,
    contentMd: content,
    citations,
    basedOnVersionId: null,
    source: 'ai_initial',
    instruction: null,
    provider: 'deepseek',
    model: 'deepseek-flash',
    promptVersion: 1,
    inputTokens: 100,
    outputTokens: 50,
    cost: 0.001,
    note: null,
    createdAt: FIXED_NOW,
  };
  await ctx.store.transaction(async (tx) => {
    await tx.articleVersions.append(version);
    await tx.articles.setCurrentVersion(id, version.id, FIXED_NOW);
  });
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('问答链（基于 QaPort）', () => {
  it('从主题 claims 生成指定数量的 Q-A 链，每问含四段', async () => {
    await writeTopic(harness, '测试主题', 3);
    const chain = await qaTopic(ctxOf(harness), new MockQa(), '测试主题', { count: 4 });

    expect(chain.sourceKind).toBe('topic');
    expect(chain.sourceId).toBe('测试主题');
    expect(chain.questionCount).toBe(4);
    expect(chain.materialClaims).toBe(3);
    expect(chain.markdown).toContain('### Q1.');
    expect(chain.markdown).toContain('### Q4.');
    for (const field of ['结论', '形式化', '论证步', '边界']) {
      expect(chain.markdown).toContain(`**${field}**`);
    }
    expect(chain.provenance.profileId).toBe('mock-profile');
    expect(chain.provenance.promptId).toBe('qa');
    expect(chain.cost).toBe(0);
  });

  it('从文章正文生成问答链（默认 6 问）', async () => {
    const ctx = ctxOf(harness);
    await seedArticleWithBody(
      ctx,
      'article-qa-1',
      ['## 一、判断', '', `反脆弱不是坚强，而是从波动中获益。（来源：[[${RAW_A}]]）`, '', '## 二、边界', '', `在极端冲击下会失效。（来源：[[${RAW_A}]]）`].join('\n'),
      [{ text: '反脆弱不是坚强，而是从波动中获益。', source: RAW_A }],
    );

    const chain = await qaArticle(ctx, new MockQa(), 'article-qa-1');
    expect(chain.sourceKind).toBe('article');
    expect(chain.sourceTitle).toBe('问答链测试文章');
    expect(chain.questionCount).toBe(6);
    expect(chain.markdown).toContain('### Q6.');
  });

  it('问题数量被限制在 3–10，聚焦要求不改变输出契约', async () => {
    await writeTopic(harness, '测试主题', 2);
    const chain = await qaTopic(ctxOf(harness), new MockQa(), '测试主题', { count: 99, focus: '只问代价和边界' });
    expect(chain.questionCount).toBe(10);
  });

  it('未知主题或没有正文的文章会给出明确错误', async () => {
    await expect(qaTopic(ctxOf(harness), new MockQa(), '不存在的主题')).rejects.toThrow('节点不存在');
    const ctx = ctxOf(harness);
    await createArticle(ctx, 'article-qa-empty', { title: '空文章', theme: '', nodeIds: ['反脆弱'] });
    await expect(qaArticle(ctx, new MockQa(), 'article-qa-empty')).rejects.toThrow('还没有正文');
    await expect(qaArticle(ctx, new MockQa(), '不存在的文章')).rejects.toThrow('文章不存在');
  });
});
