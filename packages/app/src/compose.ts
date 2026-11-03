/**
 * Compose：主编台用例（ADR 0005 修订 / C1→C2）。
 *
 * - C1：创建文章、保存大纲（人写或 AI 生成）；
 * - C2：AI 生成大纲 + 正文 v1（版本链只增不改，引用可回溯到 raw 原文）。
 *
 * 应用层只依赖 ComposePort：模型调用、预算、重试、降级、provenance 都在
 * @sb/agent-runtime；这里只做业务校验、版本落库与事件。
 */
import type {
  ArticleCitation,
  ArticleRecord,
  ArticleVersionRecord,
  ArticleVersionSource,
  ComposeNodeMaterial,
  ComposePort,
} from '@sb/contracts';
import { extractCitationSources } from '@sb/domain';
import { AppError, type AppContext } from './context';

/** 应用层兜底校验：模型执行层已校验，这里防止端口实现被替换后写入垃圾。 */
const OUTLINE_MIN_CHARS = 60;
const BODY_MIN_CHARS = 300;
/** 文章详情页预览 claims 的条数（生成时用全部 claims）。 */
const PREVIEW_CLAIMS = 12;

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

function requireComposer(ctx: AppContext): ComposePort {
  if (!ctx.composer) {
    throw new AppError('MODEL_UNAVAILABLE', '未配置模型生成能力（MODEL_BASE_URL / MODEL_API_KEY）');
  }
  return ctx.composer;
}

/** 从 wiki 节点正文里解析 claims（`- 判断（来源：[[raw/...]]）`）。 */
function claimsIn(body: string): { text: string; source: string }[] {
  const rows: { text: string; source: string }[] = [];
  for (const line of body.split('\n')) {
    const match = line.match(/^- (.+?)（来源：\[\[(raw\/[^\]]+)\]\]/);
    if (match) rows.push({ text: match[1] as string, source: match[2] as string });
  }
  return rows;
}

interface ArticleMaterial {
  readonly article: ArticleRecord;
  readonly nodes: readonly ComposeNodeMaterial[];
}

/** 把文章的节点名映射回 search 索引，拿到全部 claims 作为生成材料。 */
async function loadArticleMaterial(ctx: AppContext, id: string): Promise<ArticleMaterial> {
  const article = await ctx.store.transaction(async (tx) => tx.articles.get(id));
  if (!article) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
  const docs = ctx.search.allDocs();
  const nodes = article.nodeIds.map((name) => {
    const doc = docs.find((entry) => entry.name === name || entry.aliases.includes(name));
    return { name, nodeType: doc?.nodeType ?? 'unknown', claims: doc ? claimsIn(doc.body) : [] };
  });
  return { article, nodes };
}

/** AI 生成大纲并保存；返回保存后的大纲。 */
export async function generateArticleOutline(ctx: AppContext, id: string): Promise<string> {
  const composer = requireComposer(ctx);
  const { article, nodes } = await loadArticleMaterial(ctx, id);
  if (nodes.every((node) => node.claims.length === 0)) {
    throw new AppError('EMPTY_CLAIMS', '所选节点没有 claims，无法生成大纲');
  }

  const composed = await composer.write({
    kind: 'outline', title: article.title, theme: article.theme, outline: null, nodes, instruction: null,
  });
  const outline = composed.text.trim();
  if (outline.length < OUTLINE_MIN_CHARS) {
    throw new AppError('INVALID_STATE', `模型返回的大纲太短（${outline.length} 字），未保存`);
  }

  const now = ctx.clock.now();
  await ctx.store.transaction(async (tx) => {
    const current = await tx.articles.get(id);
    if (!current) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
    await tx.articles.setOutline(id, outline, now);
    await tx.events.append({
      at: now, actor: 'owner', type: 'article:outline_generated', aggregateId: id,
      payload: { chars: outline.length, profileId: composed.provenance.profileId, model: composed.provenance.model },
    });
  });
  return outline;
}

