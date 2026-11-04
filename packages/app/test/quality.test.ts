import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArticleCitation, ArticleVersionRecord } from '@sb/contracts';
import { FIXED_NOW, createHarness, hashPort, type TestHarness } from '@sb/testing';
import type { AppContext } from '../src/context';
import { createArticle } from '../src/compose';
import { auditArticleCitations, evaluateWritingContract } from '../src/quality';

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

const GOOD_TEXT = [
  '## 一、问题',
  '',
  '2024 年我们做过一次复盘：12 个团队里只有 3 个把流程跑通。问题不在执行力，而在条件没有交代清楚。',
  '',
  '## 二、机制',
  '',
  '当一个决定依赖多个变量时，只看结果会误判因果；因为条件变了，同样的动作会得到不同结果。（来源：[[raw/knowledge/cubox/mock-legacy.md]]）',
  '',
  '## 三、边界与反例',
  '',
  '这个判断在资源充足时不成立，它是一个反例；一旦超过 60% 的负载，机制就会失效。（来源：[[raw/knowledge/cubox/mock-legacy.md]]）',
  '',
  '所以真正该做的是先把前提写下来，再决定要不要行动。',
].join('\n');

async function seedArticle(
  ctx: AppContext,
  options: {
    readonly id: string;
    readonly nodeIds: readonly string[];
    readonly content: string;
    readonly citations: readonly ArticleCitation[];
  },
): Promise<void> {
  await createArticle(ctx, options.id, { title: '质量检查测试文章', theme: '测试', nodeIds: options.nodeIds });
  const version: ArticleVersionRecord = {
    id: `${options.id}-v1`,
    articleId: options.id,
    versionNo: 1,
    contentMd: options.content,
    citations: options.citations,
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
    await tx.articles.setCurrentVersion(options.id, version.id, FIXED_NOW);
  });
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('写作契约检查', () => {
  it('合格样文：引用/结构/边界/机制/句长/具体信息全部通过，无 fail', () => {
    const report = evaluateWritingContract(GOOD_TEXT);
    expect(report.failCount).toBe(0);
    expect(report.checks.find((item) => item.id === 'citations')?.status).toBe('pass');
    expect(report.checks.find((item) => item.id === 'structure')?.status).toBe('pass');
    expect(report.checks.find((item) => item.id === 'boundary')?.status).toBe('pass');
  });

  it('没有引用直接 fail', () => {
    const report = evaluateWritingContract(`## 一、导语\n\n${'这是一段没有任何引用的文字。'.repeat(20)}\n\n## 二、结尾\n\n结束。`);
    expect(report.checks.find((item) => item.id === 'citations')?.status).toBe('fail');
    expect(report.failCount).toBeGreaterThanOrEqual(1);
  });

  it('"不是…而是…" 使用过多会 fail', () => {
    const text = [
      '## 一、转折',
      '',
      '这不是效率问题，而是结构问题。（来源：[[raw/a.md]]）',
      '这不是方法问题，而是条件问题。（来源：[[raw/a.md]]）',
      '这不是执行问题，而是判断问题。（来源：[[raw/b.md]]）',
      '这不是能力问题，而是意愿问题。（来源：[[raw/b.md]]）',
      '这不是个人问题，而是系统问题。（来源：[[raw/c.md]]）',
      '',
      '## 二、说明',
      '',
      '继续解释。',
      '',
      '## 三、边界',
      '',
      '存在反例与边界。',
    ].join('\n');
    const report = evaluateWritingContract(text);
    expect(report.checks.find((item) => item.id === 'antithesis')?.status).toBe('fail');
  });

  it('过短、无小节会给出 warn/fail', () => {
    const report = evaluateWritingContract('只有一句话。');
    expect(report.checks.find((item) => item.id === 'structure')?.status).toBe('fail');
    expect(report.checks.find((item) => item.id === 'length')?.status).toBe('warn');
  });
});

describe('审引清单', () => {
  it('引用来自 claims 且可回溯 raw → 通过', async () => {
    const ctx = ctxOf(harness);
    await seedArticle(ctx, {
      id: 'article-audit-1',
      nodeIds: ['反脆弱'],
      content: GOOD_TEXT,
      citations: [{ text: '反脆弱不是坚强，而是从波动中获益。', source: RAW_A }],
    });

    const report = await auditArticleCitations(ctx, 'article-audit-1');
    expect(report).not.toBeNull();
    expect(report?.markerCount).toBe(2);
    expect(report?.uniqueSources).toBe(1);
    expect(report?.missingRaw).toEqual([]);
    expect(report?.notInClaims).toEqual([]);
    expect(report?.passed).toBe(true);
  });

  it('引用路径不存在时判 fail', async () => {
    const ctx = ctxOf(harness);
    await seedArticle(ctx, {
      id: 'article-audit-2',
      nodeIds: ['反脆弱'],
      content: GOOD_TEXT.replaceAll(RAW_A, 'raw/不存在.md'),
      citations: [{ text: '一个判断。', source: 'raw/不存在.md' }],
    });

    const report = await auditArticleCitations(ctx, 'article-audit-2');
    expect(report?.missingRaw).toEqual(['raw/不存在.md']);
    expect(report?.passed).toBe(false);
  });

  it('节点没有 claims 时给出 warn 而不是 fail', async () => {
    const ctx = ctxOf(harness);
    await seedArticle(ctx, {
      id: 'article-audit-3',
      nodeIds: ['不存在的节点'],
      content: GOOD_TEXT,
      citations: [{ text: '判断。', source: RAW_A }],
    });

    const report = await auditArticleCitations(ctx, 'article-audit-3');
    expect(report?.checks.find((item) => item.id === 'from-claims')?.status).toBe('warn');
    expect(report?.passed).toBe(true);
  });

  it('版本 citations 与正文不一致时给出 warn', async () => {
    const ctx = ctxOf(harness);
    await seedArticle(ctx, {
      id: 'article-audit-4',
      nodeIds: ['反脆弱'],
      content: GOOD_TEXT,
      citations: [],
    });

    const report = await auditArticleCitations(ctx, 'article-audit-4');
    expect(report?.checks.find((item) => item.id === 'record')?.status).toBe('warn');
  });

  it('没有正文时返回 null', async () => {
    const ctx = ctxOf(harness);
    await createArticle(ctx, 'article-audit-5', { title: '空文章', theme: '', nodeIds: ['反脆弱'] });
    await expect(auditArticleCitations(ctx, 'article-audit-5')).resolves.toBeNull();
  });
});
