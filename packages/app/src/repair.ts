/**
 * 存量草稿修复：按当前节点与当前配额重算 pending 草稿的 proposal / findings / targetHashes。
 *
 * 只做结构化修复，不做事实判断：
 * - new ↔ patch 与现有节点对齐（同名已存在→patch；patch 目标不存在→new）；
 * - claims 超过档位上限时自动换到能容纳的档位；
 * - patches 的目标基线重算为当前文件 hash（因为 `new→patch` 会新增目标）。
 *
 * 不改 claims 内容、不改来源、不改状态；修复后仍受门禁约束。
 */
import { evaluateAll, fitTierForClaims } from '@sb/domain';
import type { AppContext } from './context';
import { effectiveBlockingFindings } from './review-policy';

export interface RepairReport {
  readonly examined: number;
  readonly repaired: number;
  readonly stillBlocked: number;
  readonly remainingByRule: Readonly<Record<string, number>>;
  readonly failures: readonly { readonly draftId: string; readonly error: string }[];
}

export async function repairPendingDrafts(ctx: AppContext): Promise<RepairReport> {
  const pending = await ctx.store.transaction(async (tx) => tx.drafts.listByStatus('pending'));
  const items = await ctx.store.transaction(async (tx) => tx.rawItems.listAll());
  const itemById = new Map(items.map((item) => [item.id, item]));
  const knownRawPaths = new Set((await ctx.vault.listRaw()).map((ref) => String(ref.path)));
  const existingNodes = ctx.search.allDocs().map((doc) => ({
    name: doc.name,
    aliases: doc.aliases,
    nodeType: doc.nodeType,
    file: doc.file,
  }));
  const nodeByName = new Map<string, (typeof existingNodes)[number]>();
  for (const node of existingNodes) {
    nodeByName.set(node.name, node);
    for (const alias of node.aliases) nodeByName.set(alias, node);
  }

  let examined = 0;
  let repaired = 0;
  let stillBlocked = 0;
  const remainingByRule: Record<string, number> = {};
  const failures: { draftId: string; error: string }[] = [];

  for (const draft of pending) {
    const effectiveBefore = effectiveBlockingFindings(draft);
    if (effectiveBefore.length === 0) continue;
    examined += 1;
    try {
      const item = itemById.get(draft.rawItemId);
      if (!item) throw new Error('原文记录消失');

      const tier = fitTierForClaims(draft.proposal.tier, draft.proposal.claims.length);
      const nodes = draft.proposal.nodes.map((node) => {
        const existing = nodeByName.get(node.name);
        if (node.action === 'new' && existing) return { ...node, action: 'patch' as const };
        if (node.action === 'patch' && !existing) return { ...node, action: 'new' as const };
        return node;
      });
      const proposal = { ...draft.proposal, tier, nodes };

      const targetHashes: Record<string, string> = {};
      for (const node of nodes) {
        if (node.action !== 'patch') continue;
        const doc = nodeByName.get(node.name);
        if (!doc) continue;
        targetHashes[doc.file] = ctx.hash.sha256(await ctx.vault.readNode(doc.file));
      }

      const findings = evaluateAll({
        rawPath: String(item.rawPath),
        eventId: item.eventId,
        sourceKey: item.sourceKey,
        enabledSources: ctx.config.enabledSources,
        charCount: item.charCount,
        longTextThreshold: ctx.config.longTextThreshold,
        tier: proposal.tier,
        claims: proposal.claims,
        nodes: proposal.nodes,
        existingNodes,
        items: items.map((entry) => ({
          rawPath: String(entry.rawPath),
          eventId: entry.eventId,
          stateKind: entry.state.kind,
        })),
        knownRawPaths,
      });

      const changed = JSON.stringify([draft.proposal, draft.findings, draft.targetHashes]) !== JSON.stringify([proposal, findings, targetHashes]);
      if (changed) {
        await ctx.store.transaction(async (tx) => tx.drafts.updateReview(draft.id, proposal, findings, targetHashes));
        repaired += 1;
      }

      const remaining = effectiveBlockingFindings({ findings, proposal });
      if (remaining.length > 0) {
        stillBlocked += 1;
        for (const finding of remaining) remainingByRule[finding.ruleId] = (remainingByRule[finding.ruleId] ?? 0) + 1;
      }
    } catch (error) {
      failures.push({ draftId: draft.id, error: String((error as Error).message ?? error) });
    }
  }

  return { examined, repaired, stillBlocked, remainingByRule, failures };
}
