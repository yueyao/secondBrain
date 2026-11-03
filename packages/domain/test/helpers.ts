/** 测试夹具：只在这里构造带品牌类型的值。 */
import type { RawPath, DraftId, CommitSha } from '../src/model/identifiers';
import { parseCommitSha, parseDraftId, parseRawPath } from '../src/model/identifiers';
import type { RawState, RawStateKind } from '../src/model/raw-state';
import type { TriageResult } from '../src/model/triage';
import type { Claim, NodeChange } from '../src/model/draft';
import type { RawEvent } from '../src/state-machine';
import type { RuleInput, ExistingNode, ItemRef } from '../src/model/rule-input';
import { decideTriage } from '../src/policies/triage-policy';

export const NOW = '2026-10-30T22:00:00+08:00';

export function draftId(value = 'draft-abc123'): DraftId {
  const parsed = parseDraftId(value);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

export function commitSha(value = 'abc1234'): CommitSha {
  const parsed = parseCommitSha(value);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

export function rawPath(value = 'raw/knowledge/cubox/a.md'): RawPath {
  const parsed = parseRawPath(value);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

export function triage(judgments = 6): TriageResult {
  return decideTriage({ judgments, charCount: 1200 });
}

export function stateFor(kind: RawStateKind): RawState {
  const t = triage();
  switch (kind) {
    case 'ingested':
      return { kind: 'ingested' };
    case 'triaged':
      return { kind: 'triaged' };
    case 'quarantined':
      return { kind: 'quarantined', reason: 'unreadable' };
    case 'queued':
      return { kind: 'queued', triage: t };
    case 'drafting':
      return { kind: 'drafting', draftId: draftId(), triage: t, startedAt: NOW };
    case 'draft_ready':
      return { kind: 'draft_ready', draftId: draftId(), triage: t, findings: [] };
    case 'in_review':
      return { kind: 'in_review', draftId: draftId(), triage: t, findings: [], openedAt: NOW };
    case 'changes_requested':
      return { kind: 'changes_requested', draftId: draftId(), triage: t, note: '补一条反例' };
    case 'approved':
      return { kind: 'approved', draftId: draftId(), triage: t, actor: 'owner', approvedAt: NOW };
    case 'committing':
      return { kind: 'committing', draftId: draftId(), triage: t, intentId: 'intent-1', preCommitSha: null };
    case 'committed':
      return { kind: 'committed', draftId: draftId(), triage: t, commitSha: commitSha() };
    case 'rejected':
      return { kind: 'rejected', reason: '重复源', auto: false };
    case 'deferred':
      return { kind: 'deferred', reason: 'user', triage: t };
    case 'rolled_back':
      return { kind: 'rolled_back', draftId: draftId(), triage: t, reason: 'git dirty', attempts: 1 };
    case 'failed':
      return { kind: 'failed', draftId: draftId(), triage: t, errorClass: 'AgentTimeout', code: 'TIMEOUT', attempts: 1 };
    case 'blocked':
      return { kind: 'blocked', triage: t, reason: '需要人工清理工作区' };
    case 'expired':
      return { kind: 'expired', from: 'draft_ready' };
    case 'abandoned':
      return { kind: 'abandoned', canonicalRawPath: rawPath(), note: '被 canonical 取代' };
  }
}

export function sampleEvent(type: RawEvent['type']): RawEvent {
  switch (type) {
    case 'INGESTED':
      return { type: 'INGESTED' };
    case 'QUARANTINE':
      return { type: 'QUARANTINE', reason: 'unreadable' };
    case 'TRIAGE_QUEUED':
      return { type: 'TRIAGE_QUEUED', triage: triage() };
    case 'TRIAGE_LOW':
      return { type: 'TRIAGE_LOW', triage: triage(0) };
    case 'TRIAGE_LONG':
      return { type: 'TRIAGE_LONG', charCount: 70_000 };
    case 'TRIAGE_SCOPE':
      return { type: 'TRIAGE_SCOPE', sourceKey: 'newsletters' };
    case 'DRAFT_START':
      return { type: 'DRAFT_START', draftId: draftId('draft-next001') };
    case 'DRAFT_OK':
      return { type: 'DRAFT_OK', draftId: draftId(), findings: [] };
    case 'DRAFT_FAIL':
      return { type: 'DRAFT_FAIL', errorClass: 'AgentTimeout', code: 'TIMEOUT', attempts: 1 };
    case 'DRAFT_REFUSAL':
      return { type: 'DRAFT_REFUSAL', reason: '模型拒答' };
    case 'LEASE_LOST':
      return { type: 'LEASE_LOST' };
    case 'REVIEW_OPEN':
      return { type: 'REVIEW_OPEN', findings: [] };
    case 'ACCEPT':
      return { type: 'ACCEPT', actor: 'owner' };
    case 'REJECT':
      return { type: 'REJECT', reason: '同事件已由另一来源入库' };
    case 'REQUEST_CHANGES':
      return { type: 'REQUEST_CHANGES', note: '把推断型 claim 删掉' };
    case 'DEFER':
      return { type: 'DEFER', reason: 'user' };
    case 'SUPERSEDE':
      return { type: 'SUPERSEDE', canonicalRawPath: rawPath('raw/knowledge/podcast/e999.md') };
    case 'EXPIRE':
      return { type: 'EXPIRE' };
    case 'COMMIT_INTENT':
      return { type: 'COMMIT_INTENT', intentId: 'intent-1', preCommitSha: null };
    case 'COMMIT_OK':
      return { type: 'COMMIT_OK', commitSha: commitSha('def5678') };
    case 'COMMIT_FAIL':
      return { type: 'COMMIT_FAIL', reason: 'git dirty', attempts: 1 };
    case 'RETRY':
      return { type: 'RETRY', attempts: 1 };
    case 'UNBLOCK':
      return { type: 'UNBLOCK', note: '已修复' };
    case 'ABANDON':
      return { type: 'ABANDON', note: '放弃' };
  }
}

export function claim(text: string, source = 'raw/knowledge/cubox/a.md', inference = false): Claim {
  return { text, source, inference };
}

export function node(name: string, action: 'patch' | 'new' = 'new', nodeType: 'concept' | 'topic' | 'person' = 'concept'): NodeChange {
  return { name, action, nodeType, definition: action === 'new' ? `${name}的定义` : null, claimIndexes: [] };
}

export function existingNode(name: string, aliases: readonly string[] = [], file = `wiki/concepts/${name}.md`): ExistingNode {
  return { name, aliases, nodeType: 'concept', file };
}

export function itemRef(rawPathValue: string, stateKind: RawStateKind, eventId: string | null = null): ItemRef {
  return { rawPath: rawPathValue, stateKind, eventId };
}

export function ruleInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    rawPath: 'raw/knowledge/cubox/a.md',
    eventId: null,
    sourceKey: 'cubox',
    enabledSources: ['cubox', 'notions', 'podcast', 'dedao', 'general'],
    charCount: 1200,
    longTextThreshold: 60_000,
    tier: 'standard',
    claims: [],
    nodes: [],
    existingNodes: [],
    items: [],
    knownRawPaths: new Set<string>(),
    ...overrides,
  };
}
