/**
 * Compose：主编台用例（ADR 0005 修订 / C1→C3）。
 *
 * - C1：创建文章、保存大纲（人写或 AI 生成）；
 * - C2：AI 生成大纲 + 正文 v1（版本链只增不改，引用可回溯到 raw 原文）；
 * - C3：按指令改稿（vN+1）、恢复旧版本为新版本、版本对比（行级 diff）。
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
  Transaction,
} from '@sb/contracts';
import { extractCitationSources } from '@sb/domain';
import { AppError, type AppContext } from './context';
import { diffLines, diffStats, type DiffLine, type DiffStats } from './diff';

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

/** 每个节点喂给模型的 claims 上限；顶级主题节点可能有几百条，全量喂会让 prompt 与成本失控。 */
export const MAX_CLAIMS_PER_NODE = 60;

/**
 * 生成材料的 claims 抽样：等距取样，保持时间跨度，并去重文本。
 * 用途是给模型"可引用的判断池"，不是全量知识；引用仍以原文路径为准。
 */
export function sampleClaimsForPrompt(
  claims: readonly { readonly text: string; readonly source: string }[],
): readonly { readonly text: string; readonly source: string }[] {
  if (claims.length <= MAX_CLAIMS_PER_NODE) return claims;
  const step = claims.length / MAX_CLAIMS_PER_NODE;
  const picked: { text: string; source: string }[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < MAX_CLAIMS_PER_NODE; index++) {
    const claim = claims[Math.floor(index * step)];
    if (claim === undefined || seen.has(claim.text)) continue;
    seen.add(claim.text);
    picked.push({ text: claim.text, source: claim.source });
  }
  return picked;
}

