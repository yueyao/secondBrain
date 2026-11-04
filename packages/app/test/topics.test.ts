import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringifyFrontmatter } from '@sb/domain';
import { createHarness, hashPort, type TestHarness } from '@sb/testing';
import type { AppContext } from '../src/context';
import { createArticle } from '../src/compose';
import { topicMap } from '../src/topics';

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

async function writeTopic(
  harness: TestHarness,
  name: string,
  options: { readonly claims?: number; readonly related?: readonly string[]; readonly people?: readonly string[]; readonly withDefinition?: boolean } = {},
): Promise<void> {
  const claims = options.claims ?? 0;
  const body = [
    `# ${name}`,
    '',
    ...(options.withDefinition === false ? [] : ['## 一句话定义', '', `${name}的一句话定义。`, '']),
    '## 核心判断',
    '',
    ...Array.from({ length: claims }, (_, index) => `- ${name}的第 ${index + 1} 条判断。（来源：[[raw/knowledge/cubox/mock-legacy.md]]）`),
    '',
    '## 相关概念',
    '',
    ...(options.related ?? []).map((item) => `- [[${item}]]`),
    '',
    '## 相关人物',
    '',
    ...(options.people ?? []).map((item) => `- [[${item}]]`),
    '',
    '## 来源',
    '',
    '- [[raw/knowledge/cubox/mock-legacy.md]]',
    '',
  ].join('\n');
  const file = `wiki/topics/${name}.md`;
  const content = stringifyFrontmatter(
    {
      type: 'node', node_type: 'topic', name, aliases: [],
      review_status: 'active', updated_at: '2026-10-31', confirmed: true,
      tags: ['layer/wiki', 'node/topic'],
    },
    body,
  );
  await harness.vault.writeNode(file, content);
  await harness.search.refresh();
}

async function writeConcept(harness: TestHarness, name: string, related: readonly string[]): Promise<void> {
  const file = `wiki/concepts/${name}.md`;
  const content = stringifyFrontmatter(
    {
      type: 'node', node_type: 'concept', name, aliases: [],
      review_status: 'active', updated_at: '2026-10-31', confirmed: true,
      tags: ['layer/wiki', 'node/concept'],
    },
    ['# ' + name, '', '## 一句话定义', '', `${name}的定义。`, '', '## 相关概念', '', ...related.map((item) => `- [[${item}]]`), ''].join('\n'),
  );
  await harness.vault.writeNode(file, content);
  await harness.search.refresh();
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('主题地图（MOC）', () => {
  it('汇总主题 claims、相关概念/人物、来源与文章覆盖', async () => {
    await writeTopic(harness, '测试主题', { claims: 2, related: ['反脆弱', '安全边际'], people: ['某人'] });
    await writeTopic(harness, '空主题', { withDefinition: false });
    await writeConcept(harness, '引用节点', ['测试主题']);
    const ctx = ctxOf(harness);
    await createArticle(ctx, 'article-topic-1', { title: '用主题写的文章', theme: '测试主题', nodeIds: ['测试主题', '反脆弱'] });

    const map = await topicMap(ctx);
    expect(map.totals.topics).toBe(2);
    expect(map.totals.withClaims).toBe(1);
    expect(map.totals.withoutClaims).toBe(1);
    expect(map.totals.topicClaims).toBe(2);
    expect(map.totals.articles).toBe(1);
    expect(map.totals.articlesWithTopics).toBe(1);
    expect(map.totals.articlesWithoutTopics).toBe(0);

    const row = map.topics.find((item) => item.name === '测试主题');
    expect(row).toBeDefined();
    expect(row?.claims).toBe(2);
    expect(row?.definition).toBe('测试主题的一句话定义。');
    expect(row?.relatedConcepts).toEqual(['反脆弱', '安全边际']);
    expect(row?.relatedPeople).toEqual(['某人']);
    expect(row?.sourceCount).toBe(1);
    expect(row?.inbound).toBeGreaterThanOrEqual(1);
    expect(row?.articles.map((article) => article.id)).toEqual(['article-topic-1']);

    const article = map.articles[0];
    expect(article?.topics).toEqual(['测试主题']);
    expect(article?.hasTopic).toBe(true);
    expect(article?.claims).toBe(2);
  });

  it('能标出未挂主题的文章与未成文主题', async () => {
    await writeTopic(harness, '有料主题', { claims: 3 });
    await writeTopic(harness, '空主题', { claims: 0 });
    const ctx = ctxOf(harness);
    await createArticle(ctx, 'article-topic-2', { title: '未挂主题文章', theme: '', nodeIds: ['反脆弱'] });

    const map = await topicMap(ctx);
    expect(map.totals.articlesWithoutTopics).toBe(1);
    expect(map.articles[0]?.hasTopic).toBe(false);
    const emptyTopic = map.topics.find((item) => item.name === '空主题');
    expect(emptyTopic?.articles).toEqual([]);
    expect(map.totals.withoutArticles).toBe(2);
    expect(map.topics.find((item) => item.name === '有料主题')?.claims).toBe(3);
  });

  it('支持按主题名/定义/相关概念过滤，并保留总数', async () => {
    await writeTopic(harness, 'AI 与认知', { claims: 1, related: ['心智模型'] });
    await writeTopic(harness, '商业与创业', { claims: 1 });

    const filtered = await topicMap(ctxOf(harness), { q: '心智' });
    expect(filtered.totalTopics).toBe(2);
    expect(filtered.topics).toHaveLength(1);
    expect(filtered.topics[0]?.name).toBe('AI 与认知');
    expect(filtered.q).toBe('心智');
  });

  it('没有 topic 节点时给出空结果而不是报错', async () => {
    // fixtures 默认没有 topic 节点
    const map = await topicMap(ctxOf(harness));
    expect(map.totals.topics).toBe(0);
    expect(map.topics).toEqual([]);
    expect(map.totals.articles).toBe(0);
  });
});
