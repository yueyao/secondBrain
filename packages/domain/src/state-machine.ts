/**
 * 状态机（设计文档 §18）：事件 × 状态 的完整迁移表。
 *
 * 三条硬约束：
 * 1. 表外组合一律 INVALID_TRANSITION；
 * 2. 守卫（无 block finding / 目标未变 / 重试未超限）在迁移内部完成；
 * 3. 没有异常——非法请求返回 Result.error，由调用方决定如何处理。
 */
import { domainError, MAX_JOB_ATTEMPTS, type DomainError, type ErrorClass } from './model/errors';
import { blockFindings, hasBlock, type Finding } from './model/finding';
import type { CommitSha, DraftId, RawPath } from './model/identifiers';
import { err, ok, type Result } from './model/result';
import type { DeferReason, RawState, RawStateKind } from './model/raw-state';
import type { TriageResult } from './model/triage';

export interface TransitionContext {
  /** 由应用层注入，领域层不读时钟。 */
  readonly now: string;
  /** 提交前由应用层比对目标节点内容哈希；省略视为"未提供"，会拒绝迁移。 */
  readonly targetHashesUnchanged?: boolean;
}

export type RawEvent =
  | { readonly type: 'INGESTED' }
  | { readonly type: 'QUARANTINE'; readonly reason: string }
  | { readonly type: 'TRIAGE_QUEUED'; readonly triage: TriageResult }
  | { readonly type: 'TRIAGE_LOW'; readonly triage: TriageResult }
  | { readonly type: 'TRIAGE_LONG'; readonly charCount: number }
  | { readonly type: 'TRIAGE_SCOPE'; readonly sourceKey: string }
  | { readonly type: 'DRAFT_START'; readonly draftId: DraftId }
  | { readonly type: 'DRAFT_OK'; readonly draftId: DraftId; readonly findings: readonly Finding[] }
  | {
      readonly type: 'DRAFT_FAIL';
      readonly errorClass: ErrorClass;
      readonly code: string;
      readonly attempts: number;
    }
  | { readonly type: 'DRAFT_REFUSAL'; readonly reason: string }
  | { readonly type: 'LEASE_LOST' }
  | { readonly type: 'REVIEW_OPEN'; readonly findings: readonly Finding[] }
  | { readonly type: 'REOPEN_FOR_REVIEW'; readonly findings: readonly Finding[] }
  | { readonly type: 'REFRESH_FINDINGS'; readonly findings: readonly Finding[] }
  | { readonly type: 'ACCEPT'; readonly actor: string }
  | { readonly type: 'REJECT'; readonly reason: string; readonly auto?: boolean }
  | { readonly type: 'REQUEST_CHANGES'; readonly note: string }
  | { readonly type: 'DEFER'; readonly reason: DeferReason }
  | { readonly type: 'SUPERSEDE'; readonly canonicalRawPath: RawPath }
  | { readonly type: 'EXPIRE' }
  | {
      readonly type: 'COMMIT_INTENT';
      readonly intentId: string;
      readonly preCommitSha: CommitSha | null;
    }
  | { readonly type: 'COMMIT_OK'; readonly commitSha: CommitSha }
  | { readonly type: 'COMMIT_FAIL'; readonly reason: string; readonly attempts: number }
  | { readonly type: 'RETRY'; readonly attempts: number }
  | { readonly type: 'UNBLOCK'; readonly note: string }
  | { readonly type: 'ABANDON'; readonly note: string };

export type RawEventType = RawEvent['type'];

export const EVENT_TYPES: readonly RawEventType[] = [
  'INGESTED',
  'QUARANTINE',
  'TRIAGE_QUEUED',
  'TRIAGE_LOW',
  'TRIAGE_LONG',
  'TRIAGE_SCOPE',
  'DRAFT_START',
  'DRAFT_OK',
  'DRAFT_FAIL',
  'DRAFT_REFUSAL',
  'LEASE_LOST',
  'REVIEW_OPEN',
  'REOPEN_FOR_REVIEW',
  'REFRESH_FINDINGS',
  'ACCEPT',
  'REJECT',
  'REQUEST_CHANGES',
  'DEFER',
  'SUPERSEDE',
  'EXPIRE',
  'COMMIT_INTENT',
  'COMMIT_OK',
  'COMMIT_FAIL',
  'RETRY',
  'UNBLOCK',
  'ABANDON',
];

