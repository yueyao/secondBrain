/**
 * 问答链（P1，借鉴 ljg-qa）：把主题节点或文章正文交给 QaPort 抽成 Q-A 链。
 *
 * 只读：不写库、不改文章版本；结果直接在页面展示。
 */
import type { AgentProvenance, QaPort, QaSourceKind } from '@sb/contracts';
import { AppError, type AppContext } from './context';

const DEFAULT_COUNT = 6;
const MIN_COUNT = 3;
const MAX_COUNT = 10;

export interface QaOptions {
  /** 期望问题数（3-10，默认 6）。 */
  readonly count?: number;
  /** 可选聚焦问题，例如"只问代价和边界"。 */
  readonly focus?: string | null;
}

export interface QaChainV1 {
  readonly sourceKind: QaSourceKind;
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly markdown: string;
  readonly questionCount: number;
  readonly materialClaims: number;
  readonly cost: number;
  readonly provenance: AgentProvenance;
  readonly generatedAt: string;
}

function clampCount(value: number | undefined): number {
  const count = value ?? DEFAULT_COUNT;
  if (!Number.isFinite(count)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.trunc(count)));
}

function claimCount(text: string): number {
  return text.split('\n').filter((line) => /^- .+?（来源：\[\[raw\//u.test(line.trim())).length;
}

function optionsOf(options: QaOptions): { readonly count: number; readonly focus: string | null } {
  const focus = (options.focus ?? '').trim();
  return { count: clampCount(options.count), focus: focus === '' ? null : focus };
}

/** 以主题节点为材料生成问答链。 */
export async function qaTopic(ctx: AppContext, qa: QaPort, name: string, options: QaOptions = {}): Promise<QaChainV1> {
  const doc = ctx.search.allDocs().find((entry) => entry.name === name || entry.aliases.includes(name));
  if (!doc) throw new AppError('NOT_FOUND', `节点不存在：${name}`);
  const { count, focus } = optionsOf(options);
  const result = await qa.generate({
    sourceKind: 'topic',
    sourceId: doc.name,
    sourceTitle: doc.name,
    sourceText: doc.body,
    questionCount: { min: count, max: count },
    focus,
  });
  return {
    sourceKind: 'topic',
    sourceId: doc.name,
    sourceTitle: doc.name,
    markdown: result.markdown,
    questionCount: result.questionCount,
    materialClaims: claimCount(doc.body),
    cost: result.cost,
    provenance: result.provenance,
    generatedAt: ctx.clock.now(),
  };
}

/** 以文章当前版本正文为材料生成问答链。 */
export async function qaArticle(ctx: AppContext, qa: QaPort, id: string, options: QaOptions = {}): Promise<QaChainV1> {
  const found = await ctx.store.transaction(async (tx) => {
    const article = await tx.articles.get(id);
    if (!article) return null;
    if (article.currentVersionId === null) return { article, version: null };
    const version = await tx.articleVersions.get(article.currentVersionId);
    return { article, version };
  });
  if (found === null) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
  if (found.version === null) throw new AppError('INVALID_STATE', '文章还没有正文，无法生成问答链');
  const { count, focus } = optionsOf(options);
  const result = await qa.generate({
    sourceKind: 'article',
    sourceId: found.article.id,
    sourceTitle: found.article.title,
    sourceText: found.version.contentMd,
    questionCount: { min: count, max: count },
    focus,
  });
  return {
    sourceKind: 'article',
    sourceId: found.article.id,
    sourceTitle: found.article.title,
    markdown: result.markdown,
    questionCount: result.questionCount,
    materialClaims: claimCount(found.version.contentMd),
    cost: result.cost,
    provenance: result.provenance,
    generatedAt: ctx.clock.now(),
  };
}
