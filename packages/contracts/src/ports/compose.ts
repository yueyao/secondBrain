/**
 * 主编台生成端口（Compose C2，ADR 0005 修订）。
 *
 * 模型只产出 Markdown（大纲 / 正文）；引用不靠模型自报结构，而是从正文里的
 * `（来源：[[raw/...]]）` 标记解析，保证"每句话能回溯到原文"。
 * 预算 / 重试 / 降级 / provenance 由 @sb/agent-runtime 的实现负责；
 * 应用层只依赖这个端口，不关心模型世界。
 */
import type { AgentProvenance } from './agent';
import type { ArticleCitation } from './article';

export type ComposeKind = 'outline' | 'body';

/** 一个知识节点能提供给模型的材料：名称 + 已入库的 claims。 */
export interface ComposeNodeMaterial {
  readonly name: string;
  readonly nodeType: string;
  readonly claims: readonly { readonly text: string; readonly source: string }[];
}

export interface ComposeRequest {
  readonly kind: ComposeKind;
  readonly title: string;
  readonly theme: string;
  /** kind=body 时必填：已确认的大纲；kind=outline 时为 null。 */
  readonly outline: string | null;
  readonly nodes: readonly ComposeNodeMaterial[];
  /** 改稿指令（C3 用；v1 为 null）。 */
  readonly instruction: string | null;
}

export interface ComposeResult {
  /** 大纲或正文的 Markdown。 */
  readonly text: string;
  /** 正文里出现的引用（按来源去重）；大纲为空。 */
  readonly citations: readonly ArticleCitation[];
  readonly provenance: AgentProvenance;
  /** 本次调用估算成本；缓存命中为 0。 */
  readonly cost: number;
}

export interface ComposePort {
  write(request: ComposeRequest): Promise<ComposeResult>;
}
