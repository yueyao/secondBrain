import { describe, expect, it } from 'vitest';
import {
  decideTriage,
  isQueuedStatus,
  TRIAGE_POLICY_ID,
  TRIAGE_POLICY_VERSION,
} from '../src/policies/triage-policy';
import { isTooLong, LONG_TEXT_THRESHOLD } from '../src/policies/long-text-policy';

describe('triage-policy v1', () => {
  const cases = [
    { judgments: 0, status: 'low', score: 1, firstReason: 'low_signal' },
    { judgments: 2, status: 'low', score: 1, firstReason: 'low_signal' },
    { judgments: 3, status: 'medium', score: 3, firstReason: 'useful' },
    { judgments: 5, status: 'medium', score: 3, firstReason: 'useful' },
    { judgments: 6, status: 'high', score: 5, firstReason: 'durable_claim' },
    { judgments: 50, status: 'high', score: 5, firstReason: 'durable_claim' },
  ] as const;

  it.each(cases)('judgments=$judgments → $status / score $score', ({ judgments, status, score, firstReason }) => {
    const result = decideTriage({ judgments, charCount: 1234 });
    expect(result.status).toBe(status);
    expect(result.score).toBe(score);
    expect(result.reasons[0]).toBe(firstReason);
    expect(result.judgments).toBe(judgments);
    expect(result.charCount).toBe(1234);
  });

  it('每个决策都带策略出处（可解释历史）', () => {
    const result = decideTriage({ judgments: 4, charCount: 800 });
    expect(result.policyId).toBe(TRIAGE_POLICY_ID);
    expect(result.policyVersion).toBe(TRIAGE_POLICY_VERSION);
  });

  it('只有 high / medium 进入队列', () => {
    expect(isQueuedStatus('high')).toBe(true);
    expect(isQueuedStatus('medium')).toBe(true);
    expect(isQueuedStatus('low')).toBe(false);
  });
});

describe('long-text-policy v1', () => {
  it('阈值边界：等于阈值不算超长，超过才算', () => {
    expect(isTooLong(LONG_TEXT_THRESHOLD)).toBe(false);
    expect(isTooLong(LONG_TEXT_THRESHOLD + 1)).toBe(true);
  });

  it('可注入阈值（测试与配置化）', () => {
    expect(isTooLong(101, 100)).toBe(true);
    expect(isTooLong(100, 100)).toBe(false);
  });
});
