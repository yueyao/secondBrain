/**
 * 审核门禁的"当前策略"视角：部分 finding 是生成时的旧阈值产物。
 * 例如模型生成 16 条 claims（旧 standard 上限 15）被标 block；阈值调整后，
 * 按当前策略重新判断应视为可审，而不是让存量草稿永久不可用。
 */
import { checkClaimCount, type DraftTier } from '@sb/domain';

interface ReviewPolicyDraft {
  readonly findings: readonly { readonly ruleId: string; readonly severity: string; readonly message: string }[];
  readonly proposal: { readonly tier: DraftTier; readonly claims: readonly unknown[] };
}

/** 当前仍然有效的阻断项（剔除"按当前档位配额已不超限"的 claim-count 旧 finding）。 */
export function effectiveBlockingFindings(draft: ReviewPolicyDraft): readonly { readonly ruleId: string; readonly severity: string; readonly message: string }[] {
  return draft.findings.filter((finding) => {
    if (finding.severity !== 'block') return false;
    if (finding.ruleId === 'r-claim-count') {
      return checkClaimCount(draft.proposal.tier, draft.proposal.claims.length).kind !== 'ok';
    }
    return true;
  });
}
