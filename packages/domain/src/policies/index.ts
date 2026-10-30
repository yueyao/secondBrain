/** 策略公开面：外层只从这里引用策略，便于后续版本化（v1 → v2）时统一替换。 */
export {
  decideTriage,
  isQueuedStatus,
  TRIAGE_POLICY_ID,
  TRIAGE_POLICY_VERSION,
  type TriagePolicyInput,
} from './triage-policy';
export {
  isTooLong,
  LONG_TEXT_POLICY_ID,
  LONG_TEXT_POLICY_VERSION,
  LONG_TEXT_THRESHOLD,
} from './long-text-policy';
export {
  checkClaimCount,
  TIER_CLAIM_LIMITS,
  type ClaimCountVerdict,
  type ClaimLimits,
} from './tier-policy';
