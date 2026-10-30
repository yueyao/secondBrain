/** 查询：给 CLI / UI 用的读模型（ReviewViewV1 / QueueItemV1）。 */
import type { QueueItemV1, ReviewViewV1 } from '@sb/contracts';
import { parseRawPath, type DraftId, type RawPath, type TriageResult } from '@sb/domain';
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
