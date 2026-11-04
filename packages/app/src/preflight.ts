/**
 * 批量通过预检：在创建 job 之前逐篇判断"能不能进"。
 * 目的：避免别名/目标缺失/阻断点导致整批 accept 先标记 approved 再回滚（raw 进入 rolled_back）。
 */
import { parseDraftId } from '@sb/domain';
import type { AppContext } from './context';
import { reviewDraftTargetFiles } from './commands';
import { effectiveBlockingFindings } from './review-policy';

export interface PreflightRow {
  readonly draftId: string;
  readonly status: 'ok' | 'blocked' | 'invalid';
  readonly reason: string | null;
}

export interface PreflightReport {
  readonly ok: number;
  readonly blocked: number;
  readonly invalid: number;
  readonly rows: readonly PreflightRow[];
}

export async function preflightDrafts(ctx: AppContext, draftIds: readonly string[]): Promise<PreflightReport> {
  const rows: PreflightRow[] = [];
  for (const draftId of draftIds) {
    const parsedId = parseDraftId(draftId);
    if (!parsedId.ok) {
      rows.push({ draftId, status: 'invalid', reason: '草稿 id 不合法' });
      continue;
    }
    const draft = await ctx.store.transaction(async (tx) => tx.drafts.get(parsedId.value));
    if (!draft) {
      rows.push({ draftId, status: 'invalid', reason: '草稿不存在' });
      continue;
    }
    const blocking = effectiveBlockingFindings(draft);
    if (blocking.length > 0) {
      rows.push({ draftId, status: 'blocked', reason: blocking[0]?.message ?? '存在阻断级预警' });
      continue;
    }
    try {
      await reviewDraftTargetFiles(ctx, draft.id);
      rows.push({ draftId, status: 'ok', reason: null });
    } catch (error) {
      rows.push({ draftId, status: 'invalid', reason: String((error as Error).message ?? error) });
    }
  }
  return {
    ok: rows.filter((row) => row.status === 'ok').length,
    blocked: rows.filter((row) => row.status === 'blocked').length,
    invalid: rows.filter((row) => row.status === 'invalid').length,
    rows,
  };
}
