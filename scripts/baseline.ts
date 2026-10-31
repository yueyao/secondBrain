/**
 * 真实模型基线（单篇）：从真实 vault 复制多篇候选文章到隔离 vault，
 * 先看 triage 分布，再挑一篇 queued 的走 digest →（可选）accept。
 *
 * 用法：
 *   MODEL_API_KEY=... pnpm baseline [--raw <文章路径>] [--no-accept] [--limit 30]
 *
 * 安全：key 只从 MODEL_API_KEY 读取，绝不打印、不落盘、不写进配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ingestAndTriage, draftDigest, decideReview, usageSummary } from '@sb/app';
import { parseRawPath, type RawPath, type RawState, type TriageResult } from '@sb/domain';
import { createRuntime } from '../apps/server/src/runtime.ts';

const REAL_VAULT = process.env.REAL_VAULT ?? '/Users/dynamic/workspace/secondBrain';
const CANDIDATE_DIR = path.join(REAL_VAULT, 'raw/knowledge/cubox');

function parseArgs(argv: readonly string[]): { raw: string | null; accept: boolean; limit: number } {
  let raw: string | null = null;
  let accept = true;
  let limit = 30;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--raw') {
      raw = argv[index + 1] ?? null;
      index += 1;
    } else if (value === '--no-accept') {
      accept = false;
    } else if (value === '--limit') {
      limit = Number(argv[index + 1] ?? '30');
      index += 1;
    }
  }
  return { raw, accept, limit };
}

function candidates(limit: number): string[] {
  if (!fs.existsSync(CANDIDATE_DIR)) throw new Error(`找不到真实 vault：${CANDIDATE_DIR}（可用 REAL_VAULT 指定）`);
  return fs
    .readdirSync(CANDIDATE_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(CANDIDATE_DIR, name))
    .filter((file) => {
      const size = fs.statSync(file).size;
      return size > 5_000 && size < 15_000;
    })
    .sort()
    .slice(0, limit);
}

function triageOf(state: RawState | undefined): TriageResult | null {
  if (!state) return null;
  return 'triage' in state ? (state.triage as TriageResult) : null;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

async function main(): Promise<void> {
  if (!process.env.MODEL_API_KEY) {
    console.error('缺少 MODEL_API_KEY（从环境变量给，不要写进文件或聊天）');
    process.exit(1);
  }

  const { raw, accept, limit } = parseArgs(process.argv.slice(2));
  const files = raw ? [path.resolve(REAL_VAULT, raw)] : candidates(limit);
  if (files.length === 0) throw new Error('没有 5-15KB 的 cubox 文章可作为样本');

  const dataDir = process.env.DATA_DIR ?? '.sb-real';
  const runtime = await createRuntime({ dataDir, seedDemo: false });

  try {
    // 1) 复制候选原文到隔离 vault
    const imported: string[] = [];
    for (const file of files) {
      const relative = path.join('raw/knowledge/cubox', path.basename(file));
      const dest = path.join(runtime.vault.rootDir, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      imported.push(relative);
    }
    await runtime.search.refresh();

    // 2) 摄取 + triage：先看分布
    const ingestStarted = Date.now();
    await ingestAndTriage(runtime.ctx);
    const ingestMs = Date.now() - ingestStarted;
    const items = await runtime.ctx.store.transaction(async (tx) => tx.rawItems.listAll());
    const distribution: Record<string, number> = {};
    for (const item of items) distribution[item.state.kind] = (distribution[item.state.kind] ?? 0) + 1;

    const queued = await runtime.ctx.store.transaction(async (tx) => tx.rawItems.listByState(['queued']));
    const triageTable = imported.map((relative) => {
      const item = items.find((entry) => String(entry.rawPath) === relative);
      const triage = triageOf(item?.state);
      return {
        article: relative,
        state: item?.state.kind ?? 'missing',
        judgments: triage?.judgments ?? null,
        score: triage?.score ?? null,
        reasons: triage?.reasons?.map((reason) => reason.code) ?? [],
      };
    });

    if (queued.length === 0) {
      console.error(JSON.stringify({ ok: false, stage: 'triage', distribution, triageTable }, null, 2));
      console.error('\n✗ 候选文章全部未进入 queued（大多被判 deferred）。换一批样本或用 --raw 指定一篇。');
      process.exit(2);
    }

    // 3) 挑一篇 queued（判断句最多的）
    const chosen = [...queued].sort(
      (a, b) => (triageOf(b.state)?.judgments ?? 0) - (triageOf(a.state)?.judgments ?? 0),
    )[0] as (typeof queued)[number];
    const rawPath = chosen.rawPath as RawPath;
    const article = String(rawPath);

    // 4) digest
    const started = Date.now();
    const draft = await draftDigest(runtime.ctx, rawPath);
    const elapsed = Date.now() - started;

    // 5) 可选 accept
    let commit: string | null = null;
    let acceptError: string | null = null;
    if (accept) {
      try {
        const result = await decideReview(runtime.ctx, draft.draftId, 'accept', { actor: 'owner', note: '真实模型基线' });
        commit = result.commit ?? null;
      } catch (error) {
        acceptError = String((error as Error).message);
      }
    }

    const usage = await usageSummary(runtime.ctx);
    const report = {
      ok: true,
      article,
      candidates: imported.length,
      ingestMs,
      distribution,
      triageTable,
      mode: runtime.mode,
      config: process.env.MODEL_CONFIG ?? 'config/model-profiles.json',
      elapsedMs: elapsed,
      draftId: draft.draftId,
      tier: draft.proposal.tier,
      rationale: draft.proposal.rationale,
      claims: draft.proposal.claims,
      nodes: draft.proposal.nodes,
      findings: draft.findings.map((finding) => ({ code: finding.code, severity: finding.severity, message: finding.message })),
      commit,
      acceptError,
      usage: {
        calls: usage.totals.calls,
        inputTokens: usage.totals.inputTokens,
        outputTokens: usage.totals.outputTokens,
        cacheHits: usage.totals.cacheHits,
        estimatedCostUsd: Number(formatUsd(usage.totals.estimatedCost).slice(1)),
        byProfile: usage.byProfile,
      },
    };

    fs.writeFileSync(path.join(dataDir, 'baseline-result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await runtime.close();
  }
}

main().catch((error: unknown) => {
  console.error(`✗ 基线运行失败：${String((error as Error).message ?? error)}`);
  process.exit(1);
});
