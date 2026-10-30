import type {
  CommitRecord,
  DraftRecord,
  DraftStatus,
  EventRecord,
  JobKind,
  JobRecord,
  JobState,
  RawItemRecord,
  ReviewDecisionRecord,
} from '@sb/contracts';
import type { ContentHash, DraftId, DraftProposal, Finding, RawPath, TriageResult } from '@sb/domain';
import { decodeState, encodeState } from './state-codec';

export type Row = Record<string, unknown>;

const asString = (value: unknown): string => String(value);
const asNumber = (value: unknown): number => Number(value);
const asNullableString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const asNullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export function serializeState(state: RawItemRecord['state']): { kind: string; data: string } {
  const encoded = encodeState(state);
  return { kind: encoded.kind, data: JSON.stringify(encoded.data) };
}

export function rowToRawItem(row: Row): RawItemRecord {
  return {
    id: asNumber(row.id),
    rawPath: asString(row.path) as RawPath,
    contentHash: asString(row.content_hash) as ContentHash,
    sourceKey: asString(row.source_key),
    eventId: asNullableString(row.event_id),
    title: asString(row.title),
    charCount: asNumber(row.char_count),
    state: decodeState(asString(row.state), asString(row.state_data)),
    version: asNumber(row.version),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

export function rowToDraft(row: Row): DraftRecord {
  return {
    id: asString(row.id) as DraftId,
    rawItemId: asNumber(row.raw_item_id),
    proposal: JSON.parse(asString(row.proposal)) as DraftProposal,
    findings: JSON.parse(asString(row.findings)) as readonly Finding[],
    provider: asString(row.provider),
    model: asString(row.model),
    promptId: asString(row.prompt_id),
    promptVersion: asNumber(row.prompt_version),
    promptSha256: asString(row.prompt_sha256),
    inputTokens: asNullableNumber(row.input_tokens),
    outputTokens: asNullableNumber(row.output_tokens),
    latencyMs: asNullableNumber(row.latency_ms),
    status: asString(row.status) as DraftStatus,
    createdAt: asString(row.created_at),
  };
}

export function rowToJob(row: Row): JobRecord {
  return {
    id: asNumber(row.id),
    kind: asString(row.kind) as JobKind,
    target: asString(row.target),
    state: asString(row.state) as JobState,
    attempts: asNumber(row.attempts),
    fencingToken: asNumber(row.fencing_token),
    leaseUntil: asNullableString(row.lease_until),
    lastError: asNullableString(row.last_error),
  };
}

export function rowToEvent(row: Row): EventRecord {
  return {
    seq: asNumber(row.seq),
    at: asString(row.at),
    actor: asString(row.actor),
    type: asString(row.type),
    aggregateId: asString(row.aggregate_id),
    payload: JSON.parse(asString(row.payload)) as Record<string, unknown>,
  };
}

export function decisionToRow(record: ReviewDecisionRecord): readonly unknown[] {
  return [record.draftId, record.action, record.note, record.actor, record.createdAt];
}

export function commitToRow(record: CommitRecord): readonly unknown[] {
  return [record.draftId, record.gitSha, JSON.stringify(record.files), record.createdAt];
}

export function triageToJson(triage: TriageResult): string {
  return JSON.stringify(triage);
}
