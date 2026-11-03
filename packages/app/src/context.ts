/** 应用层上下文：只包含端口，不含任何具体实现。 */
import type {
  AgentPort,
  Clock,
  ComposePort,
  DeAiPort,
  HashPort,
  IdGenerator,
  SearchIndex,
  StateStore,
  VaultPort,
} from '@sb/contracts';

export interface AppConfig {
  /** 超过该字数直接延后，不读全文（设计文档 §17.4） */
  readonly longTextThreshold: number;
  /** source-scope 启用的来源 */
  readonly enabledSources: readonly string[];
}

export interface ProfilePricing {
  readonly inPerMTokens: number;
  readonly outPerMTokens: number;
}

export interface AgentMeta {
  readonly provider: string;
  readonly model: string;
  readonly promptId: string;
  readonly promptVersion: number;
}

export interface AppContext {
  readonly store: StateStore;
  readonly vault: VaultPort;
  readonly search: SearchIndex;
  readonly agent: AgentPort;
  /** 主编台生成端口（Compose C2）：大纲与正文都走它；未配置模型时缺省。 */
  readonly composer?: ComposePort;
  /** 去 AI 味端口（独立能力）：未配置模型时缺省。 */
  readonly deAi?: DeAiPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly hash: HashPort;
  readonly config: AppConfig;
  /** 可选：mock/provider 自报身份（写进 provenance） */
  readonly agentMeta?: AgentMeta;
  /** 价格表：profileId → 单价（用于用量汇总的估算成本；空表则只统计 tokens） */
  readonly pricing?: Readonly<Record<string, ProfilePricing>>;
}

export type AppErrorCode =
  | 'NOT_FOUND'
  | 'TARGET_MOVED'
  | 'NO_CHANGES'
  | 'DIRTY_VAULT'
  | 'OUT_OF_SYNC'
  | 'INVALID_STATE'
  | 'GATE_BLOCKED'
  | 'UNKNOWN_NODE'
  | 'EMPTY_CLAIMS'
  | 'MODEL_UNAVAILABLE';

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}
