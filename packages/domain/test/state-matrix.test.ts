/**
 * 状态矩阵测试：设计文档 §18 的表在这里被独立重抄一遍。
 * 如果实现与规格漂移，这个文件会立刻失败——这是"状态机不可绕过"的第一道防线。
 */
import { describe, expect, it } from 'vitest';
import type { RawStateKind } from '../src/model/raw-state';
import { ALLOWED_TRANSITIONS, EVENT_TYPES, transition, type RawEventType } from '../src/state-machine';
import { NOW, sampleEvent, stateFor } from './helpers';

/** 手抄自 §18：每个状态允许的事件 → 目标状态。空对象 = 终态。 */
const SPEC: Readonly<Record<RawStateKind, Readonly<Partial<Record<RawEventType, RawStateKind>>>>> = {
  ingested: { INGESTED: 'triaged', QUARANTINE: 'quarantined' },
  triaged: {
    TRIAGE_QUEUED: 'queued',
    TRIAGE_LOW: 'deferred',
    TRIAGE_LONG: 'deferred',
    TRIAGE_SCOPE: 'deferred',
  },
  quarantined: { UNBLOCK: 'triaged' },
  queued: { DRAFT_START: 'drafting', DEFER: 'deferred' },
  drafting: {
    DRAFT_OK: 'draft_ready',
    DRAFT_FAIL: 'failed',
    DRAFT_REFUSAL: 'rejected',
    LEASE_LOST: 'queued',
  },
  draft_ready: { REVIEW_OPEN: 'in_review', SUPERSEDE: 'abandoned', EXPIRE: 'expired' },
  in_review: {
    ACCEPT: 'approved',
    REJECT: 'rejected',
    REQUEST_CHANGES: 'changes_requested',
    REFRESH_FINDINGS: 'in_review',
    DEFER: 'deferred',
    EXPIRE: 'deferred',
  },
  changes_requested: { DRAFT_START: 'drafting' },
  approved: { COMMIT_INTENT: 'committing' },
  committing: { COMMIT_OK: 'committed', COMMIT_FAIL: 'rolled_back' },
  committed: {},
  rejected: {},
  deferred: { RETRY: 'queued' },
  rolled_back: { RETRY: 'queued', REOPEN_FOR_REVIEW: 'in_review' },
  failed: { RETRY: 'queued' },
  blocked: { UNBLOCK: 'queued', ABANDON: 'abandoned' },
  expired: {},
  abandoned: {},
};

const KINDS = Object.keys(SPEC) as readonly RawStateKind[];

describe('状态机矩阵', () => {
  it('ALLOWED_TRANSITIONS 与设计文档 §18 完全一致（含终态为空）', () => {
    expect([...KINDS].sort()).toEqual(Object.keys(ALLOWED_TRANSITIONS).sort());
    for (const kind of KINDS) {
      const expected = Object.keys(SPEC[kind]).sort();
      const actual = [...ALLOWED_TRANSITIONS[kind]].sort();
      expect(actual, `状态 ${kind} 的允许事件与规格不一致`).toEqual(expected);
    }
  });

  it('穷举 18 状态 × 26 事件：只有表内组合可迁移，且目标态正确', () => {
    let checked = 0;
    for (const kind of KINDS) {
      for (const eventType of EVENT_TYPES) {
        const from = stateFor(kind);
        const result = transition(from, sampleEvent(eventType), {
          now: NOW,
          targetHashesUnchanged: true,
        });
        const expectedTarget = SPEC[kind][eventType];
        checked++;

        if (expectedTarget === undefined) {
          expect(result.ok, `${kind} ← ${eventType} 应当被拒绝`).toBe(false);
          if (!result.ok) {
            expect(result.error.code, `${kind} ← ${eventType} 的错误码`).toBe('INVALID_TRANSITION');
          }
        } else {
          expect(result.ok, `${kind} ← ${eventType} 应当被允许，实际错误：${result.ok ? '' : result.error.code}`).toBe(true);
          if (result.ok) {
            expect(result.value.kind, `${kind} ← ${eventType} 的目标状态`).toBe(expectedTarget);
          }
        }
      }
    }
    expect(checked).toBe(KINDS.length * EVENT_TYPES.length);
    expect(checked).toBe(18 * 26);
  });

  it('终态不接受任何事件', () => {
    for (const kind of ['committed', 'rejected', 'expired', 'abandoned'] as const) {
      for (const eventType of EVENT_TYPES) {
        const result = transition(stateFor(kind), sampleEvent(eventType), {
          now: NOW,
          targetHashesUnchanged: true,
        });
        expect(result.ok).toBe(false);
      }
    }
  });

  it('非法迁移的错误里带 from / event / allowed，供 explain 使用', () => {
    const result = transition(stateFor('committed'), sampleEvent('ACCEPT'), { now: NOW, targetHashesUnchanged: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toMatchObject({ from: 'committed', event: 'ACCEPT' });
      expect(result.error.detail?.allowed).toEqual([]);
    }
  });
});
