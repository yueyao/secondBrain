import type { RawState, RawStateKind } from '@sb/domain';

const KINDS: readonly RawStateKind[] = [
  'ingested',
  'triaged',
  'quarantined',
  'queued',
  'drafting',
  'draft_ready',
  'in_review',
  'changes_requested',
  'approved',
  'committing',
  'committed',
  'rejected',
  'deferred',
  'rolled_back',
  'failed',
  'blocked',
  'expired',
  'abandoned',
];

export interface EncodedState {
  readonly kind: RawStateKind;
  readonly data: Record<string, unknown>;
}

/** 状态 → (kind 列, JSON 列)。kind 单独存一列，便于按状态建索引与查询。 */
export function encodeState(state: RawState): EncodedState {
  const record: Record<string, unknown> = { ...(state as unknown as Record<string, unknown>) };
  const kind = record.kind as RawStateKind;
  delete record.kind;
  return { kind, data: record };
}

/** 读库时校验结构与枚举：坏数据要在适配器边界就暴露，不能流进领域层。 */
export function decodeState(kind: string, raw: string): RawState {
  if (!KINDS.includes(kind as RawStateKind)) {
    throw new Error(`INVALID_STATE_KIND: ${kind}`);
  }
  const data: unknown = JSON.parse(raw);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`INVALID_STATE_DATA: ${kind}`);
  }
  return { kind, ...(data as Record<string, unknown>) } as unknown as RawState;
}
