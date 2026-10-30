/** 守卫测试：迁移"允许"不等于"成功"，守卫必须挡住不该发生的事。 */
import { describe, expect, it } from 'vitest';
import { makeFinding } from '../src/model/finding';
import { transition } from '../src/state-machine';
import { MAX_JOB_ATTEMPTS } from '../src/model/errors';
import { NOW, commitSha, draftId, sampleEvent, stateFor, triage } from './helpers';

const ctx = { now: NOW, targetHashesUnchanged: true } as const;

describe('守卫：无 block finding 才能入库', () => {
  it('存在 block 级 finding 时 ACCEPT 被拒绝，并列出规则 id', () => {
    const from = {
      kind: 'in_review' as const,
      draftId: draftId(),
      triage: triage(),
      findings: [makeFinding('r-event-already-digested', 'block', 'EVENT_ALREADY_DIGESTED', '重复源')],
      openedAt: NOW,
    };
    const result = transition(from, sampleEvent('ACCEPT'), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('BLOCK_FINDINGS_PRESENT');
      expect(result.error.detail?.ruleIds).toEqual(['r-event-already-digested']);
    }
  });

  it('只有 warn 级 finding 时可以入库', () => {
    const from = {
      kind: 'in_review' as const,
      draftId: draftId(),
      triage: triage(),
      findings: [makeFinding('r-inferred-claims', 'warn', 'INFERRED_CLAIMS', '2 条推断')],
      openedAt: NOW,
    };
    const result = transition(from, sampleEvent('ACCEPT'), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('approved');
  });
});

describe('守卫：提交前目标节点必须未被修改', () => {
  it('targetHashesUnchanged=false → TARGET_MOVED', () => {
    const result = transition(stateFor('approved'), sampleEvent('COMMIT_INTENT'), {
      now: NOW,
      targetHashesUnchanged: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TARGET_MOVED');
  });

  it('未提供守卫输入 → GUARD_MISSING_CONTEXT（不允许"默认通过"）', () => {
    const result = transition(stateFor('approved'), sampleEvent('COMMIT_INTENT'), { now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('GUARD_MISSING_CONTEXT');
  });
});

describe('守卫：重试上限', () => {
  it('attempts 达到上限时 RETRY 被拒绝', () => {
    for (const kind of ['rolled_back', 'failed'] as const) {
      const base = stateFor(kind);
      const atLimit =
        base.kind === 'failed' || base.kind === 'rolled_back'
          ? { ...base, attempts: MAX_JOB_ATTEMPTS }
          : base;
      const result = transition(atLimit, sampleEvent('RETRY'), ctx);
      expect(result.ok, `${kind} 达上限应拒绝`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('RETRY_EXHAUSTED');
    }
  });

  it('未达上限时可以回到队列', () => {
    const result = transition(stateFor('failed'), sampleEvent('RETRY'), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('queued');
  });
});

describe('守卫：缺少 triage 结果时不能回到队列', () => {
  it('deferred 无 triage → MISSING_TRIAGE', () => {
    const from = { kind: 'deferred' as const, reason: 'low_value' as const, triage: null };
    const result = transition(from, sampleEvent('RETRY'), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MISSING_TRIAGE');
  });

  it('failed 无 triage → MISSING_TRIAGE', () => {
    const from = {
      kind: 'failed' as const,
      draftId: null,
      triage: null,
      errorClass: 'StorageError' as const,
      code: 'DB_LOCKED',
      attempts: 1,
    };
    const result = transition(from, sampleEvent('RETRY'), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MISSING_TRIAGE');
  });
});

describe('守卫：提交成功的正常路径', () => {
  it('approved → committing → committed', () => {
    const committing = transition(stateFor('approved'), sampleEvent('COMMIT_INTENT'), ctx);
    expect(committing.ok).toBe(true);
    if (!committing.ok) return;
    expect(committing.value.kind).toBe('committing');

    const committed = transition(committing.value, { type: 'COMMIT_OK', commitSha: commitSha('abc1234') }, ctx);
    expect(committed.ok).toBe(true);
    if (committed.ok) {
      expect(committed.value.kind).toBe('committed');
      if (committed.value.kind === 'committed') expect(committed.value.commitSha).toBe('abc1234');
    }
  });
});
