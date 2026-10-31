/** 用量账本（ADR 0005 修订）：不做硬性预算拦截，只记录消耗并汇总。 */
import type { DraftId, RawPath } from '@sb/domain';

export interface UsageRecord {
  readonly at: string;
  readonly rawPath: RawPath;
  readonly draftId: DraftId;
  readonly profileId: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number | null;
  readonly cacheHit: boolean;
}

export interface UsageRepo {
  append(record: UsageRecord): Promise<void>;
  listAll(): Promise<readonly UsageRecord[]>;
  listByDay(day: string): Promise<readonly UsageRecord[]>;
}
