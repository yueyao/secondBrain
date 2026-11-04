/**
 * 主题地图（MOC，P1，只读）。
 *
 * 数据基础：vault 里的 `node_type: topic` 节点本身已是 MOC 形态：
 * `## 一句话定义` / `## 收录边界` / `## 核心判断`（claims）/ `## 相关概念` / `## 相关人物` / `## 来源`。
 *
 * 本模块把这些主题节点汇总为可导航的「主题地图」：
 * - 每个主题的 claims 数、相关概念/人物、入链、覆盖文章；
 * - 文章覆盖矩阵（哪些文章没有挂主题）；
 * - 缺口提示（无 claims / 无来源 / 有料但未成文的主题）。
 *
 * 不写库、不调用模型。
 */
import type { AppContext } from './context';

function sectionOf(body: string, heading: string): string {
  const index = body.indexOf(heading);
  if (index < 0) return '';
  const rest = body.slice(index + heading.length);
  const next = rest.search(/\n## /);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

const LINK_PATTERN = /\[\[([^\]]+)\]\]/g;
const CLAIM_PATTERN = /^- (.+?)（来源：\[\[(raw\/[^\]]+)\]\]/;

function linksOf(section: string): string[] {
  const rows: string[] = [];
  for (const match of section.matchAll(LINK_PATTERN)) {
    const target = (match[1]?.split('|')[0] ?? '').trim();
    if (target !== '' && !target.startsWith('raw/')) rows.push(target);
  }
  return rows;
}

function rawLinksOf(section: string): string[] {
  const rows: string[] = [];
  for (const match of section.matchAll(LINK_PATTERN)) {
    const target = (match[1]?.split('|')[0] ?? '').trim();
    if (target.startsWith('raw/')) rows.push(target);
  }
  return rows;
}

function claimsOf(body: string): number {
  const sections = [sectionOf(body, '## 核心判断'), sectionOf(body, '## 核心观点')];
  let count = 0;
  for (const section of sections) {
    for (const line of section.split('\n')) {
      if (CLAIM_PATTERN.test(line.trim())) count += 1;
    }
  }
  return count;
}

export interface TopicArticleRef {
  readonly id: string;
  readonly title: string;
}

export interface TopicRowV1 {
  readonly name: string;
  readonly file: string;
  readonly aliases: readonly string[];
  readonly definition: string;
  readonly claims: number;
  readonly relatedConcepts: readonly string[];
  readonly relatedPeople: readonly string[];
  readonly sourceCount: number;
  /** 被其他节点引用的次数（入链）。 */
  readonly inbound: number;
  readonly articles: readonly TopicArticleRef[];
  readonly updatedAt: string;
}

export interface TopicMapArticleRow {
  readonly id: string;
  readonly title: string;
  readonly theme: string;
  readonly topics: readonly string[];
  readonly claims: number;
  readonly hasTopic: boolean;
}

export interface TopicMapV1 {
  readonly generatedAt: string;
  readonly q: string;
  readonly totals: {
    readonly topics: number;
    readonly withClaims: number;
    readonly withoutClaims: number;
    readonly withArticles: number;
    readonly withoutArticles: number;
    readonly topicClaims: number;
    readonly articles: number;
    readonly articlesWithTopics: number;
    readonly articlesWithoutTopics: number;
  };
  readonly topics: readonly TopicRowV1[];
  readonly articles: readonly TopicMapArticleRow[];
  /** 过滤前主题总数（用于显示"筛选出 x / y"）。 */
  readonly totalTopics: number;
}

/**
 * 汇总主题地图。
 * @param q 按主题名/定义/相关概念做包含过滤（大小写不敏感）。
 */
export async function topicMap(ctx: AppContext, options: { readonly q?: string } = {}): Promise<TopicMapV1> {
  const docs = ctx.search.allDocs();
  const q = (options.q ?? '').trim();
  const needle = q.toLowerCase();

  const topicDocs = docs.filter((doc) => doc.nodeType === 'topic');

  // 入链统计：所有文档里指向主题名称/别名的链接（排除自链接与 raw）
  const nameToTopic = new Map<string, string>();
  for (const doc of topicDocs) {
    nameToTopic.set(doc.name, doc.name);
    for (const alias of doc.aliases) nameToTopic.set(alias, doc.name);
  }
  const inbound = new Map<string, number>();
  for (const doc of docs) {
    for (const link of linksOf(doc.body)) {
      const nodeName = link.split('#')[0] ?? link;
      const topicName = nameToTopic.get(nodeName);
      if (topicName !== undefined && topicName !== doc.name) {
        inbound.set(topicName, (inbound.get(topicName) ?? 0) + 1);
      }
    }
  }

  const articles = await ctx.store.transaction(async (tx) => tx.articles.list());
  const articlesByTopic = new Map<string, TopicArticleRef[]>();
  const articleRows: TopicMapArticleRow[] = [];
  for (const article of articles) {
    const topics: string[] = [];
    let claims = 0;
    for (const nodeId of article.nodeIds) {
      const topicName = nameToTopic.get(nodeId);
      if (topicName !== undefined) {
        topics.push(topicName);
        const doc = topicDocs.find((entry) => entry.name === topicName);
        claims += doc ? claimsOf(doc.body) : 0;
        const refs = articlesByTopic.get(topicName) ?? [];
        if (!refs.some((ref) => ref.id === article.id)) refs.push({ id: article.id, title: article.title });
        articlesByTopic.set(topicName, refs);
      }
    }
    articleRows.push({
      id: article.id,
      title: article.title,
      theme: article.theme,
      topics,
      claims,
      hasTopic: topics.length > 0,
    });
  }

  const rows: TopicRowV1[] = topicDocs.map((doc) => {
    const relatedConcepts = linksOf(sectionOf(doc.body, '## 相关概念'));
    const relatedPeople = linksOf(sectionOf(doc.body, '## 相关人物'));
    const sourceCount = new Set(rawLinksOf(sectionOf(doc.body, '## 来源'))).size;
    return {
      name: doc.name,
      file: doc.file,
      aliases: doc.aliases,
      definition: sectionOf(doc.body, '## 一句话定义').split('\n')[0]?.trim() ?? '',
      claims: claimsOf(doc.body),
      relatedConcepts,
      relatedPeople,
      sourceCount,
      inbound: inbound.get(doc.name) ?? 0,
      articles: articlesByTopic.get(doc.name) ?? [],
      updatedAt: doc.updatedAt,
    };
  });

  const filtered = needle === ''
    ? rows
    : rows.filter((row) => [row.name, row.definition, ...row.relatedConcepts, ...row.relatedPeople].some((text) => text.toLowerCase().includes(needle)));
  filtered.sort((a, b) => b.claims - a.claims || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  return {
    generatedAt: ctx.clock.now(),
    q,
    totals: {
      topics: rows.length,
      withClaims: rows.filter((row) => row.claims > 0).length,
      withoutClaims: rows.filter((row) => row.claims === 0).length,
      withArticles: rows.filter((row) => row.articles.length > 0).length,
      withoutArticles: rows.filter((row) => row.articles.length === 0).length,
      topicClaims: rows.reduce((sum, row) => sum + row.claims, 0),
      articles: articleRows.length,
      articlesWithTopics: articleRows.filter((row) => row.hasTopic).length,
      articlesWithoutTopics: articleRows.filter((row) => !row.hasTopic).length,
    },
    topics: filtered,
    articles: articleRows.sort((a, b) => Number(a.hasTopic) - Number(b.hasTopic) || a.title.localeCompare(b.title, 'zh-Hans-CN')),
    totalTopics: rows.length,
  };
}
