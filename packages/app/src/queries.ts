/** 查询：给 CLI / UI 用的读模型（ReviewViewV1 / QueueItemV1）。 */
import type { QueueItemV1, ReviewViewV1 } from '@sb/contracts';
import { parseDraftId, parseRawPath, type DraftId, type RawPath, type TriageResult } from '@sb/domain';
import { AppError, type AppContext } from './context';

function parseRawPathOk(value: string): RawPath {
  const parsed = parseRawPath(value);
  if (!parsed.ok) throw new AppError('NOT_FOUND', parsed.error.message);
  return parsed.value;
}

function triageOf(rawState: unknown): TriageResult | null {
  if (typeof rawState !== 'object' || rawState === null) return null;
  const triage = (rawState as { triage?: TriageResult }).triage;
  return triage ?? null;
}

const ACTIONABLE = ['queued', 'draft_ready', 'in_review', 'changes_requested', 'blocked'] as const;

export async function listQueue(ctx: AppContext): Promise<readonly QueueItemV1[]> {
  const items = await ctx.store.transaction(async (tx) => tx.rawItems.listByState([...ACTIONABLE]));
  const pending = await ctx.store.transaction(async (tx) => tx.drafts.listByStatus('pending'));
  const draftByItem = new Map(pending.map((draft) => [draft.rawItemId, draft.id]));

  return items.map((item) => ({
    schemaVersion: 1,
    rawPath: item.rawPath,
    title: item.title,
    state: item.state.kind,
    charCount: item.charCount,
    triage: triageOf(item.state),
    draftId: draftByItem.get(item.id) ?? null,
  }));
}

export async function listPendingDrafts(ctx: AppContext): Promise<readonly ReviewViewV1[]> {
  const drafts = await ctx.store.transaction(async (tx) => tx.drafts.listByStatus('pending'));
  const views: ReviewViewV1[] = [];
  for (const draft of drafts) {
    try {
      views.push(await reviewView(ctx, draft.id));
    } catch {
      // 草稿对应的原文缺失时不阻塞列表
    }
  }
  return views;
}

export async function reviewView(ctx: AppContext, draftId: DraftId): Promise<ReviewViewV1> {
  const draft = await ctx.store.transaction(async (tx) => tx.drafts.get(draftId));
  if (!draft) throw new AppError('NOT_FOUND', `草稿不存在：${draftId}`);

  const source = draft.proposal.claims[0]?.source;
  if (!source) throw new AppError('EMPTY_CLAIMS', '草稿没有 claims');
  const rawPath = parseRawPathOk(source);
  const item = await ctx.store.transaction(async (tx) => tx.rawItems.getByPath(rawPath));
  if (!item) throw new AppError('NOT_FOUND', '原文记录不存在');

  const blockedBy = draft.findings
    .filter((finding) => finding.severity === 'block')
    .map((finding) => finding.ruleId);

  return {
    schemaVersion: 1,
    draftId: draft.id,
    title: item.title,
    rawPath,
    charCount: item.charCount,
    tier: draft.proposal.tier,
    state: item.state.kind,
    findings: draft.findings.map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      message: finding.message,
      detail: finding.detail,
    })),
    claims: draft.proposal.claims,
    nodes: draft.proposal.nodes,
    actions: { accept: blockedBy.length === 0, blockedBy },
    provenance: {
      provider: draft.provider,
      model: draft.model,
      promptVersion: draft.promptVersion,
      inputTokens: draft.inputTokens,
      latencyMs: draft.latencyMs,
    },
    createdAt: draft.createdAt,
  };
}

export async function searchWiki(ctx: AppContext, query: string, limit = 10) {
  return ctx.search.query(query, limit);
}

export interface UsageDaySummary {
  readonly day: string;
  readonly calls: number;
  readonly cacheHits: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCost: number;
  readonly firstAt: string;
  readonly lastAt: string;
}

export interface UsageProfileSummary {
  readonly profileId: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCost: number;
}

export interface UsageSummary {
  readonly days: readonly UsageDaySummary[];
  readonly byProfile: readonly UsageProfileSummary[];
  readonly totals: Omit<UsageDaySummary, 'day'>;
}

