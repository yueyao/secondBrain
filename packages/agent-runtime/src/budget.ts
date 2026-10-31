/** 预算（ADR 0005 §3.1）：调用前估算，三级闸门。 */
import type { Clock } from '@sb/contracts';
import { AgentRuntimeError } from './errors';
import type { ModelProfile } from './route';

export interface BudgetLimits {
  /** 单次任务上限；不填 = 纯计量模式，不拦截 */
  readonly taskCostLimit?: number;
  /** 每日上限；不填 = 纯计量模式，不拦截 */
  readonly dailyCostLimit?: number;
}

export interface CostEstimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
}

const TOKENS_PER_CJK_CHAR = 0.7;
const PROMPT_OVERHEAD_TOKENS = 800;

export function estimateCost(input: {
  readonly charCount: number;
  readonly retrievedChars: number;
  readonly expectedClaims: number;
  readonly maxOutputTokens: number;
  readonly profile: ModelProfile;
}): CostEstimate {
  const inputTokens =
    Math.ceil(input.charCount * TOKENS_PER_CJK_CHAR) +
    Math.ceil(input.retrievedChars * TOKENS_PER_CJK_CHAR) +
    PROMPT_OVERHEAD_TOKENS;
  const outputTokens = Math.min(input.maxOutputTokens, 400 + input.expectedClaims * 120);
  const cost =
    (inputTokens / 1_000_000) * input.profile.pricing.inPerMTokens +
    (outputTokens / 1_000_000) * input.profile.pricing.outPerMTokens;
  return { inputTokens, outputTokens, cost };
}

export function costOf(
  usage: { readonly inputTokens: number; readonly outputTokens: number },
  profile: ModelProfile,
): number {
  return (
    (usage.inputTokens / 1_000_000) * profile.pricing.inPerMTokens +
    (usage.outputTokens / 1_000_000) * profile.pricing.outPerMTokens
  );
}

export class BudgetLedger {
  private day: string;
  private dailyCost = 0;
  private dailyInputTokens = 0;
  private dailyOutputTokens = 0;

  constructor(
    private readonly limits: BudgetLimits,
    private readonly clock: Clock,
  ) {
    this.day = this.dayKey();
  }

  private dayKey(): string {
    return this.clock.now().slice(0, 10);
  }

  private rollover(): void {
    const key = this.dayKey();
    if (key === this.day) return;
    this.day = key;
    this.dailyCost = 0;
    this.dailyInputTokens = 0;
    this.dailyOutputTokens = 0;
  }

  /** 调用前检查：单次超限直接拒；每日超限只拦新任务。 */
  preflight(estimatedCost: number): void {
    this.rollover();
    const taskLimit = this.limits.taskCostLimit;
    if (taskLimit !== undefined && estimatedCost > taskLimit) {
      throw new AgentRuntimeError('BUDGET_EXCEEDED', '单次任务成本预估超限', {
        estimatedCost,
        taskCostLimit: taskLimit,
      });
    }
    const dailyLimit = this.limits.dailyCostLimit;
    if (dailyLimit !== undefined && this.dailyCost + estimatedCost > dailyLimit) {
      throw new AgentRuntimeError('BUDGET_EXCEEDED', '每日预算不足，暂停新任务', {
        estimatedCost,
        dailyCost: this.dailyCost,
        dailyCostLimit: dailyLimit,
      });
    }
  }

  record(cost: { readonly cost: number; readonly inputTokens: number; readonly outputTokens: number }): void {
    this.rollover();
    this.dailyCost += cost.cost;
    this.dailyInputTokens += cost.inputTokens;
    this.dailyOutputTokens += cost.outputTokens;
  }

  snapshot(): { readonly day: string; readonly dailyCost: number; readonly dailyInputTokens: number; readonly dailyOutputTokens: number } {
    this.rollover();
    return {
      day: this.day,
      dailyCost: this.dailyCost,
      dailyInputTokens: this.dailyInputTokens,
      dailyOutputTokens: this.dailyOutputTokens,
    };
  }
}
