/**
 * triage 策略 v1（设计文档 §4.2）：
 * 输入只有"判断句数量"和"字数"两个可复现信号；语义价值判断在模型侧，不在这里。
 */
import type { TriageReason, TriageResult, TriageStatus } from '../model/triage';

export const TRIAGE_POLICY_ID = 'triage-policy';
export const TRIAGE_POLICY_VERSION = 1;

export interface TriagePolicyInput {
  readonly judgments: number;
  readonly charCount: number;
}

const HIGH_THRESHOLD = 6;
const MEDIUM_THRESHOLD = 3;

export function decideTriage(input: TriagePolicyInput): TriageResult {
  const { judgments, charCount } = input;

  let status: TriageStatus;
  let score: number;
  let reasons: readonly TriageReason[];

  if (judgments >= HIGH_THRESHOLD) {
    status = 'high';
    score = 5;
    reasons = ['durable_claim', 'useful'];
  } else if (judgments >= MEDIUM_THRESHOLD) {
    status = 'medium';
    score = 3;
    reasons = ['useful'];
  } else {
    status = 'low';
    score = 1;
    reasons = ['low_signal'];
  }

  return { status, score, reasons, judgments, charCount, policyId: TRIAGE_POLICY_ID, policyVersion: TRIAGE_POLICY_VERSION };
}

/** 队列口径：只有 high / medium 进入 digest 队列（low 直接 deferred）。 */
export function isQueuedStatus(status: TriageStatus): boolean {
  return status === 'high' || status === 'medium';
}