function costOfUsage(
  inputTokens: number,
  outputTokens: number,
  profileId: string,
  pricing: AppContext['pricing'],
): number {
  const price = pricing?.[profileId];
  if (!price) return 0;
  const cost = (inputTokens / 1_000_000) * price.inPerMTokens + (outputTokens / 1_000_000) * price.outPerMTokens;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** 用量汇总：按天、按 profile；不拦截，只报告（ADR 0005 修订）。 */
export async function usageSummary(ctx: AppContext, options: { readonly day?: string } = {}): Promise<UsageSummary> {
  const records = options.day
    ? await ctx.store.transaction(async (tx) => tx.usage.listByDay(options.day as string))
    : await ctx.store.transaction(async (tx) => tx.usage.listAll());

  const days = new Map<string, UsageDaySummary>();
  const profiles = new Map<string, UsageProfileSummary>();

  for (const record of records) {
    const day = record.at.slice(0, 10);
    const cost = costOfUsage(record.inputTokens, record.outputTokens, record.profileId, ctx.pricing);
    const dayEntry = days.get(day) ?? { day, calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, firstAt: record.at, lastAt: record.at };
    days.set(day, {
      day,
      calls: dayEntry.calls + 1,
      cacheHits: dayEntry.cacheHits + (record.cacheHit ? 1 : 0),
      inputTokens: dayEntry.inputTokens + record.inputTokens,
      outputTokens: dayEntry.outputTokens + record.outputTokens,
      estimatedCost: Math.round((dayEntry.estimatedCost + cost) * 1_000_000) / 1_000_000,
      firstAt: record.at < dayEntry.firstAt ? record.at : dayEntry.firstAt,
      lastAt: record.at > dayEntry.lastAt ? record.at : dayEntry.lastAt,
    });

    const profileEntry = profiles.get(record.profileId) ?? {
      profileId: record.profileId, calls: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0,
    };
    profiles.set(record.profileId, {
      profileId: record.profileId,
      calls: profileEntry.calls + 1,
      inputTokens: profileEntry.inputTokens + record.inputTokens,
      outputTokens: profileEntry.outputTokens + record.outputTokens,
      estimatedCost: Math.round((profileEntry.estimatedCost + cost) * 1_000_000) / 1_000_000,
    });
  }

  const totals = [...days.values()].reduce(
    (acc, entry) => ({
      calls: acc.calls + entry.calls,
      cacheHits: acc.cacheHits + entry.cacheHits,
      inputTokens: acc.inputTokens + entry.inputTokens,
      outputTokens: acc.outputTokens + entry.outputTokens,
      estimatedCost: Math.round((acc.estimatedCost + entry.estimatedCost) * 1_000_000) / 1_000_000,
      firstAt: acc.firstAt === '' || entry.firstAt < acc.firstAt ? entry.firstAt : acc.firstAt,
      lastAt: entry.lastAt > acc.lastAt ? entry.lastAt : acc.lastAt,
    }),
    { calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, firstAt: '', lastAt: '' },
  );

  return {
    days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
    byProfile: [...profiles.values()].sort((a, b) => b.calls - a.calls),
    totals,
  };
}

// ---------------------------------------------------------------------------
// 文章库 / 管理后台（2026-11-03）
// ---------------------------------------------------------------------------

export interface ArticleRowV1 {
  readonly schemaVersion: 1;
  readonly rawPath: string;
  readonly title: string;
  readonly sourceKey: string;
  readonly state: string;
  readonly charCount: number;
  readonly updatedAt: string;
  readonly triage: { readonly status: string; readonly score: number; readonly judgments: number } | null;
}

export interface ArticleListOptions {
  readonly state?: string;
  readonly group?: string;
  readonly source?: string;
  readonly days?: number;
  readonly triage?: string;
  readonly sort?: 'updated' | 'judgments' | 'chars' | 'title';
  readonly query?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export const ARTICLE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  all: [],
  queue: ['queued', 'ingested', 'triaged'],
  review: ['draft_ready', 'in_review'],
  committed: ['committed'],
  deferred: ['deferred', 'rejected'],
  error: ['failed', 'blocked', 'rolled_back', 'expired', 'abandoned', 'quarantined'],
};

export interface ArticleListV1 {
  readonly items: readonly ArticleRowV1[];
  readonly total: number;
  readonly page: number;
  readonly pages: number;
  readonly pageSize: number;
  readonly states: readonly string[];
  readonly state: string;
  readonly query: string;
  readonly group: string;
  readonly source: string;
  readonly days: number;
  readonly triage: string;
  readonly sort: string;
  readonly groupCounts: Readonly<Record<string, number>>;
  readonly sources: readonly string[];
}

function triageOfState(state: { readonly kind: string } & Record<string, unknown>): { status: string; score: number; judgments: number } | null {
  const triage = (state as { triage?: { status?: string; score?: number; judgments?: number } }).triage;
  if (!triage || typeof triage.status !== 'string') return null;
  return { status: triage.status, score: triage.score ?? 0, judgments: triage.judgments ?? 0 };
}

export async function listArticles(ctx: AppContext, options: ArticleListOptions = {}): Promise<ArticleListV1> {
  const all = await ctx.store.transaction(async (tx) => tx.rawItems.listAll());
  const states = [...new Set(all.map((item) => item.state.kind))].sort();
  const state = options.state && options.state !== '' ? options.state : 'all';
  const query = (options.query ?? '').trim();

  let filtered = all;
  if (options.group && options.group !== 'all') {
    const kinds = ARTICLE_GROUPS[options.group] ?? [];
    if (kinds.length > 0) filtered = filtered.filter((item) => kinds.includes(item.state.kind));
  }
  if (state !== 'all') filtered = filtered.filter((item) => item.state.kind === state);
  if (options.source && options.source !== 'all') filtered = filtered.filter((item) => item.sourceKey === options.source);
  if (options.days && options.days > 0) {
    const cutoff = Date.parse(ctx.clock.now()) - options.days * 86_400_000;
    filtered = filtered.filter((item) => Date.parse(item.updatedAt) >= cutoff);
  }
  if (options.triage && options.triage !== 'all') {
    filtered = filtered.filter((item) => triageOfState(item.state as never)?.status === options.triage);
  }
  if (query !== '') {
    const needle = query.toLowerCase();
    filtered = filtered.filter(
      (item) => item.title.toLowerCase().includes(needle) || String(item.rawPath).toLowerCase().includes(needle),
    );
  }
  const sort = options.sort ?? 'updated';
  filtered = [...filtered].sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title, 'zh');
    if (sort === 'chars') return b.charCount - a.charCount;
    if (sort === 'judgments') {
      return (triageOfState(b.state as never)?.judgments ?? 0) - (triageOfState(a.state as never)?.judgments ?? 0);
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  const pageSize = Math.min(200, Math.max(10, options.pageSize ?? 50));
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Math.trunc(options.page ?? 1)));

  const groupCounts: Record<string, number> = {};
  for (const [group, kinds] of Object.entries(ARTICLE_GROUPS)) {
    groupCounts[group] = group === 'all' ? all.length : all.filter((item) => kinds.includes(item.state.kind)).length;
  }
  const sources = [...new Set(all.map((item) => item.sourceKey))].sort();

  const items = filtered.slice((page - 1) * pageSize, page * pageSize).map((item): ArticleRowV1 => ({
    schemaVersion: 1,
    rawPath: String(item.rawPath),
    title: item.title,
    sourceKey: item.sourceKey,
    state: item.state.kind,
    charCount: item.charCount,
    updatedAt: item.updatedAt,
    triage: triageOfState(item.state as never),
  }));

  return { items, total, page, pages, pageSize, states, state, query, group: options.group ?? 'all', source: options.source ?? 'all', days: options.days ?? 0, triage: options.triage ?? 'all', sort, groupCounts, sources };
}

