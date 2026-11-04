/** 档位配额 v1（设计文档 §4 / 生产逻辑）：claims 数量必须落在档位区间。 */
import type { DraftTier } from '../model/draft';

export interface ClaimLimits {
  readonly min: number;
  readonly max: number;
}

export const TIER_CLAIM_LIMITS: Readonly<Record<DraftTier, ClaimLimits>> = {
  patch: { min: 1, max: 25 },
  standard: { min: 1, max: 25 },
  accelerated: { min: 1, max: 12 },
  full: { min: 1, max: 60 },
};

export type ClaimCountVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'below_min'; readonly min: number; readonly actual: number }
  | { readonly kind: 'above_max'; readonly max: number; readonly actual: number };

/** 生成后按 claims 数量选择能容纳它的档位（不改变已满足的档位）。 */
export function fitTierForClaims(preferred: DraftTier, claimCount: number): DraftTier {
  if (claimCount <= TIER_CLAIM_LIMITS[preferred].max) return preferred;
  if (claimCount <= TIER_CLAIM_LIMITS.standard.max) return 'standard';
  if (claimCount <= TIER_CLAIM_LIMITS.full.max) return 'full';
  return preferred;
}

export function checkClaimCount(tier: DraftTier, claimCount: number): ClaimCountVerdict {
  const limits = TIER_CLAIM_LIMITS[tier];
  if (claimCount > limits.max) return { kind: 'above_max', max: limits.max, actual: claimCount };
  if (claimCount < limits.min) return { kind: 'below_min', min: limits.min, actual: claimCount };
  return { kind: 'ok' };
}
