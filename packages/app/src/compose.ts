/** Compose C1：文章创建与大纲保存（生成 v1 在 C2 接入 agent）。 */
import type { ArticleRecord } from '@sb/contracts';
import { AppError, type AppContext } from './context';

export interface CreateArticleInput {
  readonly title: string;
  readonly theme: string;
  readonly nodeIds: readonly string[];
}

export async function createArticle(ctx: AppContext, id: string, input: CreateArticleInput): Promise<ArticleRecord> {
  const title = input.title.trim();
  if (title.length < 2) throw new AppError('INVALID_STATE', '标题至少 2 个字');
  if (input.nodeIds.length === 0) throw new AppError('INVALID_STATE', '至少选择一个知识节点');
  const now = ctx.clock.now();
  const record: ArticleRecord = {
    id, title, theme: input.theme.trim(), nodeIds: input.nodeIds,
    outline: null, status: 'draft', currentVersionId: null, createdAt: now, updatedAt: now,
  };
  await ctx.store.transaction(async (tx) => {
    await tx.articles.insert(record);
    await tx.events.append({ at: now, actor: 'owner', type: 'article:created', aggregateId: id, payload: { title, nodeIds: input.nodeIds } });
  });
  return record;
}

export async function saveArticleOutline(ctx: AppContext, id: string, outline: string): Promise<void> {
  const now = ctx.clock.now();
  await ctx.store.transaction(async (tx) => {
    const article = await tx.articles.get(id);
    if (!article) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
    await tx.articles.setOutline(id, outline, now);
  });
}


export interface ComposeNodeView {
  readonly name: string;
  readonly nodeType: string;
  readonly claimCount: number;
  readonly claims: readonly { readonly text: string; readonly source: string }[];
}

export interface ComposeArticleView {
  readonly id: string;
  readonly title: string;
  readonly theme: string;
  readonly status: string;
  readonly outline: string | null;
  readonly updatedAt: string;
  readonly nodes: readonly ComposeNodeView[];
}

function claimsIn(body: string): { text: string; source: string }[] {
  const rows: { text: string; source: string }[] = [];
  for (const line of body.split('\n')) {
    const match = line.match(/^- (.+?)（来源：\[\[(raw\/[^\]]+)\]\]/);
    if (match) rows.push({ text: match[1] as string, source: match[2] as string });
  }
  return rows;
}

export async function composeArticleView(ctx: AppContext, id: string): Promise<ComposeArticleView | null> {
  const article = await ctx.store.transaction(async (tx) => tx.articles.get(id));
  if (!article) return null;
  const docs = ctx.search.allDocs();
  const nodes = article.nodeIds.map((name) => {
    const doc = docs.find((entry) => entry.name === name || entry.aliases.includes(name));
    const claims = doc ? claimsIn(doc.body) : [];
    return { name, nodeType: doc?.nodeType ?? 'unknown', claimCount: claims.length, claims: claims.slice(0, 12) };
  });
  return { id: article.id, title: article.title, theme: article.theme, status: article.status, outline: article.outline, updatedAt: article.updatedAt, nodes };
}