export interface ArticleDetailV1 {
  readonly schemaVersion: 1;
  readonly rawPath: string;
  readonly title: string;
  readonly sourceKey: string;
  readonly state: string;
  readonly charCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly triage: { readonly status: string; readonly score: number; readonly judgments: number; readonly reasons: readonly string[] } | null;
  readonly commitSha: string | null;
  readonly timeline: readonly { readonly at: string; readonly type: string }[];
  readonly draft: {
    readonly id: string;
    readonly status: string;
    readonly tier: string;
    readonly rationale: string;
    readonly provider: string;
    readonly model: string;
    readonly promptVersion: number;
    readonly claims: readonly { readonly text: string; readonly inference: boolean; readonly source: string }[];
    readonly nodes: readonly { readonly name: string; readonly nodeType: string; readonly action: string; readonly claimIndexes: readonly number[] }[];
    readonly findings: readonly { readonly code: string; readonly severity: string; readonly message: string }[];
  } | null;
}

export async function articleDetail(ctx: AppContext, rawPathInput: string): Promise<ArticleDetailV1 | null> {
  const parsed = parseRawPath(rawPathInput);
  if (!parsed.ok) return null;
  const item = await ctx.store.transaction(async (tx) => tx.rawItems.getByPath(parsed.value));
  if (!item) return null;

  const state = item.state as { kind: string; draftId?: string; commitSha?: string; triage?: never };
  const triage = triageOfState(item.state as never);
  const rawTriage = (item.state as { triage?: { reasons?: readonly string[] } }).triage;

  let draft: ArticleDetailV1['draft'] = null;
  if (typeof state.draftId === 'string') {
    const record = await ctx.store.transaction(async (tx) => tx.drafts.get(mustDraftId(state.draftId as string)));
    if (record) {
      draft = {
        id: record.id,
        status: record.status,
        tier: record.proposal.tier,
        rationale: record.proposal.rationale,
        provider: record.provider,
        model: record.model,
        promptVersion: record.promptVersion,
        claims: record.proposal.claims.map((claim) => ({ text: claim.text, inference: claim.inference, source: claim.source })),
        nodes: record.proposal.nodes.map((node) => ({
          name: node.name, nodeType: node.nodeType, action: node.action, claimIndexes: node.claimIndexes,
        })),
        findings: record.findings.map((finding) => ({ code: finding.code, severity: finding.severity, message: finding.message })),
      };
    }
  }

  const events = await ctx.store.transaction(async (tx) => tx.events.listSince(0));
  const timeline = events
    .filter((event) => String(event.aggregateId) === String(item.rawPath))
    .slice(-20)
    .map((event) => ({ at: event.at, type: event.type }));

  return {
    schemaVersion: 1,
    rawPath: String(item.rawPath),
    title: item.title,
    sourceKey: item.sourceKey,
    state: item.state.kind,
    charCount: item.charCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    triage: triage
      ? { ...triage, reasons: rawTriage?.reasons ?? [] }
      : null,
    commitSha: typeof state.commitSha === 'string' ? state.commitSha : null,
    timeline,
    draft,
  };
}

