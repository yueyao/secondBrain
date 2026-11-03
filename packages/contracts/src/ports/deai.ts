/**
 * 去 AI 味端口（独立能力）：把模型味重的文本改写成更自然的人话。
 *
 * 设计参考业界实践（Wikipedia:Signs of AI writing、中文 humanizer 清单、CCL 2023 量化研究）：
 * - 改写不是"洗稿"，必须**保留全部事实、数字、观点归属与引用标记**；
 * - 不编造第一人称经历、不新增原文没有的信息（这是业内公认最容易翻车的地方）；
 * - 模型只做表达改写，判断"哪里像 AI"由 @sb/domain 的确定性体检负责。
 */
import type { AgentProvenance } from './agent';

export type DeAiStyle = 'auto' | 'casual' | 'formal' | 'opinion';

/** 体检命中的 AI 味项，作为提示词输入（按项清除，避免模型自由发挥）。 */
export interface DeAiIssue {
  readonly category: string;
  readonly label: string;
  readonly count: number;
  readonly examples: readonly string[];
}

export interface DeAiRequest {
  readonly text: string;
  readonly title: string | null;
  readonly style: DeAiStyle;
  readonly issues: readonly DeAiIssue[];
  /** 原文中必须原样保留的引用来源（`raw/...` 路径），不得删除或改写。 */
  readonly keepCitations: readonly string[];
  /** 改写目标长度区间（应用层按原文比例给定），防止越改越短/越改越长。 */
  readonly target: { readonly minChars: number; readonly maxChars: number };
  readonly instruction: string | null;
}

export interface DeAiResult {
  readonly text: string;
  readonly provenance: AgentProvenance;
  readonly cost: number;
}

export interface DeAiPort {
  humanize(request: DeAiRequest): Promise<DeAiResult>;
}