/** 合法迁移表：这是唯一的事实来源，switch 只是实现。 */
export const ALLOWED_TRANSITIONS: Readonly<Record<RawStateKind, readonly RawEventType[]>> = {
  ingested: ['INGESTED', 'QUARANTINE'],
  triaged: ['TRIAGE_QUEUED', 'TRIAGE_LOW', 'TRIAGE_LONG', 'TRIAGE_SCOPE'],
  quarantined: ['UNBLOCK'],
  queued: ['DRAFT_START', 'DEFER'],
  drafting: ['DRAFT_OK', 'DRAFT_FAIL', 'DRAFT_REFUSAL', 'LEASE_LOST'],
  draft_ready: ['REVIEW_OPEN', 'SUPERSEDE', 'EXPIRE'],
  in_review: ['ACCEPT', 'REJECT', 'REQUEST_CHANGES', 'REFRESH_FINDINGS', 'DEFER', 'EXPIRE'],
  changes_requested: ['DRAFT_START'],
  approved: ['COMMIT_INTENT'],
  committing: ['COMMIT_OK', 'COMMIT_FAIL'],
  committed: [],
  rejected: [],
  deferred: ['RETRY'],
  rolled_back: ['RETRY', 'REOPEN_FOR_REVIEW'],
  failed: ['RETRY'],
  blocked: ['UNBLOCK', 'ABANDON'],
  expired: [],
  abandoned: [],
};

function invalid(from: RawState, event: RawEvent): Result<RawState, DomainError> {
  return err(
    domainError('INVALID_TRANSITION', `非法状态迁移：${from.kind} ← ${event.type}`, {
      from: from.kind,
      event: event.type,
      allowed: [...ALLOWED_TRANSITIONS[from.kind]],
    }),
  );
}

/** 表与 switch 不一致时（实现遗漏）由这里兜底——矩阵测试会立刻发现。 */
function gap(from: RawState, event: RawEvent): Result<RawState, DomainError> {
  return err(
    domainError('INTERNAL_TRANSITION_GAP', `状态机实现缺口：${from.kind} ← ${event.type}`, {
      from: from.kind,
      event: event.type,
    }),
  );
}

function retryable(from: RawState, attempts: number): Result<RawState, DomainError> | null {
  if (attempts >= MAX_JOB_ATTEMPTS) {
    return err(
      domainError(
        'RETRY_EXHAUSTED',
        `重试已达上限 ${MAX_JOB_ATTEMPTS} 次，转人工（blocked）`,
        { from: from.kind, attempts, maxAttempts: MAX_JOB_ATTEMPTS },
      ),
    );
  }
  return null;
}