function mustDraftId(value: string): ReturnType<typeof parseDraftId> extends { ok: true; value: infer V } ? V : never {
  const parsed = parseDraftId(value);
  if (!parsed.ok) throw new AppError('NOT_FOUND', parsed.error.message);
  return parsed.value as never;
}

export interface AdminTodayV1 {
  readonly day: string;
  readonly drafted: number;
  readonly committed: number;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCost: number;
  readonly ratePerHour: number | null;
  readonly etaHours: number | null;
}

export interface AdminSummaryV1 {
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
  readonly drafts: Readonly<Record<string, number>>;
  readonly queueRemaining: number;
  readonly today: AdminTodayV1;
  readonly usage: UsageSummary;
  readonly env: { readonly mode: string; readonly dataDir: string; readonly vaultRoot: string };
  readonly recentEvents: readonly { readonly at: string; readonly type: string; readonly aggregateId: string }[];
}

export async function adminSummary(
  ctx: AppContext,
  env: { readonly mode: string; readonly dataDir: string; readonly vaultRoot: string },
): Promise<AdminSummaryV1> {
  const all = await ctx.store.transaction(async (tx) => tx.rawItems.listAll());
  const counts: Record<string, number> = {};
  for (const item of all) counts[item.state.kind] = (counts[item.state.kind] ?? 0) + 1;

  const drafts: Record<string, number> = {};
  for (const status of ['pending', 'approved', 'rejected'] as const) {
    drafts[status] = (await ctx.store.transaction(async (tx) => tx.drafts.listByStatus(status))).length;
  }

  const usage = await usageSummary(ctx);
  const events = await ctx.store.transaction(async (tx) => tx.events.listSince(0));
  const recentEvents = events.slice(-10).reverse().map((event) => ({
    at: event.at, type: event.type, aggregateId: String(event.aggregateId),
  }));

  const today = ctx.clock.now().slice(0, 10);
  const draftRecords = (await Promise.all(
    (['pending', 'approved', 'rejected'] as const).map(async (status) =>
      ctx.store.transaction(async (tx) => tx.drafts.listByStatus(status))),
  )).flat();
  const draftedToday = draftRecords.filter((draft) => draft.createdAt.slice(0, 10) === today).length;
  const committedToday = all.filter(
    (item) => item.state.kind === 'committed' && item.updatedAt.slice(0, 10) === today,
  ).length;
  const dayEntry = usage.days.find((entry) => entry.day === today);
  const firstAt = usage.totals.firstAt;
  const lastAt = usage.totals.lastAt;
  const hours = firstAt !== '' && lastAt !== ''
    ? Math.max((Date.parse(lastAt) - Date.parse(firstAt)) / 3_600_000, 1 / 60)
    : 0;
  const ratePerHour = hours > 0 ? usage.totals.calls / hours : null;
  const queueRemaining = counts.queued ?? 0;

  return {
    counts,
    total: all.length,
    drafts,
    queueRemaining,
    today: {
      day: today,
      drafted: draftedToday,
      committed: committedToday,
      calls: dayEntry?.calls ?? 0,
      inputTokens: dayEntry?.inputTokens ?? 0,
      outputTokens: dayEntry?.outputTokens ?? 0,
      estimatedCost: dayEntry?.estimatedCost ?? 0,
      ratePerHour,
      etaHours: ratePerHour && ratePerHour > 0 ? queueRemaining / ratePerHour : null,
    },
    usage,
    env,
    recentEvents,
  };
}


