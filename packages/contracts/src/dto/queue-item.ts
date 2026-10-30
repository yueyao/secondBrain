/** 队列读模型 v1：CLI 列表与未来 UI 首页共用。 */
import type { DraftId, RawPath, RawStateKind, TriageResult } from '@sb/domain';

export const QUEUE_ITEM_SCHEMA_VERSION = 1 as const;

export interface QueueItemV1 {
  readonly schemaVersion: typeof QUEUE_ITEM_SCHEMA_VERSION;
  readonly rawPath: RawPath;
  readonly title: string;
  readonly state: RawStateKind;
  readonly charCount: number;
  readonly triage: TriageResult | null;
  readonly draftId: DraftId | null;
}
