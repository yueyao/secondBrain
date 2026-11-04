/**
 * 问答链端口（P1，借鉴李继刚 ljg-qa 的方法）：
 * 把一段材料（主题 claims / 文章正文）抽成"Q-A 链"——Q 切要害，A 四段收口。
 *
 * 设计取舍：
 * - 与 DeAi 不同，输出是**生成物**而非改写，不要求引用只减不增；
 *   但提示词仍要求引用材料里的判断时保留原有 `（来源：[[raw/...]]）` 标记，不得编造。
 * - 结构契约由本地校验兜底：必须是指定数量的 `### Qn.` 块，且每块含
 *   结论 / 形式化 / 论证步 / 边界 四段；不合规回喂原因重试一次。
 */
import type { AgentProvenance } from './agent';

export type QaSourceKind = 'topic' | 'article';

export interface QaRequest {
  readonly sourceKind: QaSourceKind;
  readonly sourceId: string;
  readonly sourceTitle: string;
  /** 材料文本（主题定义+claims，或文章正文）；原样进入提示词。 */
  readonly sourceText: string;
  /** 期望问题数量区间（含端点）。 */
  readonly questionCount: { readonly min: number; readonly max: number };
  /** 用户可选的聚焦问题（例如"只问代价和边界"）。 */
  readonly focus: string | null;
}

export interface QaResult {
  readonly markdown: string;
  readonly questionCount: number;
  readonly provenance: AgentProvenance;
  readonly cost: number;
}

export interface QaPort {
  generate(request: QaRequest): Promise<QaResult>;
}
