/**
 * Legacy 导入计划（只读计算，供 dry-run 与 apply 共用）。
 * 口径（2026-11-01 决策 C）：队列 = 旧 cache medium/high ∪ 新规则 triage 达标（并集）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  countJudgmentSentences,
  decideTriage,
  parseFrontmatter,
  type TriageStatus,
} from '@sb/domain';

export const LONG_TEXT_THRESHOLD = Number(process.env.LONG_TEXT_THRESHOLD ?? 200_000);
export const ENABLED_SOURCES = new Set(['cubox', 'notions', 'podcast', 'dedao', 'general']);
export const BASELINE_COMMIT_SHA =
  process.env.LEGACY_COMMIT_SHA ?? 'ba2e0a04ab9a08b8048a157179608c8e88253f77';

export type PlanKind = 'committed' | 'queued' | 'deferred';
export type DeferReason = 'low_value' | 'source_disabled' | 'too_long' | 'user';

export interface PlanTriage {
  readonly status: TriageStatus;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly judgments: number;
  readonly charCount: number;
  readonly policyId: string;
  readonly policyVersion: number;
}

export interface PlanItem {
  readonly rawPath: string;
  readonly sourceKey: string;
  readonly title: string;
  readonly contentHash: string;
  readonly kind: PlanKind;
  readonly reason?: DeferReason;
  readonly triage: PlanTriage;
  /** 来源说明：legacy / retriage / both / wiki / review / meta / disabled / long */
  readonly origin: string;
}

export interface LegacyPlanSummary {
  readonly rawFiles: number;
  readonly committed: number;
  readonly queued: number;
  readonly queuedLegacyOnly: number;
  readonly queuedRetriageOnly: number;
  readonly queuedBoth: number;
  readonly deferred: number;
  readonly deferredBreakdown: Readonly<Record<DeferReason, number>>;
  readonly metaFiles: number;
}

export interface LegacyPlan {
  readonly items: readonly PlanItem[];
  readonly summary: LegacyPlanSummary;
  readonly conflicts: {
    readonly wikiMissingOnDisk: number;
    readonly cacheMissingOnDisk: number;
  };
}

function nfc(value: string): string {
  return value.normalize('NFC').trim();
}

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  }
  return out;
}

interface CacheEntry {
  readonly triageStatus: TriageStatus | null;
  readonly triageScore: number | null;
  readonly triageReasons: readonly string[];
  readonly digestStatus: string | null;
  readonly title: string;
  readonly contentHash: string;
}

