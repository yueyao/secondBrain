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
  type CommitSha,
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
  const sensitivity = item.sourceKey === 'dedao' || item.sourceKey === 'podcast' ? 'restricted' : 'public';
  const outcome = await ctx.agent.draft({
    rawPath,
    content,
    sensitivity,
    retrieved: hits,
    tools: ['search_wiki', 'read_node', 'read_raw'],
    budget: { maxInputTokens: 40_000, maxOutputTokens: 4_000, maxToolCalls: 6 },
  });
  const proposal = outcome.proposal;

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

  const targetHashes: Record<string, string> = {};
  for (const node of proposal.nodes) {
    if (node.action !== 'patch') continue;
    const doc = existingNodes.find((entry) => entry.name === node.name);
    if (!doc) continue;
    targetHashes[doc.file] = ctx.hash.sha256(await ctx.vault.readNode(doc.file));
  }

  const draft: DraftRecord = {
    id: ctx.ids.draftId(),
    targetHashes,
    rawItemId: item.id,
    proposal,
    findings,
    provider: outcome.provenance.provider,
    model: outcome.provenance.model,
    promptId: outcome.provenance.promptId,
    promptVersion: outcome.provenance.promptVersion,
    promptSha256: outcome.provenance.promptSha256,
    inputTokens: outcome.provenance.inputTokens,
    outputTokens: outcome.provenance.outputTokens,
    latencyMs: outcome.provenance.latencyMs,
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
    await tx.usage.append({
      at: now,
      rawPath,
      draftId: draft.id,
      profileId: outcome.provenance.profileId,
      provider: outcome.provenance.provider,
      model: outcome.provenance.model,
      inputTokens: outcome.provenance.inputTokens ?? 0,
      outputTokens: outcome.provenance.outputTokens ?? 0,
      latencyMs: outcome.provenance.latencyMs,
      cacheHit: outcome.provenance.cacheHit,
    });
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

/**
 * 人审决策：
 * - accept：先把状态落成 approved（durable），再执行幂等的 commitApproved；
 * - reject：只记录，不碰文件。
 */
export async function decideReview(
  ctx: AppContext,
  draftId: DraftId,
  action: 'accept' | 'reject',
  input: { readonly actor: string; readonly note?: string },
): Promise<DecideResult> {
  const now = ctx.clock.now();
  const draft = await ctx.store.transaction(async (tx) => tx.drafts.get(draftId));
  if (!draft) throw new AppError('NOT_FOUND', `草稿不存在：${draftId}`);

  // 之前已批准但未完成提交（崩溃/中断）：直接重放提交
  if (draft.status === 'approved') return commitApproved(ctx, draftId);
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

/** 阶段一：把条目落成 approved（幂等；此后即使崩溃也能重放）。 */
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

  const rawPath = itemPath(draft);
  await ctx.store.transaction(async (tx) => {
    const item = await tx.rawItems.getByPath(rawPath);
    if (!item) throw new AppError('NOT_FOUND', '原文记录消失');
    if (item.state.kind === 'committed') return;
    if (item.state.kind !== 'draft_ready' && item.state.kind !== 'in_review') {
      throw new AppError('INVALID_STATE', `条目状态 ${item.state.kind}，无法批准`);
    }
    let state: RawState = item.state;
    if (state.kind === 'draft_ready') {
      state = unwrap(transition(state, { type: 'REVIEW_OPEN', findings: draft.findings }, { now }));
    }
    state = unwrap(transition(state, { type: 'ACCEPT', actor: input.actor }, { now }));
    const swapped = await tx.rawItems.compareAndSwapVersion(item.id, item.version, state);
    if (!swapped) throw new AppError('INVALID_STATE', '并发冲突：状态已被修改');
    await tx.drafts.setStatus(draftId, 'approved');
    await tx.decisions.append({
      draftId, action: 'accept', note: input.note ?? null, actor: input.actor, createdAt: now,
    });
    await tx.events.append({
      at: now, actor: input.actor, type: 'approved', aggregateId: String(rawPath), payload: { draftId },
    });
  });

  return commitApproved(ctx, draftId);
}

/**
 * 阶段二：写入 wiki 并提交（幂等）。
 * 可被 accept 调用，也可被启动恢复调用；重复执行不会产生重复 claim 或重复 commit。
 */
export async function commitApproved(ctx: AppContext, draftId: DraftId): Promise<DecideResult> {
  const now = ctx.clock.now();
  const draft = await ctx.store.transaction(async (tx) => tx.drafts.get(draftId));
  if (!draft) throw new AppError('NOT_FOUND', `草稿不存在：${draftId}`);
  if (draft.status !== 'approved') throw new AppError('INVALID_STATE', `草稿状态为 ${draft.status}，无法提交`);

  const sourcePath = String(itemPath(draft));
  const rawPath = parseRawPathOk(sourcePath);
  const item = await ctx.store.transaction(async (tx) => tx.rawItems.getByPath(rawPath));
  if (!item) throw new AppError('NOT_FOUND', '原文记录消失');
  if (item.state.kind === 'committed') {
    const head = await ctx.vault.head();
    return { ok: true, state: 'committed', ...(head ? { commit: head } : {}) };
  }
  if (item.state.kind !== 'approved' && item.state.kind !== 'committing') {
    throw new AppError('INVALID_STATE', `条目状态 ${item.state.kind}，无法提交`);
  }

  // P7.1 同步守卫：远端有新提交时拒绝写入（fail closed）
  await ctx.vault.fetch();
  const behind = await ctx.vault.remoteBehind();
  if (behind > 0) {
    throw new AppError('OUT_OF_SYNC', `vault 远端有 ${behind} 个新提交，请先 git pull 再入库`, { behind });
  }

  const today = now.slice(0, 10);
  const previousHead = await ctx.vault.head();
  const allFiles = [...new Set(
    draft.proposal.nodes.map((node) => (node.action === 'new' ? nodeFile(node) : targetFile(ctx, node.name))),
  )];
  let commitSha: CommitSha;
  let wroteAny = false;

  try {
    const writes: Array<{ file: string; content: string }> = [];
    for (const node of draft.proposal.nodes) {
      const file = node.action === 'new' ? nodeFile(node) : targetFile(ctx, node.name);
      const existing = await readNodeOrNull(ctx, file);
      const nodeClaims = claimsForNode(node, draft.proposal.claims);
      const content = node.action === 'new'
        ? renderNewNode(node, nodeClaims, sourcePath, today)
        : renderPatchedNode(existing ?? '', nodeClaims, sourcePath, today);

      if (existing === content) continue; // 已写完
      // 崩溃重放：上一次已经把这些 claim 写进去了，跳过硬性重渲染（避免重复追加）
      if (node.action === 'patch' && claimsApplied(existing, draft.proposal.claims)) continue;
      if (existing !== null) {
        const baseline = draft.targetHashes[file];
        if (!baseline) throw new AppError('TARGET_MOVED', `缺少目标文件基线，拒绝覆盖：${file}`);
        if (ctx.hash.sha256(existing) !== baseline) {
          throw new AppError('TARGET_MOVED', `目标文件在起草后被修改，拒绝覆盖：${file}`);
        }
      }
      writes.push({ file, content });
    }

    for (const write of writes) await ctx.vault.writeNode(write.file, write.content);
    wroteAny = writes.length > 0;
    try {
      commitSha = await ctx.vault.commitFiles(allFiles, `digest: ${sourcePath} [${draft.id}]`);
    } catch (error) {
      // 幂等：内容已经提交过（崩溃后重放）→ 识别 draftId 并认为已完成
      const message = await ctx.vault.lastCommitMessage().catch(() => null);
      if (!message || !message.includes(`[${draft.id}]`)) throw error;
      const head = await ctx.vault.head();
      if (!head) throw error;
      commitSha = head;
    }
  } catch (error) {
    // 只有真的写过文件才回滚；TARGET_MOVED 发生在写入前，不能误删外部改动
    if (wroteAny && previousHead) await ctx.vault.resetHard(previousHead).catch(() => undefined);
    await markRolledBack(ctx, draft, now, error);
    throw error;
  }

  const latest = await ctx.store.transaction(async (tx) => tx.rawItems.getByPath(rawPath));
  if (!latest) throw new AppError('NOT_FOUND', '原文记录消失');
  await ctx.store.transaction(async (tx) => {
    let state: RawState = latest.state;
    if (state.kind === 'approved') {
      state = unwrap(transition(
        state,
        { type: 'COMMIT_INTENT', intentId: ctx.ids.intentId(), preCommitSha: previousHead },
        { now, targetHashesUnchanged: true },
      ));
    }
    state = unwrap(transition(state, { type: 'COMMIT_OK', commitSha }, { now }));
    const swapped = await tx.rawItems.compareAndSwapVersion(latest.id, latest.version, state);
    if (!swapped) throw new AppError('INVALID_STATE', '并发冲突：状态已被修改');
    await tx.commits.append({ draftId, gitSha: commitSha, files: allFiles, createdAt: now });
    await tx.events.append({
      at: now, actor: 'system', type: 'committed', aggregateId: sourcePath,
      payload: { draftId, commitSha, recovered: !wroteAny },
    });
  });

  return { ok: true, state: 'committed', commit: commitSha };
}

/**
 * 启动恢复（简化版 P5）：把 approved 但未完成的草稿重放一次。
 * 规则：幂等重放；失败则回滚并标 rolled_back；仍有脏改动 → 拒绝启动。
 */
export interface RecoveryReport {
  readonly recovered: readonly DraftId[];
  readonly failed: readonly { readonly draftId: DraftId; readonly error: string }[];
}

export async function recoverPending(ctx: AppContext): Promise<RecoveryReport> {
  const drafts = await ctx.store.transaction(async (tx) => tx.drafts.listByStatus('approved'));
  const recovered: DraftId[] = [];
  const failed: Array<{ draftId: DraftId; error: string }> = [];

  for (const draft of drafts) {
    try {
      await commitApproved(ctx, draft.id);
      recovered.push(draft.id);
    } catch (error) {
      failed.push({ draftId: draft.id, error: String((error as Error).message) });
    }
  }

  if (!(await ctx.vault.isClean())) {
    throw new AppError('DIRTY_VAULT', 'vault 存在未提交改动（可能来自崩溃或外部修改），拒绝启动，请人工确认后执行 git checkout -- .', {
      recovered: recovered.length,
      failed: failed.length,
    });
  }

  return { recovered, failed };
}

async function markRolledBack(ctx: AppContext, draft: DraftRecord, now: string, error: unknown): Promise<void> {
  try {
    const rawPath = itemPath(draft);
    await ctx.store.transaction(async (tx) => {
      const latest = await tx.rawItems.getByPath(rawPath);
      if (!latest || latest.state.kind === 'committed') return;
      let state: RawState = latest.state;
      if (state.kind === 'approved') {
        state = unwrap(transition(state, {
          type: 'COMMIT_INTENT', intentId: ctx.ids.intentId(), preCommitSha: null,
        }, { now, targetHashesUnchanged: true }));
      }
      if (state.kind !== 'committing') return;
      state = unwrap(transition(state, {
        type: 'COMMIT_FAIL', reason: String((error as Error).message ?? error), attempts: 1,
      }, { now }));
      const swapped = await tx.rawItems.compareAndSwapVersion(latest.id, latest.version, state);
      if (!swapped) return;
      await tx.drafts.setStatus(draft.id, 'pending');
      await tx.events.append({
        at: now, actor: 'system', type: 'rolled_back', aggregateId: String(rawPath),
        payload: { draftId: draft.id, error: String((error as Error).message ?? error) },
      });
    });
  } catch {
    // 恢复路径本身不抛：失败留给下一次启动或人工
  }
}

function claimsApplied(existing: string | null, claims: readonly { text: string }[]): boolean {
  if (!existing || claims.length === 0) return false;
  return claims.every((claim) => existing.includes(claim.text));
}

function claimsForNode(node: { readonly claimIndexes: readonly number[] }, claims: DraftProposal['claims']): DraftProposal['claims'] {
  if (node.claimIndexes.length === 0) return claims;
  const picked = node.claimIndexes.flatMap((index) => (claims[index] ? [claims[index]] : []));
  return picked.length > 0 ? picked : claims;
}

function targetFile(ctx: AppContext, name: string): string {
  const doc = ctx.search.allDocs().find((entry) => entry.name === name);
  if (!doc) throw new AppError('UNKNOWN_NODE', `并入目标不存在：${name}`);
  return doc.file;
}

async function readNodeOrNull(ctx: AppContext, file: string): Promise<string | null> {
  try {
    return await ctx.vault.readNode(file);
  } catch {
    return null;
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