export function transition(
  from: RawState,
  event: RawEvent,
  ctx: TransitionContext,
): Result<RawState, DomainError> {
  if (!ALLOWED_TRANSITIONS[from.kind].includes(event.type)) return invalid(from, event);

  switch (from.kind) {
    case 'ingested':
      switch (event.type) {
        case 'INGESTED':
          return ok({ kind: 'triaged' });
        case 'QUARANTINE':
          return ok({ kind: 'quarantined', reason: event.reason });
        default:
          return gap(from, event);
      }

    case 'triaged':
      switch (event.type) {
        case 'TRIAGE_QUEUED':
          return ok({ kind: 'queued', triage: event.triage });
        case 'TRIAGE_LOW':
          return ok({ kind: 'deferred', reason: 'low_value', triage: event.triage });
        case 'TRIAGE_LONG':
          return ok({ kind: 'deferred', reason: 'too_long', triage: null });
        case 'TRIAGE_SCOPE':
          return ok({ kind: 'deferred', reason: 'source_disabled', triage: null });
        default:
          return gap(from, event);
      }

    case 'quarantined':
      switch (event.type) {
        case 'UNBLOCK':
          return ok({ kind: 'triaged' });
        default:
          return gap(from, event);
      }

    case 'queued':
      switch (event.type) {
        case 'DRAFT_START':
          return ok({ kind: 'drafting', draftId: event.draftId, triage: from.triage, startedAt: ctx.now });
        case 'DEFER':
          return ok({ kind: 'deferred', reason: event.reason, triage: from.triage });
        default:
          return gap(from, event);
      }

    case 'drafting':
      switch (event.type) {
        case 'DRAFT_OK':
          return ok({
            kind: 'draft_ready',
            draftId: event.draftId,
            triage: from.triage,
            findings: event.findings,
          });
        case 'DRAFT_FAIL':
          return ok({
            kind: 'failed',
            draftId: from.draftId,
            triage: from.triage,
            errorClass: event.errorClass,
            code: event.code,
            attempts: event.attempts,
          });
        case 'DRAFT_REFUSAL':
          return ok({ kind: 'rejected', reason: event.reason, auto: true });
        case 'LEASE_LOST':
          return ok({ kind: 'queued', triage: from.triage });
        default:
          return gap(from, event);
      }

    case 'draft_ready':
      switch (event.type) {
        case 'REVIEW_OPEN':
          return ok({
            kind: 'in_review',
            draftId: from.draftId,
            triage: from.triage,
            findings: event.findings,
            openedAt: ctx.now,
          });
        case 'SUPERSEDE':
          return ok({ kind: 'abandoned', canonicalRawPath: event.canonicalRawPath, note: '已被 canonical 取代' });
        case 'EXPIRE':
          return ok({ kind: 'expired', from: 'draft_ready' });
        default:
          return gap(from, event);
      }

    case 'in_review':
      switch (event.type) {
        case 'REFRESH_FINDINGS':
          return ok({ ...from, findings: event.findings });
        case 'ACCEPT': {
          if (hasBlock(from.findings)) {
            return err(
              domainError('BLOCK_FINDINGS_PRESENT', '存在阻断级预警，不能入库', {
                ruleIds: blockFindings(from.findings).map((finding) => finding.ruleId),
              }),
            );
          }
          return ok({
            kind: 'approved',
            draftId: from.draftId,
            triage: from.triage,
            actor: event.actor,
            approvedAt: ctx.now,
          });
        }
        case 'REJECT':
          return ok({ kind: 'rejected', reason: event.reason, auto: event.auto === true });
        case 'REQUEST_CHANGES':
          return ok({
            kind: 'changes_requested',
            draftId: from.draftId,
            triage: from.triage,
            note: event.note,
          });
        case 'DEFER':
          return ok({ kind: 'deferred', reason: event.reason, triage: from.triage });
        case 'EXPIRE':
          return ok({ kind: 'deferred', reason: 'expired', triage: from.triage });
        default:
          return gap(from, event);
      }

    case 'changes_requested':
      switch (event.type) {
        case 'DRAFT_START':
          return ok({ kind: 'drafting', draftId: event.draftId, triage: from.triage, startedAt: ctx.now });
        default:
          return gap(from, event);
      }

    case 'approved':
      switch (event.type) {
        case 'COMMIT_INTENT': {
          if (ctx.targetHashesUnchanged === false) {
            return err(
              domainError('TARGET_MOVED', '目标节点在本草稿生成后被修改，需重新生成草稿', {
                intentId: event.intentId,
              }),
            );
          }
          if (ctx.targetHashesUnchanged !== true) {
            return err(
              domainError('GUARD_MISSING_CONTEXT', '缺少 targetHashesUnchanged 守卫输入，拒绝提交', {
                intentId: event.intentId,
              }),
            );
          }
          return ok({
            kind: 'committing',
            draftId: from.draftId,
            triage: from.triage,
            intentId: event.intentId,
            preCommitSha: event.preCommitSha,
          });
        }
        default:
          return gap(from, event);
      }

    case 'committing':
      switch (event.type) {
        case 'COMMIT_OK':
          return ok({
            kind: 'committed',
            draftId: from.draftId,
            triage: from.triage,
            commitSha: event.commitSha,
          });
        case 'COMMIT_FAIL':
          return ok({
            kind: 'rolled_back',
            draftId: from.draftId,
            triage: from.triage,
            reason: event.reason,
            attempts: event.attempts,
          });
        default:
          return gap(from, event);
      }

    case 'rolled_back':
      switch (event.type) {
        case 'REOPEN_FOR_REVIEW':
          return ok({
            kind: 'in_review',
            draftId: from.draftId,
            triage: from.triage,
            findings: event.findings,
            openedAt: ctx.now,
          });
        case 'RETRY': {
          // 取"状态中的尝试次数"与"事件带来的次数"的较大值，避免调用方传小值绕过上限
          const exhausted = retryable(from, Math.max(from.attempts, event.attempts));
          if (exhausted) return exhausted;
          return ok({ kind: 'queued', triage: from.triage });
        }
        default:
          return gap(from, event);
      }

    case 'failed':
      switch (event.type) {
        case 'RETRY': {
          const exhausted = retryable(from, Math.max(from.attempts, event.attempts));
          if (exhausted) return exhausted;
          if (!from.triage) {
            return err(domainError('MISSING_TRIAGE', '失败态缺少 triage 结果，无法回到队列', { errorClass: from.errorClass }));
          }
          return ok({ kind: 'queued', triage: from.triage });
        }
        default:
          return gap(from, event);
      }

    case 'blocked':
      switch (event.type) {
        case 'UNBLOCK': {
          if (!from.triage) {
            return err(domainError('MISSING_TRIAGE', '阻塞态缺少 triage 结果，无法回到队列', { reason: from.reason }));
          }
          return ok({ kind: 'queued', triage: from.triage });
        }
        case 'ABANDON':
          return ok({ kind: 'abandoned', canonicalRawPath: null, note: event.note });
        default:
          return gap(from, event);
      }

    case 'deferred':
      switch (event.type) {
        case 'RETRY': {
          if (!from.triage) {
            return err(domainError('MISSING_TRIAGE', '延后态缺少 triage 结果，无法直接回到队列', { reason: from.reason }));
          }
          return ok({ kind: 'queued', triage: from.triage });
        }
        default:
          return gap(from, event);
      }

    case 'committed':
    case 'rejected':
    case 'expired':
    case 'abandoned':
      return gap(from, event);
  }
}

export function allowedEvents(kind: RawStateKind): readonly RawEventType[] {
  return ALLOWED_TRANSITIONS[kind];
}

/** 事件回放：用于测试与 `sb replay` 校验（领域层不做 I/O）。 */
export function applyEvents(
  initial: RawState,
  events: readonly RawEvent[],
  ctx: TransitionContext,
): Result<RawState, DomainError> {
  let current = initial;
  for (const event of events) {
    const next = transition(current, event, ctx);
    if (!next.ok) return next;
    current = next.value;
  }
  return ok(current);
}
