/**
 * triage 结果：决策必须带策略出处（policyId / policyVersion），
 * 半年后才能回答"当时为什么判成 medium"。见设计文档 §4.2。
 */

export type TriageStatus = 'high' | 'medium' | 'low';

export type TriageReason =
  | 'human_story'
  | 'interesting'
  | 'novel_view'
  | 'useful'
  | 'durable_claim'
  | 'reinforces_existing'
  | 'personal_relevance'
  | 'low_signal';

export interface TriageResult {
  readonly status: TriageStatus;
  readonly score: number;
  readonly reasons: readonly TriageReason[];
  readonly judgments: number;
  readonly charCount: number;
  readonly policyId: string;
  readonly policyVersion: number;
}