export function buildLegacyPlan(vaultInput: string): LegacyPlan {
  const vault = path.resolve(vaultInput);
  const rawRoot = path.join(vault, 'raw');
  if (!fs.existsSync(rawRoot)) throw new Error(`缺少 raw/：${rawRoot}`);

  // raw 文件
  const rawPaths = walkMarkdown(rawRoot).map((file) =>
    nfc(path.relative(vault, file).split(path.sep).join('/')),
  );

  // 旧 cache
  const cacheFile = path.join(vault, '_workspace/cache/raw-processing-cache.json');
  const cacheRaw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
    items: Record<string, Record<string, unknown>>;
  };
  const cache = new Map<string, CacheEntry>();
  for (const [key, value] of Object.entries(cacheRaw.items)) {
    const triage = (value.triage ?? {}) as Record<string, unknown>;
    const digest = (value.digest ?? {}) as Record<string, unknown>;
    const status = triage.status;
    cache.set(nfc(key), {
      triageStatus:
        status === 'high' || status === 'medium' || status === 'low' ? status : null,
      triageScore: typeof triage.score === 'number' ? triage.score : null,
      triageReasons: Array.isArray(triage.reasons) ? triage.reasons.map(String) : [],
      digestStatus: typeof digest.status === 'string' ? digest.status : null,
      title: String(value.title ?? ''),
      contentHash: String(value.content_hash ?? ''),
    });
  }

  // wiki 引用
  const wikiSet = new Set<string>();
  for (const file of walkMarkdown(path.join(vault, 'wiki'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\[\[(raw\/[^\]|#]+)/g)) wikiSet.add(nfc(match[1] as string));
  }

  const items: PlanItem[] = [];
  const breakdown: Record<DeferReason, number> = { low_value: 0, source_disabled: 0, too_long: 0, user: 0 };
  let committed = 0;
  let queued = 0;
  let queuedLegacyOnly = 0;
  let queuedRetriageOnly = 0;
  let queuedBoth = 0;
  let metaFiles = 0;

  for (const rawPath of rawPaths) {
    const absolute = path.join(vault, rawPath);
    const content = fs.readFileSync(absolute, 'utf8');
    const { body } = parseFrontmatter(content);
    const size = content.length;
    const judgments = countJudgmentSentences(body);
    const sourceKey = rawPath.split('/')[2] ?? 'unknown';
    const cached = cache.get(rawPath);
    const triage = decideTriage({ judgments, charCount: size });
    const baseTriage: PlanTriage = {
      status: triage.status,
      score: triage.score,
      reasons: triage.reasons,
      judgments,
      charCount: size,
      policyId: triage.policyId,
      policyVersion: triage.policyVersion,
    };
    const legacyTriage: PlanTriage | null = cached && cached.triageStatus
      ? {
          status: cached.triageStatus,
          score: cached.triageScore ?? triage.score,
          reasons: cached.triageReasons,
          judgments,
          charCount: size,
          policyId: 'legacy-cache',
          policyVersion: 1,
        }
      : null;

    const isMeta = path.basename(rawPath).startsWith('_');
    const origin = isMeta
      ? 'meta'
      : wikiSet.has(rawPath)
        ? 'wiki'
        : cached?.digestStatus === 'digested'
          ? 'review'
          : size > LONG_TEXT_THRESHOLD
            ? 'long'
            : cached?.digestStatus === 'deferred'
              ? 'legacy-deferred'
              : !ENABLED_SOURCES.has(sourceKey)
                ? 'disabled'
                : cached && (cached.triageStatus === 'medium' || cached.triageStatus === 'high')
                  ? 'legacy'
                  : triage.status === 'low'
                    ? 'low'
                    : 'retriage';

    const planTriage = legacyTriage ?? baseTriage;
    let kind: PlanKind;
    let reason: DeferReason | undefined;

    if (isMeta) {
      metaFiles += 1;
      kind = 'deferred';
      reason = 'user';
    } else if (wikiSet.has(rawPath)) {
      committed += 1;
      kind = 'committed';
    } else if (origin === 'review') {
      kind = 'deferred';
      reason = 'user';
    } else if (origin === 'long') {
      kind = 'deferred';
      reason = 'too_long';
    } else if (origin === 'disabled') {
      kind = 'deferred';
      reason = 'source_disabled';
    } else if (origin === 'retriage' || origin === 'low') {
      // 旧台账没有 medium/high；这里看新规则是否达标
      if (triage.status !== 'low') {
        queued += 1;
        queuedRetriageOnly += 1;
        kind = 'queued';
      } else {
        kind = 'deferred';
        reason = 'low_value';
      }
    } else {
      // legacy / legacy-deferred：旧台账 medium/high 优先入队（决策 C 并集）
      const legacyWorth = cached?.triageStatus === 'medium' || cached?.triageStatus === 'high';
      const retriageWorth = triage.status !== 'low';
      if (legacyWorth || retriageWorth) {
        queued += 1;
        if (legacyWorth && retriageWorth) queuedBoth += 1;
        else if (legacyWorth) queuedLegacyOnly += 1;
        else queuedRetriageOnly += 1;
        kind = 'queued';
      } else {
        kind = 'deferred';
        reason = 'low_value';
      }
    }

    if (kind === 'deferred' && reason) breakdown[reason] += 1;

    items.push({
      rawPath,
      sourceKey,
      title: cached?.title || (rawPath.split('/').pop() ?? rawPath),
      contentHash: cached?.contentHash || '',
      kind,
      ...(reason ? { reason } : {}),
      triage: kind === 'committed' ? planTriage : planTriage,
      origin,
    });
  }

  const rawSet = new Set(rawPaths);
  const missingWiki = [...wikiSet].filter((rawPath) => !rawSet.has(rawPath));
  const missingCache = [...cache.keys()].filter((rawPath) => !rawSet.has(rawPath));

  return {
    items,
    summary: {
      rawFiles: rawPaths.length,
      committed,
      queued,
      queuedLegacyOnly,
      queuedRetriageOnly,
      queuedBoth,
      deferred: items.length - committed - queued,
      deferredBreakdown: breakdown,
      metaFiles,
    },
    conflicts: {
      wikiMissingOnDisk: missingWiki.length,
      cacheMissingOnDisk: missingCache.length,
    },
  };
}

/** 为 legacy committed 生成稳定的合成 draftId。 */
export function syntheticDraftId(rawPath: string): string {
  let hash = 0;
  for (const char of rawPath) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `draft-${hash.toString(16).padStart(8, '0').slice(0, 8)}`;
}
