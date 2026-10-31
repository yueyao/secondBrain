/** 能力路由（ADR 0005 §2）：按能力筛选，不按模型名。 */
import type { Sensitivity } from '@sb/contracts';

export type AgentTask = 'triage' | 'digest' | 'review-rewrite' | 'decide';

export interface ModelCapabilities {
  readonly contextTokens: number;
  readonly structuredOutput: boolean;
  readonly toolCalls: boolean;
  readonly languages: readonly string[];
  /** 允许处理哪些敏感级别的原文 */
  readonly sensitivity: readonly Sensitivity[];
}

export interface ModelProfile {
  readonly id: string;
  readonly provider: string;
  /** 固定快照，禁止 -latest */
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  readonly pricing: { readonly inPerMTokens: number; readonly outPerMTokens: number };
  readonly limits: { readonly maxConcurrency: number; readonly requestsPerMinute: number };
  readonly health: { readonly enabled: boolean; readonly fallbackTo: readonly string[] };
}

export interface TaskPolicy {
  readonly task: AgentTask;
  readonly requires: {
    readonly contextTokens: number;
    readonly structuredOutput: boolean;
    readonly toolCalls: boolean;
  };
  /** 首选顺序；每个 profile 的 fallbackTo 会追加在其后 */
  readonly profileOrder: readonly string[];
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly expectedClaims: number;
}

export interface RejectedProfile {
  readonly id: string;
  readonly reason: string;
}

export interface RoutingResult {
  readonly chain: readonly ModelProfile[];
  readonly rejected: readonly RejectedProfile[];
}

export function routeProfiles(
  task: AgentTask,
  sensitivity: Sensitivity,
  profiles: readonly ModelProfile[],
  policies: Readonly<Record<AgentTask, TaskPolicy>>,
): RoutingResult {
  const policy = policies[task];
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const chain: ModelProfile[] = [];
  const rejected: RejectedProfile[] = [];
  const seen = new Set<string>();

  const consider = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const profile = byId.get(id);
    if (!profile) {
      rejected.push({ id, reason: 'not_found' });
      return;
    }
    if (!profile.health.enabled) {
      rejected.push({ id, reason: 'disabled' });
      return;
    }
    if (policy.requires.contextTokens > profile.capabilities.contextTokens) {
      rejected.push({ id, reason: 'context_too_small' });
      return;
    }
    if (policy.requires.structuredOutput && !profile.capabilities.structuredOutput) {
      rejected.push({ id, reason: 'no_structured_output' });
      return;
    }
    if (policy.requires.toolCalls && !profile.capabilities.toolCalls) {
      rejected.push({ id, reason: 'no_tool_calls' });
      return;
    }
    if (!profile.capabilities.sensitivity.includes(sensitivity)) {
      rejected.push({ id, reason: `sensitivity_${sensitivity}_denied` });
      return;
    }
    chain.push(profile);
    for (const fallback of profile.health.fallbackTo) consider(fallback);
  };

  for (const id of policy.profileOrder) consider(id);
  return { chain, rejected };
}
