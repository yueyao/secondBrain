/**
 * 状态模型：可辨识联合（设计文档 §4.1）。
 * 状态一旦生成就不可变；迁移只能通过 state-machine.ts。
 */
import type { ErrorClass } from './errors';
import type { Finding } from './finding';
import type { CommitSha, DraftId, RawPath } from './identifiers';
import type { TriageResult } from './triage';

export type RawStateKind =
  | 'ingested'
  | 'triaged'
  | 'quarantined'
  | 'queued'
  | 'drafting'
  | 'draft_ready'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'committing'
  | 'committed'
  | 'rejected'
  | 'deferred'
  | 'rolled_back'
  | 'failed'
  | 'blocked'
  | 'expired'
  | 'abandoned';

export type DeferReason = 'low_value' | 'source_disabled' | 'too_long' | 'user' | 'expired';

export type RawState =
  | { readonly kind: 'ingested' }
  | { readonly kind: 'triaged' }
  | { readonly kind: 'quarantined'; readonly reason: string }
  | { readonly kind: 'queued'; readonly triage: TriageResult }
  | {
      readonly kind: 'drafting';
      readonly draftId: DraftId;
      readonly triage: TriageResult;
      readonly startedAt: string;
    }
  | {
      readonly kind: 'draft_ready';
      readonly draftId: DraftId;
      readonly triage: TriageResult;
      readonly findings: readonly Finding[];
    }
  | {
      readonly kind: 'in_review';
      readonly draftId: DraftId;
      readonly triage: TriageResult;
      readonly findings: readonly Finding[];
      readonly openedAt: string;
    }
  | {
      readonly kind: 'changes_requested';
      readonly draftId: DraftId;
      readonly triage: TriageResult;
      readonly note: string;
    }
  | {
      readonly kind: 'approved';
      readonly draftId: DraftId;
      readonly triage: TriageResult;
      readonly actor: string;
      readonly approvedAt: string;
    }
  | {
      readonly kind: 'committing';
      readonly draftId: DraftId;
      readonly triage: TriageResult;
      readonly intentId: string;
      readonly preCommitSha: CommitSha | null;
    }
  | {
      readonly kind: 'committed';
      readonly draftId: DraftId;
      readonly triage: TriageResult;
      readonly commitSha: CommitSha;
    }
  | { readonly kind: 'rejected'; readonly reason: string; readonly auto: boolean }
  | { readonly kind: 'deferred'; readonly reason: DeferReason; readonly triage: TriageResult | null }
  | {
      readonly kind: 'rolled_back';
      readonly draftId: DraftId;
      readonly triage: TriageResult;
      readonly reason: string;
      readonly attempts: number;
    }
  | {
      readonly kind: 'failed';
      readonly draftId: DraftId | null;
      readonly triage: TriageResult | null;
      readonly errorClass: ErrorClass;
      readonly code: string;
      readonly attempts: number;
    }
  | {
      readonly kind: 'blocked';
      readonly triage: TriageResult | null;
      readonly reason: string;
    }
  | { readonly kind: 'expired'; readonly from: RawStateKind }
  | {
      readonly kind: 'abandoned';
      readonly canonicalRawPath: RawPath | null;
      readonly note: string;
    };

/** 终态：不再接受任何事件（设计文档 §18 终态与保留策略）。 */
export const TERMINAL_STATES: readonly RawStateKind[] = [
  'committed',
  'rejected',
  'expired',
  'abandoned',
];

export function isTerminal(state: RawState): boolean {
  return TERMINAL_STATES.includes(state.kind);
}

/** 队列口径：哪些状态需要人注意（给 CLI/未来 UI 的查询用）。 */
export const ACTIONABLE_STATES: readonly RawStateKind[] = [
  'queued',
  'draft_ready',
  'in_review',
  'changes_requested',
  'blocked',
];
