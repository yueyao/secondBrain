/** id 生成是外部能力：领域与适配器都不读随机数/时间。 */
import type { DraftId } from '@sb/domain';

export interface IdGenerator {
  draftId(): DraftId;
  intentId(): string;
}