/** 基于已确认大纲生成正文，落成新版本并设为当前版本。 */
export async function generateArticleBody(ctx: AppContext, id: string): Promise<ArticleVersionRecord> {
  const composer = requireComposer(ctx);
  const { article, nodes } = await loadArticleMaterial(ctx, id);
  const outline = article.outline?.trim() ?? '';
  if (outline.length === 0) throw new AppError('INVALID_STATE', '请先生成或填写大纲，再生成正文');
  if (nodes.every((node) => node.claims.length === 0)) {
    throw new AppError('EMPTY_CLAIMS', '所选节点没有 claims，无法生成正文');
  }

  const composed = await composer.write({
    kind: 'body', title: article.title, theme: article.theme, outline, nodes, instruction: null,
  });
  const text = composed.text.trim();
  if (text.length < BODY_MIN_CHARS) {
    throw new AppError('INVALID_STATE', `模型返回的正文太短（${text.length} 字），未保存`);
  }
  const citations = enrichCitations(text, nodes);
  if (citations.length === 0) {
    throw new AppError('INVALID_STATE', '正文没有任何来源引用，未保存');
  }

  const now = ctx.clock.now();
  return ctx.store.transaction(async (tx) => {
    const current = await tx.articles.get(id);
    if (!current) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
    const versions = await tx.articleVersions.listByArticle(id);
    const versionNo = versions.reduce((max, version) => Math.max(max, version.versionNo), 0) + 1;
    const source: ArticleVersionSource = versionNo === 1 ? 'ai_initial' : 'ai_refine';
    const record: ArticleVersionRecord = {
      id: `${id}-v${versionNo}`,
      articleId: id,
      versionNo,
      contentMd: text,
      citations,
      basedOnVersionId: current.currentVersionId,
      source,
      instruction: null,
      provider: composed.provenance.provider,
      model: composed.provenance.model,
      promptVersion: composed.provenance.promptVersion,
      inputTokens: composed.provenance.inputTokens,
      outputTokens: composed.provenance.outputTokens,
      cost: composed.cost,
      note: null,
      createdAt: now,
    };
    await tx.articleVersions.append(record);
    await tx.articles.setCurrentVersion(id, record.id, now);
    await tx.articles.setStatus(id, 'review', now);
    await tx.events.append({
      at: now, actor: 'owner', type: 'article:version_created', aggregateId: id,
      payload: {
        versionNo, source, chars: text.length, citations: citations.length,
        profileId: composed.provenance.profileId, model: composed.provenance.model,
      },
    });
    return record;
  });
}

/** 引用标记 → 引用记录：source 命中节点 claims 时补上判断句原文。 */
function enrichCitations(text: string, nodes: readonly ComposeNodeMaterial[]): readonly ArticleCitation[] {
  const claimBySource = new Map<string, string>();
  for (const node of nodes) {
    for (const claim of node.claims) {
      if (!claimBySource.has(claim.source)) claimBySource.set(claim.source, claim.text);
    }
  }
  return extractCitationSources(text).map((source) => ({ source, text: claimBySource.get(source) ?? '' }));
}

export interface ComposeNodeView {
  readonly name: string;
  readonly nodeType: string;
  readonly claimCount: number;
  readonly claims: readonly { readonly text: string; readonly source: string }[];
}

export interface ComposeArticleVersionView {
  readonly id: string;
  readonly versionNo: number;
  readonly source: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cost: number | null;
  readonly chars: number;
  readonly createdAt: string;
}

export interface ComposeArticleView {
  readonly id: string;
  readonly title: string;
  readonly theme: string;
  readonly status: string;
  readonly outline: string | null;
  readonly updatedAt: string;
  readonly nodes: readonly ComposeNodeView[];
  /** 版本链，最新在前。 */
  readonly versions: readonly ComposeArticleVersionView[];
  /** 当前版本正文（与 versions[0] 一致，便于模板直接渲染）。 */
  readonly current: { readonly versionNo: number; readonly contentMd: string; readonly createdAt: string } | null;
}

export async function composeArticleView(ctx: AppContext, id: string): Promise<ComposeArticleView | null> {
  const article = await ctx.store.transaction(async (tx) => tx.articles.get(id));
  if (!article) return null;
  const docs = ctx.search.allDocs();
  const nodes = article.nodeIds.map((name) => {
    const doc = docs.find((entry) => entry.name === name || entry.aliases.includes(name));
    const claims = doc ? claimsIn(doc.body) : [];
    return {
      name,
      nodeType: doc?.nodeType ?? 'unknown',
      claimCount: claims.length,
      claims: claims.slice(0, PREVIEW_CLAIMS),
    };
  });
  const versions = await ctx.store.transaction(async (tx) => tx.articleVersions.listByArticle(id));
  const currentVersion = article.currentVersionId
    ? versions.find((version) => version.id === article.currentVersionId) ?? null
    : null;
  return {
    id: article.id,
    title: article.title,
    theme: article.theme,
    status: article.status,
    outline: article.outline,
    updatedAt: article.updatedAt,
    nodes,
    versions: versions.map((version) => ({
      id: version.id,
      versionNo: version.versionNo,
      source: version.source,
      provider: version.provider,
      model: version.model,
      inputTokens: version.inputTokens,
      outputTokens: version.outputTokens,
      cost: version.cost,
      chars: [...version.contentMd].length,
      createdAt: version.createdAt,
    })),
    current: currentVersion
      ? { versionNo: currentVersion.versionNo, contentMd: currentVersion.contentMd, createdAt: currentVersion.createdAt }
      : null,
  };
}
