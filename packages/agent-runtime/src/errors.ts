/** 运行时错误分类（对应 ADR 0005 §3.3 的重试/降级表）。 */
export type AgentRuntimeErrorCode =
  | 'NO_PROFILE'
  | 'BUDGET_EXCEEDED'
  | 'CONTRACT_VIOLATION'
  | 'REFUSAL'
  | 'PROVIDER_ERROR'
  | 'ALL_PROFILES_FAILED';

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: AgentRuntimeErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

export type ProviderErrorKind = 'timeout' | 'rate_limit' | 'upstream' | 'refusal';

/** provider 适配器必须抛这个类型，runner 才知道能不能重试/降级。 */
export class AgentProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AgentProviderError';
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof AgentProviderError && (error.kind === 'timeout' || error.kind === 'rate_limit' || error.kind === 'upstream');
}
