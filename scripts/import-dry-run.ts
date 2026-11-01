/**
 * Legacy 导入 dry-run（只读）：
 * 把旧 vault 里的处理记录（cache / digest-log / triage-log / wiki 引用）
 * 与新系统状态做一次对账，输出分类与冲突，不写 SQLite、不改任何文件。
 *
 * 用法：pnpm import:dry-run [--vault <vault 路径>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '@sb/domain';
import { countJudgmentSentences } from '@sb/domain';
import { decideTriage } from '@sb/domain';

const DEFAULT_VAULT = '/Users/dynamic/workspace/secondBrain';

interface CacheItem {
  readonly rawPath: string;
  readonly sourceKey: string;
  readonly contentHash: string;
  readonly title: string;
  readonly triageStatus: string | null;
  readonly triageScore: number | null;
  readonly triageReasons: readonly string[];
  readonly digestStatus: string | null;
}

type Classification =
  | 'committed'        // wiki 里有来源引用
  | 'review'           // cache 说 digested，但 wiki 无引用
  | 'queued'           // medium/high 但未 digested
  | 'deferred'         // low / skipped / defer
  | 'deferred_long'    // 超过长文阈值
  | 'triaged_unknown'  // 只出现在 triage-log，没有 digest 结论
  | 'untriaged';       // 完全没进过流水线

const KNOWN_TRIAGE_STATUSES = new Set(['high', 'medium', 'low', 'skipped', 'defer']);
const KNOWN_DIGEST_STATUSES = new Set(['not_started', 'digested', 'deferred']);
const KNOWN_REASONS = new Set([
  'human_story', 'interesting', 'novel_view', 'useful', 'durable_claim',
  'reinforces_existing', 'personal_relevance', 'low_signal',
]);

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

function toRelative(vault: string, absolute: string): string {
  return nfc(path.relative(vault, absolute).split(path.sep).join('/'));
}

function argValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const vault = path.resolve(argValue(argv, '--vault') ?? DEFAULT_VAULT);
  const longThreshold = Number(argValue(argv, '--long-threshold') ?? 200_000);
  const retriage = argv.includes('--retriage');
  const enabledSources = new Set(['cubox', 'notions', 'podcast', 'dedao', 'general']);
  if (!fs.existsSync(path.join(vault, 'raw'))) throw new Error(`vault 不存在或缺少 raw/：${vault}`);

  // 1) raw 文件系统
  const rawAbs = walkMarkdown(path.join(vault, 'raw'));
  const rawSet = new Set(rawAbs.map((file) => toRelative(vault, file)));

  // 2) 旧 cache
  const cacheFile = path.join(vault, '_workspace/cache/raw-processing-cache.json');
  const cacheRaw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
    items: Record<string, Record<string, unknown>>;
  };
  const cache = new Map<string, CacheItem>();
  for (const [key, value] of Object.entries(cacheRaw.items)) {
    const triage = (value.triage ?? {}) as Record<string, unknown>;
    const digest = (value.digest ?? {}) as Record<string, unknown>;
    cache.set(nfc(key), {
      rawPath: nfc(String(value.raw_path ?? key)),
      sourceKey: String(value.source_key ?? ''),
      contentHash: String(value.content_hash ?? ''),
      title: String(value.title ?? ''),
      triageStatus: typeof triage.status === 'string' ? triage.status : null,
      triageScore: typeof triage.score === 'number' ? triage.score : null,
      triageReasons: Array.isArray(triage.reasons) ? triage.reasons.map(String) : [],
      digestStatus: typeof digest.status === 'string' ? digest.status : null,
    });
  }

  // 3) wiki 来源引用
  const wikiSet = new Set<string>();
  let wikiFiles = 0;
  for (const file of walkMarkdown(path.join(vault, 'wiki'))) {
    wikiFiles += 1;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\[\[(raw\/[^\]|#]+)/g)) wikiSet.add(nfc(match[1] as string));
  }

  // 4) digest-log / triage-log
  const digestLogPath = path.join(vault, '_workspace/outputs/digest-log.md');
  const digestLogSet = new Set<string>();
  if (fs.existsSync(digestLogPath)) {
    for (const line of fs.readFileSync(digestLogPath, 'utf8').split('\n')) {
      const match = line.match(/\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(raw\/[^|]+?)\s*\|/);
      if (match) digestLogSet.add(nfc(match[2] as string));
    }
  }
  const triageLogPath = path.join(vault, '_workspace/outputs/triage-log.md');
  const triageLogSet = new Set<string>();
  if (fs.existsSync(triageLogPath)) {
    for (const line of fs.readFileSync(triageLogPath, 'utf8').split('\n')) {
      const match = line.match(/^\s*path:\s*(raw\/.+?)\s*$/);
      if (match) triageLogSet.add(nfc(match[1] as string));
    }
  }

  // 注意：系统阈值是「字符数」（content.length），不是文件字节数
  const sizes = new Map(rawAbs.map((file) => [toRelative(vault, file), fs.readFileSync(file, 'utf8').length]));

  // 5) 分类（顺序：committed > review > 长文 > queued > deferred > untriaged）
  const classes = new Map<Classification, string[]>();
  const add = (kind: Classification, rawPath: string): void => {
    const list = classes.get(kind) ?? [];
    list.push(rawPath);
    classes.set(kind, list);
  };

  for (const rawPath of rawSet) {
    const cached = cache.get(rawPath);
    if (wikiSet.has(rawPath)) add('committed', rawPath);
    else if (cached?.digestStatus === 'digested') add('review', rawPath);
    else if ((sizes.get(rawPath) ?? 0) > longThreshold) add('deferred_long', rawPath);
    else if (cached && (cached.triageStatus === 'medium' || cached.triageStatus === 'high')) add('queued', rawPath);
    else if (cached) add('deferred', rawPath);
    else if (triageLogSet.has(rawPath)) add('triaged_unknown', rawPath);
    else add('untriaged', rawPath);
  }

  // 6) 冲突检测
  const missingWiki = [...wikiSet].filter((rawPath) => !rawSet.has(rawPath));
  const missingCache = [...cache.keys()].filter((rawPath) => !rawSet.has(rawPath));
  const missingDigestLog = [...digestLogSet].filter((rawPath) => !rawSet.has(rawPath));
  const missingTriageLog = [...triageLogSet].filter((rawPath) => !rawSet.has(rawPath));

  const unknownTriageStatuses = [...new Set([...cache.values()].map((item) => item.triageStatus))]
    .filter((status): status is string => status !== null && !KNOWN_TRIAGE_STATUSES.has(status));
  const unknownDigestStatuses = [...new Set([...cache.values()].map((item) => item.digestStatus))]
    .filter((status): status is string => status !== null && !KNOWN_DIGEST_STATUSES.has(status));
  const unknownReasons = [...new Set([...cache.values()].flatMap((item) => item.triageReasons))]
    .filter((reason) => !KNOWN_REASONS.has(reason));
  const invalidHashes = [...cache.values()]
    .map((item) => item.contentHash)
    .filter((hash) => !/^sha256:[0-9a-f]{64}$/.test(hash));

  // 7) 汇总
  const bySource = new Map<string, Record<string, number>>();
  for (const rawPath of rawSet) {
    const cached = cache.get(rawPath);
    const source = cached?.sourceKey ?? rawPath.split('/')[2] ?? 'unknown';
    const bucket = bySource.get(source) ?? {};
    const kind = wikiSet.has(rawPath)
      ? 'committed'
      : cached?.digestStatus === 'digested'
        ? 'review'
        : (sizes.get(rawPath) ?? 0) > longThreshold
        ? 'deferred_long'
        : cached && (cached.triageStatus === 'medium' || cached.triageStatus === 'high')
          ? 'queued'
          : cached
            ? 'deferred'
            : triageLogSet.has(rawPath)
              ? 'triaged_unknown'
              : 'untriaged';
    bucket[kind] = (bucket[kind] ?? 0) + 1;
    bySource.set(source, bucket);
  }

  const counts = Object.fromEntries([...classes.entries()].map(([kind, list]) => [kind, list.length]));
  const longText = Object.fromEntries([...classes.entries()].map(([kind, list]) => [
    kind, list.filter((rawPath) => (sizes.get(rawPath) ?? 0) > 60_000).length,
  ]));
  const metaFiles = Object.fromEntries([...classes.entries()].map(([kind, list]) => [
    kind, list.filter((rawPath) => path.basename(rawPath).startsWith('_')).length,
  ]));
  const queued = (counts.queued ?? 0) + (counts.triaged_unknown ?? 0);
  const untriaged = counts.untriaged ?? 0;
  const expectedNewQueue = queued + Math.round(untriaged * 0.6);
  const costPerArticle = 0.0025;
  const secondsPerArticle = 15.6;

  // 8) 可选：用新规则重跑 triage（不依赖旧 cache 状态）
  let retriageReport: Record<string, unknown> | null = null;
  if (retriage) {
    const next: Record<string, number> = { queued: 0, deferred: 0, deferred_long: 0, source_disabled: 0 };
    for (const rawPath of rawSet) {
      if (wikiSet.has(rawPath) || cache.get(rawPath)?.digestStatus === 'digested') continue;
      const content = fs.readFileSync(path.join(vault, rawPath), 'utf8');
      const { body } = parseFrontmatter(content);
      const size = content.length;
      const source = rawPath.split('/')[2] ?? '';
      if (size > longThreshold) {
        next.deferred_long = (next.deferred_long ?? 0) + 1;
        continue;
      }
      if (!enabledSources.has(source)) {
        next.source_disabled = (next.source_disabled ?? 0) + 1;
        continue;
      }
      const triage = decideTriage({ judgments: countJudgmentSentences(body), charCount: size });
      if (triage.status === 'low') next.deferred = (next.deferred ?? 0) + 1;
      else next.queued = (next.queued ?? 0) + 1;
    }
    const q = next.queued ?? 0;
    retriageReport = {
      threshold: longThreshold,
      counts: next,
      estimate: {
        costUsd: Number((q * costPerArticle).toFixed(4)),
        hoursSerial: Number(((q * secondsPerArticle) / 3600).toFixed(1)),
        hoursWith3Workers: Number(((q * secondsPerArticle) / 3600 / 3).toFixed(1)),
      },
    };
  }

  const report = {
    vault,
    rawFiles: rawSet.size,
    wikiFiles,
    cacheItems: cache.size,
    digestLogPaths: digestLogSet.size,
    triageLogPaths: triageLogSet.size,
    counts,
    longThreshold,
    retriage: retriageReport,
    longText,
    metaFiles,
    expectedNewQueue,
    estimate: {
      costUsd: Number((expectedNewQueue * costPerArticle).toFixed(4)),
      hoursSerial: Number(((expectedNewQueue * secondsPerArticle) / 3600).toFixed(1)),
      hoursWith3Workers: Number(((expectedNewQueue * secondsPerArticle) / 3600 / 3).toFixed(1)),
    },
    conflicts: {
      wikiMissingOnDisk: missingWiki.length,
      cacheMissingOnDisk: missingCache.length,
      digestLogMissingOnDisk: missingDigestLog.length,
      triageLogMissingOnDisk: missingTriageLog.length,
      unknownTriageStatuses,
      unknownDigestStatuses,
      unknownReasons,
      invalidHashes: invalidHashes.length,
    },
    bySource: Object.fromEntries([...bySource.entries()].sort()),
    samples: Object.fromEntries(
      [...classes.entries()].map(([kind, list]) => [kind, list.slice(0, 5)]),
    ),
    samplesConflict: {
      wikiMissingOnDisk: missingWiki.slice(0, 5),
      cacheMissingOnDisk: missingCache.slice(0, 5),
    },
    details: Object.fromEntries([...classes.entries()].map(([kind, list]) => [kind, list])),
  };

  const outDir = path.join(process.cwd(), '.sb-import');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'dry-run.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    rawFiles: report.rawFiles,
    wikiFiles: report.wikiFiles,
    cacheItems: report.cacheItems,
    counts: report.counts,
    longThreshold: report.longThreshold,
    retriage: report.retriage,
    longText: report.longText,
    metaFiles: report.metaFiles,
    expectedNewQueue: report.expectedNewQueue,
    estimate: report.estimate,
    conflicts: report.conflicts,
    bySource: report.bySource,
    samples: report.samples,
    samplesConflict: report.samplesConflict,
    detailsFile: outFile,
  }, null, 2));
}

main();