export interface OverviewV1 {
  readonly pendingDrafts: number;
  readonly queued: number;
  readonly draftReady: number;
  readonly committed: number;
  readonly version: string;
}

/** 轻量轮询接口：给前端 5 秒一次，版本变化才提示刷新。 */
export async function overview(ctx: AppContext): Promise<OverviewV1> {
  const all = await ctx.store.transaction(async (tx) => tx.rawItems.listAll());
  const counts: Record<string, number> = {};
  for (const item of all) counts[item.state.kind] = (counts[item.state.kind] ?? 0) + 1;
  const pending = (await ctx.store.transaction(async (tx) => tx.drafts.listByStatus('pending'))).length;
  const queued = counts.queued ?? 0;
  const draftReady = counts.draft_ready ?? 0;
  const committed = counts.committed ?? 0;
  return { pendingDrafts: pending, queued, draftReady, committed, version: `${pending}/${queued}/${draftReady}/${committed}` };
}


export interface ReviewListItemV1 {
  readonly draftId: string;
  readonly title: string;
  readonly rawPath: string;
  readonly tier: string;
  readonly rationale: string;
  readonly hasBlock: boolean;
  readonly createdAt: string;
}

export async function pendingReviewList(ctx: AppContext): Promise<readonly ReviewListItemV1[]> {
  const drafts = await ctx.store.transaction(async (tx) => tx.drafts.listByStatus('pending'));
  const items = await ctx.store.transaction(async (tx) => tx.rawItems.listAll());
  const byId = new Map(items.map((item) => [item.id, item]));
  return drafts.map((draft) => {
    const item = byId.get(draft.rawItemId);
    return {
      draftId: draft.id,
      title: item?.title ?? draft.id,
      rawPath: String(item?.rawPath ?? ''),
      tier: draft.proposal.tier,
      rationale: draft.proposal.rationale,
      hasBlock: draft.findings.some((finding) => finding.severity === 'block'),
      createdAt: draft.createdAt,
    };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}


export interface ClaimRowV1 {
  readonly draftId: string;
  readonly text: string;
  readonly inference: boolean;
  readonly source: string;
}

/** 已入库草稿的 claims（用于全局查看） */
export async function committedClaims(ctx: AppContext, limit = 500): Promise<readonly ClaimRowV1[]> {
  const drafts = await ctx.store.transaction(async (tx) => tx.drafts.listByStatus('approved'));
  const rows: ClaimRowV1[] = [];
  for (const draft of drafts) {
    for (const claim of draft.proposal.claims) {
      rows.push({ draftId: draft.id, text: claim.text, inference: claim.inference, source: claim.source });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}


/** 从 wiki 节点 Markdown 反向解析 claims（已入库知识）。 */
export async function wikiClaims(ctx: AppContext, limit = 2000): Promise<readonly ClaimRowV1[]> {
  const files = await ctx.vault.listNodes();
  const rows: ClaimRowV1[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await ctx.vault.readNode(file);
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.startsWith('- ')) continue;
      const match = line.match(/^- (.+?)（来源：\[\[(raw\/[^\]]+)\]\]/);
      if (!match) continue;
      rows.push({ draftId: file, text: match[1] as string, inference: line.includes('（推断）'), source: match[2] as string });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}


export interface WikiNodeRowV1 {
  readonly name: string;
  readonly file: string;
  readonly nodeType: string;
  readonly aliases: readonly string[];
  readonly updatedAt: string;
  readonly claimCount: number;
  readonly sourceCount: number;
}

function claimLines(body: string): { text: string; source: string }[] {
  const rows: { text: string; source: string }[] = [];
  for (const line of body.split('\n')) {
    const match = line.match(/^- (.+?)（来源：\[\[(raw\/[^\]]+)\]\]/);
    if (match) rows.push({ text: match[1] as string, source: match[2] as string });
  }
  return rows;
}

export async function listWikiNodes(
  ctx: AppContext,
  options: { readonly type?: string; readonly q?: string } = {},
): Promise<readonly WikiNodeRowV1[]> {
  const docs = ctx.search.allDocs();
  const type = options.type && options.type !== 'all' ? options.type : 'all';
  const q = (options.q ?? '').toLowerCase();
  const rows: WikiNodeRowV1[] = [];
  for (const doc of docs) {
    if (type !== 'all' && doc.nodeType !== type) continue;
    if (q !== '' && !doc.name.toLowerCase().includes(q)) continue;
    const claims = claimLines(doc.body);
    rows.push({
      name: doc.name,
      file: doc.file,
      nodeType: doc.nodeType,
      aliases: doc.aliases,
      updatedAt: doc.updatedAt,
      claimCount: claims.length,
      sourceCount: new Set(claims.map((claim) => claim.source)).size,
    });
  }
  return rows.sort((a, b) => b.claimCount - a.claimCount);
}

export interface WikiNodeDetailV1 {
  readonly name: string;
  readonly file: string;
  readonly nodeType: string;
  readonly aliases: readonly string[];
  readonly definition: string;
  readonly claims: readonly { text: string; source: string }[];
  readonly related: readonly string[];
}

export async function wikiNodeDetail(ctx: AppContext, fileInput: string): Promise<WikiNodeDetailV1 | null> {
  const doc = ctx.search.allDocs().find((entry) => entry.file === fileInput);
  if (!doc) return null;
  const definitionMatch = doc.body.match(/## 一句话定义\n+([\s\S]*?)(?=\n## |$)/);
  const relatedSection = doc.body.match(/## 相关概念\n+([\s\S]*?)$/);
  const related = relatedSection
    ? [...(relatedSection[1] as string).matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1] as string)
    : [];
  return {
    name: doc.name,
    file: doc.file,
    nodeType: doc.nodeType,
    aliases: doc.aliases,
    definition: (definitionMatch?.[1] ?? '').trim(),
    claims: claimLines(doc.body),
    related,
  };
}
