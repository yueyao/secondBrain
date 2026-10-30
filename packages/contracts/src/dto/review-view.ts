/**
 * 人审读模型（设计文档 §20.1，冻结为 v1）。
 * CLI 与将来的 UI 都只消费这一个 DTO；服务端不为 UI 做特例。
 */
import type {
  Claim,
  DraftId,
  DraftTier,
  NodeChange,
  RawPath,
  Severity,
} from '@sb/domain';

export const REVIEW_VIEW_SCHEMA_VERSION = 1 as const;

export interface ReviewViewFinding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly message: string;
  readonly detail: Record<string, unknown>;
}

export interface ReviewViewProvenance {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: number;
  readonly inputTokens: number | null;
  readonly latencyMs: number | null;
}

export interface ReviewViewV1 {
  readonly schemaVersion: typeof REVIEW_VIEW_SCHEMA_VERSION;
  readonly draftId: DraftId;
  readonly title: string;
  readonly rawPath: RawPath;
  readonly charCount: number;
  readonly tier: DraftTier;
  /** 领域状态名；保持字符串以免 DTO 与领域枚举强耦合。 */
  readonly state: string;
  readonly findings: readonly ReviewViewFinding[];
  readonly claims: readonly Claim[];
  readonly nodes: readonly NodeChange[];
  /** actions 直接驱动按钮可用性：blockedBy 非空即不可 accept。 */
  readonly actions: {
    readonly accept: boolean;
    readonly blockedBy: readonly string[];
  };
  readonly provenance: ReviewViewProvenance;
  readonly createdAt: string;
}
