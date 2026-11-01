/**
 * Legacy 导入 apply：把 dry-run 计算出的状态写入 SQLite（不写文件、不动 git）。
 *
 * 用法：
 *   pnpm import:apply --state .sb-import-test            # 预演（只读，不写库）
 *   pnpm import:apply --state .sb-import-test --apply    # 写入 + 验证
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseCommitSha,
  parseContentHash,
  parseDraftId,
  parseRawPath,
  type RawState,
} from '@sb/domain';
import { migrate, SqliteStore } from '@sb/adapters-sqlite';
import { ingestAndTriage } from '@sb/app';
import { buildLegacyPlan, BASELINE_COMMIT_SHA, syntheticDraftId } from './legacy-plan.ts';

const DEFAULT_VAULT = '/Users/dynamic/workspace/secondBrain';

function argValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function hashOf(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function must<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const vault = path.resolve(argValue(argv, '--vault') ?? DEFAULT_VAULT);
  const stateDir = path.resolve(argValue(argv, '--state') ?? '.sb-import-test');
  const apply = argv.includes('--apply');

  const plan = buildLegacyPlan(vault);
  const { summary } = plan;
  console.log(JSON.stringify({ phase: 'plan', vault, stateDir, apply, summary, conflicts: plan.conflicts }, null, 2));

  if (!apply) {
    console.log('\n预演模式：未写入任何数据。加 --apply 执行导入。');
    return;
  }

  fs.mkdirSync(stateDir, { recursive: true });
  const clock = { now: () => new Date().toISOString() };
  const store = SqliteStore.open({ path: path.join(stateDir, 'state.db'), clock });
  migrate(store.database, clock);

  try {
    const existing = new Set(
      (await store.transaction(async (tx) => tx.rawItems.listAll())).map((item) => String(item.rawPath)),
    );

    const now = clock.now();
    const commitSha = must(parseCommitSha(BASELINE_COMMIT_SHA));
    let inserted = 0;
    let skipped = 0;

    await store.transaction(async (tx) => {
      for (const item of plan.items) {
        if (existing.has(item.rawPath)) {
          skipped += 1;
          continue;
        }
        const rawPath = must(parseRawPath(item.rawPath));
        const contentHash = must(parseContentHash(hashOf(fs.readFileSync(path.join(vault, item.rawPath), 'utf8'))));

        let state: RawState;
        if (item.kind === 'committed') {
          state = {
            kind: 'committed',
            draftId: must(parseDraftId(syntheticDraftId(item.rawPath))),
            triage: {
              status: item.triage.status,
              score: item.triage.score,
              reasons: item.triage.reasons as never,
              judgments: item.triage.judgments,
              charCount: item.triage.charCount,
              policyId: item.triage.policyId,
              policyVersion: item.triage.policyVersion,
            },
            commitSha,
          };
        } else if (item.kind === 'queued') {
          state = {
            kind: 'queued',
            triage: {
              status: item.triage.status === 'low' ? 'medium' : item.triage.status,
              score: item.triage.score,
              reasons: item.triage.reasons as never,
              judgments: item.triage.judgments,
              charCount: item.triage.charCount,
              policyId: item.triage.policyId,
              policyVersion: item.triage.policyVersion,
            },
          };
        } else {
          const reason = item.reason ?? 'low_value';
          const triageWorth = item.triage.status !== 'low';
          state = {
            kind: 'deferred',
            reason,
            triage: (reason === 'too_long' || reason === 'source_disabled' || triageWorth)
              ? {
                  status: item.triage.status,
                  score: item.triage.score,
                  reasons: item.triage.reasons as never,
                  judgments: item.triage.judgments,
                  charCount: item.triage.charCount,
                  policyId: item.triage.policyId,
                  policyVersion: item.triage.policyVersion,
                }
              : null,
          };
        }

        await tx.rawItems.upsert({
          id: 0,
          rawPath,
          contentHash,
          sourceKey: item.sourceKey,
          eventId: null,
          title: item.title,
          charCount: item.triage.charCount,
          state,
          version: 0,
          createdAt: now,
          updatedAt: now,
        });
        inserted += 1;
      }

      if (inserted > 0) {
        await tx.events.append({
          at: now,
          actor: 'system',
          type: 'import:legacy',
          aggregateId: 'raw',
          payload: {
            inserted,
            skipped,
            summary,
            baselineCommit: BASELINE_COMMIT_SHA,
          },
        });
      }
    });

    console.log(JSON.stringify({ phase: 'import', inserted, skipped, stateDb: path.join(stateDir, 'state.db') }, null, 2));

    // 验证：ingest 不应该新增任何条目
    const before = (await store.transaction(async (tx) => tx.rawItems.listAll())).length;
    const { createRuntime } = await import('../apps/server/src/runtime.ts');
    const runtime = await createRuntime({ dataDir: stateDir, vaultRoot: vault, seedDemo: false });
    try {
      const outcomes = await ingestAndTriage(runtime.ctx);
      const after = (await runtime.ctx.store.transaction(async (tx) => tx.rawItems.listAll())).length;
      const kinds: Record<string, number> = {};
      for (const outcome of outcomes) kinds[outcome.state] = (kinds[outcome.state] ?? 0) + 1;
      console.log(JSON.stringify({
        phase: 'verify',
        before,
        after,
        observed: outcomes.length,
        outcomesByState: kinds,
        newItems: after - before,
        ok: after === before,
      }, null, 2));
    } finally {
      await runtime.close();
    }
  } finally {
    await store.close();
  }
}

main().catch((error: unknown) => {
  console.error(`✗ import apply 失败：${String((error as Error).message ?? error)}`);
  process.exit(1);
});
