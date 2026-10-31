/** 缓存：key = contentHash + promptSha + profileId + 检索节点；命中则不再调用模型。 */
import { createHash } from 'node:crypto';
import type { DraftProposal } from '@sb/domain';

export interface CachedOutcome {
  readonly proposal: DraftProposal;
  readonly profileId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly createdAt: string;
}

export interface CompletionCache {
  get(key: string): CachedOutcome | undefined;
  set(key: string, value: CachedOutcome): void;
}

export class MemoryCompletionCache implements CompletionCache {
  private readonly store = new Map<string, CachedOutcome>();

  get(key: string): CachedOutcome | undefined {
    return this.store.get(key);
  }

  set(key: string, value: CachedOutcome): void {
    this.store.set(key, value);
  }

  get size(): number {
    return this.store.size;
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function proposalCacheKey(input: {
  readonly contentHash: string;
  readonly promptSha256: string;
  readonly profileId: string;
  readonly retrievedIds: readonly string[];
}): string {
  const retrieved = [...input.retrievedIds].sort().join('|');
  return sha256(`${input.contentHash}\n${input.promptSha256}\n${input.profileId}\n${retrieved}`);
}
