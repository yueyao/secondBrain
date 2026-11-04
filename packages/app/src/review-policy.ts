/**
 * 审核门禁的"当前策略"视角：部分 finding 是生成时的旧阈值产物。
 * 例如模型生成 16 条 claims（旧 standard 上限 15）被标 block；阈值调整后，
 * 按当前策略重新判断应视为可审，而不是让存量草稿永久不可用。
 */
import { checkClaimCount, type DraftTier, type Finding } from '@sb/domain';

interface ReviewPolicyDraft {
  readonly findings: readonly Finding[];
  readonly proposal: { readonly tier: DraftTier; readonly claims: readonly unknown[] };
}

/**
 * 按当前策略重新解释 finding：把"旧 standard 上限 15"造成的 claim-count block 降级为 warn。
 * 状态机 ACCEPT 仍会检查 raw state 里的 findings；accept 时必须传入这份 effective findings，
 * 否则会出现"预检通过、ACCEPT 仍报阻断"的裂脑。
 */
export function effectiveFindings(draft: ReviewPolicyDraft): readonly Finding[] {
  return draft.findings.map((finding) => {
    if (finding.severity === 'block' && finding.ruleId === 'r-claim-count'
      && checkClaimCount(draft.proposal.tier, draft.proposal.claims.length).kind === 'ok') {
      return { ...finding, severity: 'warn', message: `${finding.message}（按当前配额已可入库）` };
    }
    return finding;
  });
}

/** 当前仍然有效的阻断项（剔除"按当前档位配额已不超限"的 claim-count 旧 finding）。 */
export function effectiveBlockingFindings(draft: ReviewPolicyDraft): readonly Finding[] {
  return effectiveFindings(draft).filter((finding) => finding.severity === 'block');
}
