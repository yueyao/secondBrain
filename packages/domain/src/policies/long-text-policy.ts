/** 长文策略 v1（设计文档 §17.4）：超过阈值直接 DEFERRED_TOO_LONG，不读全文。 */
export const LONG_TEXT_THRESHOLD = 60_000;
export const LONG_TEXT_POLICY_ID = 'long-text-policy';
export const LONG_TEXT_POLICY_VERSION = 1;

export function isTooLong(charCount: number, threshold: number = LONG_TEXT_THRESHOLD): boolean {
  return charCount > threshold;
}
