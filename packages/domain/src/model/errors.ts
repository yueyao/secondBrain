/**
 * 错误分类（设计文档 §17.1）。
 * 领域层只使用 DomainError；其余类别由适配器层产出，不得出现在 domain。
 */
export type ErrorClass =
  | 'InputError'
  | 'ParseError'
  | 'DomainError'
  | 'GateError'
  | 'AgentTimeout'
  | 'RateLimited'
  | 'Upstream5xx'
  | 'AgentContractViolation'
  | 'AgentRefusal'
  | 'BudgetExceeded'
  | 'ConcurrencyError'
  | 'StorageError'
  | 'VaultError';

export interface AppError {
  readonly errorClass: ErrorClass;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown> | null;
}

export interface DomainError extends AppError {
  readonly errorClass: 'DomainError';
}

/** 领域错误的唯一构造入口：不抛异常，作为 Result 的 error 值返回。 */
export function domainError(
  code: string,
  message: string,
  detail: Record<string, unknown> | null = null,
): DomainError {
  return { errorClass: 'DomainError', code, message, retryable: false, detail };
}

/** 重试策略表（设计文档 §17.2） */
export const RETRYABLE: Readonly<Record<ErrorClass, boolean>> = {
  InputError: false,
  ParseError: false,
  DomainError: false,
  GateError: false,
  AgentTimeout: true,
  RateLimited: true,
  Upstream5xx: true,
  AgentContractViolation: true,
  AgentRefusal: false,
  BudgetExceeded: false,
  ConcurrencyError: true,
  StorageError: true,
  VaultError: false,
};

export const MAX_JOB_ATTEMPTS = 3;
