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