/** 把文章的节点名映射回 search 索引，拿到 claims 作为生成材料（按节点抽样）。 */
async function loadArticleMaterial(ctx: AppContext, id: string): Promise<ArticleMaterial> {
  const article = await ctx.store.transaction(async (tx) => tx.articles.get(id));
  if (!article) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
  const docs = ctx.search.allDocs();
  const nodes = article.nodeIds.map((name) => {
    const doc = docs.find((entry) => entry.name === name || entry.aliases.includes(name));
    return {
      name,
      nodeType: doc?.nodeType ?? 'unknown',
      claims: doc ? sampleClaimsForPrompt(claimsIn(doc.body)) : [],
    };
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
  const citations = validateGeneratedBody(text, nodes);

  return appendBodyVersion(ctx, id, {
    contentMd: text,
    citations,
    instruction: null,
    note: null,
    provider: composed.provenance.provider,
    model: composed.provenance.model,
    promptVersion: composed.provenance.promptVersion,
    inputTokens: composed.provenance.inputTokens,
    outputTokens: composed.provenance.outputTokens,
    cost: composed.cost,
    sourceOf: (versionNo) => (versionNo === 1 ? 'ai_initial' : 'ai_refine'),
    eventExtras: { profileId: composed.provenance.profileId, model: composed.provenance.model },
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

/** 正文公共校验（生成与改稿一致）：长度不足或没有来源引用都拒收。 */
function validateGeneratedBody(text: string, nodes: readonly ComposeNodeMaterial[]): readonly ArticleCitation[] {
  if (text.length < BODY_MIN_CHARS) {
    throw new AppError('INVALID_STATE', `模型返回的正文太短（${text.length} 字），未保存`);
  }
  const citations = enrichCitations(text, nodes);
  if (citations.length === 0) {
    throw new AppError('INVALID_STATE', '正文没有任何来源引用，未保存');
  }
  return citations;
}

/** 追加正文版本的公共输入：生成 / 改稿 / 恢复只在少数字段上不同。 */
interface AppendBodyVersionInput {
  readonly contentMd: string;
  readonly citations: readonly ArticleCitation[];
  readonly instruction: string | null;
  readonly note: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly promptVersion: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cost: number | null;
  /** 版本来源：初稿按 v1/v2+ 区分，改稿/恢复固定。 */
  readonly sourceOf: (versionNo: number) => ArticleVersionSource;
  /** 事件 payload 的用例附加字段（versionNo / source / 字数 / 引用数由公共逻辑补）。 */
  readonly eventExtras: Record<string, unknown>;
}

/**
 * 在调用方事务内追加版本：版本号 = 现有最大 +1、设当前版本、状态回 review、
 * 同事务写 `article:version_created`（版本只增不改，历史永远可回溯）。
 */
async function appendBodyVersionInTx(
  tx: Transaction,
  id: string,
  at: string,
  input: AppendBodyVersionInput,
): Promise<ArticleVersionRecord> {
  const article = await tx.articles.get(id);
  if (!article) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
  const existing = await tx.articleVersions.listByArticle(id);
  const versionNo = existing.reduce((max, version) => Math.max(max, version.versionNo), 0) + 1;
  const source = input.sourceOf(versionNo);
  const record: ArticleVersionRecord = {
    id: `${id}-v${versionNo}`,
    articleId: id,
    versionNo,
    contentMd: input.contentMd,
    citations: input.citations,
    basedOnVersionId: article.currentVersionId,
    source,
    instruction: input.instruction,
    provider: input.provider,
    model: input.model,
    promptVersion: input.promptVersion,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cost: input.cost,
    note: input.note,
    createdAt: at,
  };
  await tx.articleVersions.append(record);
  await tx.articles.setCurrentVersion(id, record.id, at);
  await tx.articles.setStatus(id, 'review', at);
  await tx.events.append({
    at, actor: 'owner', type: 'article:version_created', aggregateId: id,
    payload: {
      versionNo, source, chars: input.contentMd.length, citations: input.citations.length, ...input.eventExtras,
    },
  });
  return record;
}

/** 独立事务版：生成与改稿在模型返回后再落库。 */
async function appendBodyVersion(
  ctx: AppContext,
  id: string,
  input: AppendBodyVersionInput,
): Promise<ArticleVersionRecord> {
  const now = ctx.clock.now();
  return ctx.store.transaction(async (tx) => appendBodyVersionInTx(tx, id, now, input));
}

/**
 * 按改稿指令生成 vN+1（ADR 0005 C3）。
 *
 * 与"重新生成"的区别：指令落库到 article_version.instruction，基于当前版本
 * 追加新版本（`basedOnVersionId`），旧版本保留；即使文章已定稿也回到 review。
 */
export async function refineArticle(ctx: AppContext, id: string, instruction: string): Promise<ArticleVersionRecord> {
  const composer = requireComposer(ctx);
  const { article, nodes } = await loadArticleMaterial(ctx, id);
  if (!article.currentVersionId) {
    throw new AppError('INVALID_STATE', '当前还没有正文，先生成 v1');
  }
  const outline = article.outline?.trim() ?? '';
  if (outline.length === 0) throw new AppError('INVALID_STATE', '请先生成或填写大纲，再生成正文');
  const trimmed = instruction.trim();
  if (trimmed.length < 4) throw new AppError('INVALID_STATE', '改稿指令至少 4 个字');
  if (nodes.every((node) => node.claims.length === 0)) {
    throw new AppError('EMPTY_CLAIMS', '所选节点没有 claims，无法改稿');
  }

  const composed = await composer.write({
    kind: 'body', title: article.title, theme: article.theme, outline, nodes, instruction: trimmed,
  });
  const text = composed.text.trim();
  const citations = validateGeneratedBody(text, nodes);

  return appendBodyVersion(ctx, id, {
    contentMd: text,
    citations,
    instruction: trimmed,
    note: null,
    provider: composed.provenance.provider,
    model: composed.provenance.model,
    promptVersion: composed.provenance.promptVersion,
    inputTokens: composed.provenance.inputTokens,
    outputTokens: composed.provenance.outputTokens,
    cost: composed.cost,
    sourceOf: () => 'ai_refine',
    eventExtras: {
      profileId: composed.provenance.profileId,
      model: composed.provenance.model,
      instruction: trimmed,
    },
  });
}

/**
 * 恢复旧版本：不覆盖、不删除历史，而是把目标版本的内容复制成一条新版本。
 * 新版本 source='restore'、note 记来源，模型/tokens/cost 置空（这次没有调用模型）。
 */
export async function restoreArticleVersion(ctx: AppContext, id: string, versionId: string): Promise<ArticleVersionRecord> {
  const now = ctx.clock.now();
  return ctx.store.transaction(async (tx) => {
    const article = await tx.articles.get(id);
    if (!article) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
    const target = await tx.articleVersions.get(versionId);
    if (!target || target.articleId !== id) throw new AppError('NOT_FOUND', `版本不存在：${versionId}`);
    if (target.id === article.currentVersionId) throw new AppError('INVALID_STATE', '已经是当前版本');
    return appendBodyVersionInTx(tx, id, now, {
      contentMd: target.contentMd,
      citations: target.citations,
      instruction: null,
      note: `恢复自 v${target.versionNo}`,
      provider: null,
      model: null,
      promptVersion: null,
      inputTokens: null,
      outputTokens: null,
      cost: null,
      sourceOf: () => 'restore',
      eventExtras: { restoredFrom: target.versionNo },
    });
  });
}

export interface ComposeDiffVersionRef {
  readonly id: string;
  readonly versionNo: number;
  readonly source: string;
  readonly createdAt: string;
}

export interface ComposeDiffView {
  readonly articleId: string;
  readonly title: string;
  readonly from: ComposeDiffVersionRef;
  readonly to: ComposeDiffVersionRef;
  readonly lines: readonly DiffLine[];
  readonly stats: DiffStats;
}

function versionRef(version: ArticleVersionRecord): ComposeDiffVersionRef {
  return { id: version.id, versionNo: version.versionNo, source: version.source, createdAt: version.createdAt };
}

/** 版本对比：文章或任一版本不存在 / 版本不属于该文章时返回 null（交给视图显示 404）。 */
export async function composeArticleDiff(
  ctx: AppContext,
  id: string,
  fromVersionId: string,
  toVersionId: string,
): Promise<ComposeDiffView | null> {
  return ctx.store.transaction(async (tx) => {
    const article = await tx.articles.get(id);
    if (!article) return null;
    const from = await tx.articleVersions.get(fromVersionId);
    const to = await tx.articleVersions.get(toVersionId);
    if (!from || from.articleId !== id) return null;
    if (!to || to.articleId !== id) return null;
    const lines = diffLines(from.contentMd, to.contentMd);
    return {
      articleId: id,
      title: article.title,
      from: versionRef(from),
      to: versionRef(to),
      lines,
      stats: diffStats(lines),
    };
  });
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
  /** 改稿指令（AI 改稿版本才有；生成/恢复版本为 null）。 */
  readonly instruction: string | null;
  /** 系统备注（如恢复来源）。 */
  readonly note: string | null;
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
      instruction: version.instruction,
      note: version.note,
      createdAt: version.createdAt,
    })),
    current: currentVersion
      ? { versionNo: currentVersion.versionNo, contentMd: currentVersion.contentMd, createdAt: currentVersion.createdAt }
      : null,
  };
}
