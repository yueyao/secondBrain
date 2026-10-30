/** 应用层用例：triage / digest / review / commit。只通过端口操作，不直接碰文件或数据库。 */
import {
  countJudgmentSentences,
  decideTriage,
  evaluateAll,
  firstHeading,
  hasBlock,
  parseFrontmatter,
  parseRawPath,
  transition,
  type DraftId,
  type DraftProposal,
  type Finding,
  type RawPath,
  type RawState,
  type Result,
} from '@sb/domain';
import type { DraftRecord, RawItemRecord, ScoredHit } from '@sb/contracts';
import { AppError, type AppContext } from './context';
import { nodeFile, renderNewNode, renderPatchedNode } from './render';

export interface TriageOutcome {
  readonly rawPath: string;
  readonly state: string;
  readonly reason?: string;
}

function unwrap<T>(result: Result<T, { code: string; message: string }>): T {
  if (!result.ok) throw new AppError('INVALID_STATE', result.error.message, { code: result.error.code });
  return result.value;
}

function deriveSource(rawPath: string): string {
  const match = rawPath.match(/^raw\/(?:[^/]+\/)?([^/]+)\//);
  return match?.[1] ?? 'general';
}

/** 扫描 raw/，把未纳管的原文摄取并分档（幂等）。 */
export async function ingestAndTriage(ctx: AppContext): Promise<readonly TriageOutcome[]> {
  const now = ctx.clock.now();
  const raws = await ctx.vault.listRaw();
  const outcomes: TriageOutcome[] = [];

  for (const ref of raws) {
    const existing = await ctx.store.transaction(async (tx) => tx.rawItems.getByPath(ref.path));
    if (existing) {
      outcomes.push({ rawPath: String(ref.path), state: existing.state.kind });
      continue;
    }

    const content = await ctx.vault.readRaw(ref.path);
    const { data, body } = parseFrontmatter(content);
    const sourceKey = deriveSource(String(ref.path));
    const title =
      typeof data.title === 'string' ? data.title : (firstHeading(body) ?? String(ref.path).split('/').pop() ?? '未命名');

    const base: RawItemRecord = {
      id: 0,
      rawPath: ref.path,
      contentHash: ref.contentHash,
      sourceKey,
      eventId: typeof data.event_id === 'string' ? data.event_id : null,
      title,
      charCount: content.length,
      state: { kind: 'ingested' },
      version: 0,
      createdAt: now,
      updatedAt: now,
    };

    const tctx = { now };
    let state: RawState = { kind: 'ingested' };
    state = unwrap(transition(state, { type: 'INGESTED' }, tctx));

    let reason: string | undefined;
    if (base.charCount > ctx.config.longTextThreshold) {
      state = unwrap(transition(state, { type: 'TRIAGE_LONG', charCount: base.charCount }, tctx));
      reason = 'too_long';
    } else if (!ctx.config.enabledSources.includes(sourceKey)) {
      state = unwrap(transition(state, { type: 'TRIAGE_SCOPE', sourceKey }, tctx));
      reason = 'source_disabled';
    } else {
      const triage = decideTriage({ judgments: countJudgmentSentences(body), charCount: base.charCount });
      state =
        triage.status === 'low'
          ? unwrap(transition(state, { type: 'TRIAGE_LOW', triage }, tctx))
          : unwrap(transition(state, { type: 'TRIAGE_QUEUED', triage }, tctx));
      if (triage.status === 'low') reason = 'low_value';
    }

    const record: RawItemRecord = { ...base, state, updatedAt: now };
    await ctx.store.transaction(async (tx) => {
      await tx.rawItems.upsert(record);
      await tx.events.append({
        at: now,
        actor: 'system',
        type: 'triaged',
        aggregateId: String(ref.path),
        payload: { state: state.kind, sourceKey },
      });
    });
    outcomes.push({ rawPath: String(ref.path), state: state.kind, ...(reason ? { reason } : {}) });
  }

  return outcomes;
}

export interface DraftResult {
  readonly draftId: DraftId;
  readonly findings: readonly Finding[];
  readonly proposal: DraftProposal;
}

/** 起草：检索 → agent 提议 → 规则评估 → 存草稿。不写 wiki。 */
export async function draftDigest(ctx: AppContext, rawPath: RawPath): Promise<DraftResult> {
  const now = ctx.clock.now();
  const item = await ctx.store.transaction(async (tx) => tx.rawItems.getByPath(rawPath));
  if (!item) throw new AppError('NOT_FOUND', `未纳管的原文：${rawPath}`);
  if (item.state.kind !== 'queued') {
    throw new AppError('INVALID_STATE', `当前状态 ${item.state.kind}，只有 queued 可起草`, { state: item.state.kind });
  }

  const content = await ctx.vault.readRaw(rawPath);
  const { data } = parseFrontmatter(content);
  const hint = typeof data.node_hint === 'string' ? data.node_hint : null;
  const queries = [...new Set([item.title, ...(hint ? [hint] : [])])];
  const hitMap = new Map<string, ScoredHit>();
  for (const query of queries) {
    for (const hit of await ctx.search.query(query)) hitMap.set(hit.file, hit);
  }
  const hits = [...hitMap.values()];
  const proposal = await ctx.agent.draft({
    rawPath,
    content,
    retrieved: hits,
    tools: ['search_wiki', 'read_node', 'read_raw'],
    budget: { maxInputTokens: 40_000, maxOutputTokens: 4_000, maxToolCalls: 6 },
  });

  const allItems = await ctx.store.transaction(async (tx) => tx.rawItems.listAll());
  const knownRawPaths = new Set((await ctx.vault.listRaw()).map((ref) => String(ref.path)));
  const existingNodes = ctx.search.allDocs().map((doc) => ({
    name: doc.name,
    aliases: doc.aliases,
    nodeType: doc.nodeType,
    file: doc.file,
  }));

  const findings = evaluateAll({
    rawPath: String(rawPath),
    eventId: item.eventId,
    sourceKey: item.sourceKey,
    enabledSources: ctx.config.enabledSources,
    charCount: item.charCount,
    longTextThreshold: ctx.config.longTextThreshold,
    tier: proposal.tier,
    claims: proposal.claims,
    nodes: proposal.nodes,
    existingNodes,
    items: allItems.map((entry) => ({
      rawPath: String(entry.rawPath),
      eventId: entry.eventId,
      stateKind: entry.state.kind,
    })),
    knownRawPaths,
  });

  const draft: DraftRecord = {
    id: ctx.ids.draftId(),
    rawItemId: item.id,
    proposal,
    findings,
    provider: ctx.agentMeta?.provider ?? 'unknown',
    model: ctx.agentMeta?.model ?? 'unknown',
    promptId: ctx.agentMeta?.promptId ?? 'digest',
    promptVersion: ctx.agentMeta?.promptVersion ?? 1,
    promptSha256: 'n/a',
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    status: 'pending',
    createdAt: now,
  };

  await ctx.store.transaction(async (tx) => {
    const latest = await tx.rawItems.getByPath(rawPath);
    if (!latest) throw new AppError('NOT_FOUND', '原文记录消失');
    const drafting = unwrap(transition(latest.state, { type: 'DRAFT_START', draftId: draft.id }, { now }));
    const ready = unwrap(transition(drafting, { type: 'DRAFT_OK', draftId: draft.id, findings }, { now }));
    const swapped = await tx.rawItems.compareAndSwapVersion(latest.id, latest.version, ready);
    if (!swapped) throw new AppError('INVALID_STATE', '并发冲突：状态已被修改，请重试');
    await tx.drafts.insert(draft);
    await tx.events.append({
      at: now,
      actor: 'agent',
      type: 'drafted',
      aggregateId: String(rawPath),
      payload: { draftId: draft.id, claims: proposal.claims.length },
    });
  });

  return { draftId: draft.id, findings, proposal };
}

export interface DecideResult {
  readonly ok: true;
  readonly state: string;
  readonly commit?: string;
}

/** 人审决策：accept 会写 wiki 并 git commit；reject 只记录。 */
export async function decideReview(
  ctx: AppContext,
  draftId: DraftId,
  action: 'accept' | 'reject',
  input: { readonly actor: string; readonly note?: string },
): Promise<DecideResult> {
  const now = ctx.clock.now();
  const draft = await ctx.store.transaction(async (tx) => tx.drafts.get(draftId));
  if (!draft) throw new AppError('NOT_FOUND', `草稿不存在：${draftId}`);
  if (draft.status !== 'pending') throw new AppError('INVALID_STATE', `草稿状态为 ${draft.status}`);

  return action === 'accept'
    ? acceptDraft(ctx, draftId, draft, now, input)
    : rejectDraft(ctx, draftId, draft, now, input);
}

function itemPath(draft: DraftRecord): RawPath {
  const firstSource = draft.proposal.claims[0]?.source;
  if (!firstSource) throw new AppError('EMPTY_CLAIMS', '草稿没有 claims，无法定位原文');
  return parseRawPathOk(firstSource);
}

function parseRawPathOk(value: string): RawPath {
  const parsed = parseRawPath(value);
  if (!parsed.ok) throw new AppError('NOT_FOUND', parsed.error.message);
  return parsed.value;
}

async function acceptDraft(
  ctx: AppContext,
  draftId: DraftId,
  draft: DraftRecord,
  now: string,
  input: { readonly actor: string; readonly note?: string },
): Promise<DecideResult> {
  if (hasBlock(draft.findings)) {
    throw new AppError('GATE_BLOCKED', '存在阻断级预警，不能入库', {
      rules: draft.findings.filter((finding) => finding.severity === 'block').map((finding) => finding.ruleId),
    });
  }

  const sourcePath = String(itemPath(draft));
  const files: string[] = [];
  const previousHead = await ctx.vault.head();

  try {
    for (const node of draft.proposal.nodes) {
      if (node.action === 'new') {
        const file = nodeFile(node);
        await ctx.vault.writeNode(file, renderNewNode(node, draft.proposal.claims, sourcePath, now.slice(0, 10)));
        files.push(file);
        continue;
      }
      const doc = ctx.search.allDocs().find((entry) => entry.name === node.name);
      if (!doc) throw new AppError('UNKNOWN_NODE', `并入目标不存在：${node.name}`);
      const existing = await ctx.vault.readNode(doc.file);
      await ctx.vault.writeNode(
        doc.file,
        renderPatchedNode(existing, draft.proposal.claims, sourcePath, now.slice(0, 10)),
      );
      files.push(doc.file);
    }

    const commitSha = await ctx.vault.commitFiles(files, `digest: ${sourcePath}`);
    const rawItem = await ctx.store.transaction(async (tx) => tx.rawItems.getByPath(parseRawPathOk(sourcePath)));
    if (!rawItem) throw new AppError('NOT_FOUND', '原文记录消失');

    await ctx.store.transaction(async (tx) => {
      let state = unwrap(transition(rawItem.state, { type: 'REVIEW_OPEN', findings: draft.findings }, { now }));
      state = unwrap(transition(state, { type: 'ACCEPT', actor: input.actor }, { now }));
      state = unwrap(
        transition(state, { type: 'COMMIT_INTENT', intentId: ctx.ids.intentId(), preCommitSha: previousHead }, { now, targetHashesUnchanged: true }),
      );
      state = unwrap(transition(state, { type: 'COMMIT_OK', commitSha }, { now }));
      const swapped = await tx.rawItems.compareAndSwapVersion(rawItem.id, rawItem.version, state);
      if (!swapped) throw new AppError('INVALID_STATE', '并发冲突：状态已被修改');
      await tx.drafts.setStatus(draftId, 'approved');
      await tx.decisions.append({
        draftId, action: 'accept', note: input.note ?? null, actor: input.actor, createdAt: now,
      });
      await tx.commits.append({ draftId, gitSha: commitSha, files, createdAt: now });
      await tx.events.append({
        at: now, actor: input.actor, type: 'committed', aggregateId: sourcePath, payload: { draftId, commitSha },
      });
    });

    return { ok: true, state: 'committed', commit: commitSha };
  } catch (error) {
    if (previousHead) await ctx.vault.resetHard(previousHead).catch(() => undefined);
    throw error;
  }
}

async function rejectDraft(
  ctx: AppContext,
  draftId: DraftId,
  draft: DraftRecord,
  now: string,
  input: { readonly actor: string; readonly note?: string },
): Promise<DecideResult> {
  const rawPath = itemPath(draft);
  const rawItem = await ctx.store.transaction(async (tx) => tx.rawItems.getByPath(rawPath));
  if (!rawItem) throw new AppError('NOT_FOUND', '原文记录消失');

  await ctx.store.transaction(async (tx) => {
    let state = rawItem.state;
    if (state.kind === 'draft_ready') {
      state = unwrap(transition(state, { type: 'REVIEW_OPEN', findings: draft.findings }, { now }));
    }
    state = unwrap(transition(state, { type: 'REJECT', reason: input.note ?? '未填写理由' }, { now }));
    const swapped = await tx.rawItems.compareAndSwapVersion(rawItem.id, rawItem.version, state);
    if (!swapped) throw new AppError('INVALID_STATE', '并发冲突：状态已被修改');
    await tx.drafts.setStatus(draftId, 'rejected');
    await tx.decisions.append({
      draftId, action: 'reject', note: input.note ?? null, actor: input.actor, createdAt: now,
    });
    await tx.events.append({
      at: now, actor: input.actor, type: 'rejected', aggregateId: String(rawPath), payload: { draftId, note: input.note ?? null },
    });
  });

  return { ok: true, state: 'rejected' };
}
