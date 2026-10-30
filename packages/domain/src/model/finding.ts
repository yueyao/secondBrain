/**
 * 预警是数据，不是字符串（设计文档 §11 / §17）。
 * 规则返回 Finding；block 级 Finding 会阻止 accept，且不依赖任何 I/O。
 */

export type Severity = 'block' | 'warn' | 'ok';

export interface Finding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
  readonly detail: Record<string, unknown>;
}

export interface Rule<I> {
  readonly id: string;
  readonly defaultSeverity: Severity;
  readonly description: string;
  /** 不适用时返回 null（而不是 ok 级 Finding），以保持输出精简。 */
  evaluate(input: I): Finding | null;
}

export function makeFinding(
  ruleId: string,
  severity: Severity,
  code: string,
  message: string,
  detail: Record<string, unknown> = {},
): Finding {
  return { ruleId, severity, code, message, detail };
}

export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { block: 0, warn: 1, ok: 2 };

export function hasBlock(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === 'block');
}

export function blockFindings(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter((f) => f.severity === 'block');
}

export function summarizeSeverity(findings: readonly Finding[]): Severity {
  if (hasBlock(findings)) return 'block';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  return 'ok';
}

export function sortFindings(findings: readonly Finding[]): readonly Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    return bySeverity !== 0 ? bySeverity : a.ruleId.localeCompare(b.ruleId);
  });
}
