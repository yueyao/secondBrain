/**
 * 知识库体检（P0，只读）：从 vault 的 wiki 与 raw 计算"知识库健康度"。
 *
 * 体检项参考业界实践：
 * - llm-wiki 的 lint：断链、孤立页、矛盾/过期、交叉引用缺口；
 * - SciCrucible /forge-health：断链、缺口、覆盖率；
 * - 我们的数据模型：claims（判断句 + raw 来源）+ 节点（概念/主题/人物）+ 文章引用。
 *
 * 纯读模型：不写库、不改 vault；结果用于 `/kb-health` 页面。
 */
import type { NodeDoc } from '@sb/contracts';
import { normalizeText } from '@sb/domain';
import type { AppContext } from './context';

/** 每个问题列表最多展示的条数（计数不受影响）。 */
const ISSUE_LIMIT = 100;
/** 节点多久没更新算"陈旧"（天）。 */
const STALE_DAYS = 180;

const CLAIM_PATTERN = /^- (.+?)（来源：\[\[(raw\/[^\]]+)\]\]/;
// raw 文件路径里可能带 `#`（如播客 `159 #标题.md`），所以链接解析不能把 # 当锚点截断
const LINK_PATTERN = /\[\[([^\]]+)\]\]/g;

function sectionOf(body: string, heading: string): string {
  const index = body.indexOf(heading);
  if (index < 0) return '';
  const rest = body.slice(index + heading.length);
  const next = rest.search(/\n## /);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** 解析 `## 核心观点` 里的 claims，同时统计没有来源标记的"疑似 claim"行。 */
function parseClaims(body: string): { claims: { text: string; source: string }[]; malformed: string[] } {
  const section = sectionOf(body, '## 核心观点');
  const claims: { text: string; source: string }[] = [];
  const malformed: string[] = [];
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    if (line.startsWith('- [[')) continue; // 纯链接行（来源/相关概念）
    const match = CLAIM_PATTERN.exec(line);
    if (match) claims.push({ text: match[1] as string, source: match[2] as string });
    else malformed.push(line.slice(2, 120));
  }
  return { claims, malformed };
}

function linksOf(body: string): string[] {
  const targets: string[] = [];
  for (const match of body.matchAll(LINK_PATTERN)) {
    const target = (match[1] as string).trim();
    if (target !== '') targets.push(target);
  }
  return targets;
}


/** 链接目标 → 可用于匹配节点的多个键（名称/别名/文件路径/文件名）。 */
function nodeKeys(doc: NodeDoc): string[] {
  const file = doc.file.replace(/^\/+/, '');
  const stem = file.replace(/^wiki\//, '').replace(/\.md$/u, '');
  const base = stem.split('/').pop() ?? stem;
  return [doc.name, ...doc.aliases, file, stem, base].map((value) => normalizeText(value));
}

function resolveTarget(target: string, keys: Set<string>): boolean {
  const normalized = normalizeText(target.replace(/^\/+/, ''));
  if (keys.has(normalized)) return true;
  // 允许 [[wiki/concepts/xxx]] 或 [[xxx.md]] 这类写法
  const withoutExt = normalized.replace(/\.md$/u, '');
  return keys.has(withoutExt);
}

function daysBetween(from: string, to: number): number | null {
  const parsed = Date.parse(from);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((to - parsed) / 86_400_000);
}

export interface KnowledgeHealthReport {
  readonly generatedAt: string;
  readonly nodes: number;
  readonly nodesWithClaims: number;
  readonly nodesWithoutClaims: number;
  readonly nodesWithoutDefinition: number;
  readonly nodesMissingUpdatedAt: number;
  readonly claims: number;
  readonly claimsWithoutSource: number;
  readonly rawSources: number;
  readonly brokenLinks: number;
  readonly missingRawLinks: number;
  readonly orphanNodes: number;
  readonly duplicateNodeGroups: number;
  readonly duplicateClaims: number;
  readonly staleNodes: number;
  readonly issues: {
    readonly brokenLinks: readonly { readonly node: string; readonly target: string }[];
    readonly missingRawLinks: readonly { readonly node: string; readonly source: string }[];
    readonly orphanNodes: readonly string[];
    readonly nodesWithoutClaims: readonly string[];
    readonly nodesWithoutDefinition: readonly string[];
    readonly claimsWithoutSource: readonly { readonly node: string; readonly text: string }[];
    readonly duplicateNodeGroups: readonly { readonly names: readonly string[]; readonly files: readonly string[] }[];
    readonly duplicateClaims: readonly { readonly text: string; readonly nodes: readonly string[] }[];
    readonly staleNodes: readonly { readonly node: string; readonly updatedAt: string }[];
  };
}

export async function knowledgeHealth(ctx: AppContext): Promise<KnowledgeHealthReport> {
  const docs = ctx.search.allDocs();
  const rawRefs = await ctx.vault.listRaw();
  const rawSet = new Set(rawRefs.map((ref) => String(ref.path)));
  const articles = await ctx.store.transaction(async (tx) => tx.articles.list());
  const articleNodeIds = new Set(articles.flatMap((article) => [...article.nodeIds]));

  const keySet = new Set<string>();
  const keyToName = new Map<string, string>();
  for (const doc of docs) {
    for (const key of nodeKeys(doc)) {
      keySet.add(key);
      if (!keyToName.has(key)) keyToName.set(key, doc.name);
    }
  }

  const inbound = new Map<string, number>();
  for (const doc of docs) inbound.set(doc.name, 0);
  const brokenLinks: { node: string; target: string }[] = [];
  const missingRawLinks: { node: string; source: string }[] = [];
  const nodesWithoutClaims: string[] = [];
  const nodesWithoutDefinition: string[] = [];
  const claimsWithoutSource: { node: string; text: string }[] = [];
  const staleNodes: { node: string; updatedAt: string }[] = [];
  const duplicateNodeGroups: { names: string[]; files: string[] }[] = [];
  const claimTextNodes = new Map<string, Set<string>>();

  let nodesWithClaims = 0;
  let claims = 0;
  let claimsWithoutSourceCount = 0;
  let nodesWithoutDefinitionCount = 0;
  let nodesMissingUpdatedAt = 0;
  let staleCount = 0;
  let brokenLinkCount = 0;
  let missingRawCount = 0;
  const missingRawSeen = new Set<string>();
  const brokenLinkSeen = new Set<string>();
  let orphanCount = 0;
  // 时间由应用层注入（app 包禁止读当前时钟）
  const now = Date.parse(ctx.clock.now());

  const fileToName = new Map<string, string>();
  for (const doc of docs) fileToName.set(doc.file, doc.name);
  const seenKeys = new Map<string, Set<string>>();
  for (const doc of docs) {
    for (const key of [doc.name, ...doc.aliases].map((value) => normalizeText(value))) {
      if (key === '') continue;
      const files = seenKeys.get(key) ?? new Set<string>();
      files.add(doc.file);
      seenKeys.set(key, files);
    }
  }
  const emittedDuplicateKeys = new Set<string>();
  const emittedSignatures = new Set<string>();
  for (const [key, files] of seenKeys) {
    if (files.size < 2 || emittedDuplicateKeys.has(key)) continue;
    emittedDuplicateKeys.add(key);
    const signature = [...files].sort().join('|');
    if (emittedSignatures.has(signature)) continue;
    emittedSignatures.add(signature);
    const sortedFiles = [...files].sort();
    duplicateNodeGroups.push({
      names: sortedFiles.map((file) => fileToName.get(file) ?? file),
      files: sortedFiles,
    });
  }

  for (const doc of docs) {
    const { claims: docClaims, malformed } = parseClaims(doc.body);
    if (docClaims.length === 0) nodesWithoutClaims.push(doc.name);
    else nodesWithClaims += 1;
    claims += docClaims.length;

    for (const claim of docClaims) {
      const normalized = normalizeText(claim.text);
      if (normalized === '') continue;
      const holders = claimTextNodes.get(normalized) ?? new Set<string>();
      holders.add(doc.file);
      claimTextNodes.set(normalized, holders);
    }

    if (malformed.length > 0) {
      claimsWithoutSourceCount += malformed.length;
      for (const text of malformed) claimsWithoutSource.push({ node: doc.name, text });
    }

    if (sectionOf(doc.body, '## 一句话定义').length === 0) {
      nodesWithoutDefinitionCount += 1;
      nodesWithoutDefinition.push(doc.name);
    }

    for (const rawLink of linksOf(doc.body)) {
      const target = (rawLink.split('|')[0] ?? '').trim();
      if (target === '') continue;
      if (target.startsWith('raw/')) {
        const dedupeKey = `${doc.file}|${target}`;
        if (!rawSet.has(target) && !missingRawSeen.has(dedupeKey)) {
          missingRawSeen.add(dedupeKey);
          missingRawCount += 1;
          missingRawLinks.push({ node: doc.name, source: target });
        }
        continue;
      }
      // 节点链接可能带锚点：[[节点#小节]]，用锚点前部分解析
      const nodeTarget = (target.split('#')[0] ?? '').trim();
      const dedupeKey = `${doc.file}|${nodeTarget}`;
      if (!resolveTarget(nodeTarget, keySet)) {
        if (!brokenLinkSeen.has(dedupeKey)) {
          brokenLinkSeen.add(dedupeKey);
          brokenLinkCount += 1;
          brokenLinks.push({ node: doc.name, target });
        }
        continue;
      }
      if (nodeTarget !== doc.name) {
        const normalized = normalizeText(nodeTarget.replace(/^\/+/, ''));
        const key = keyToName.get(normalized) ?? keyToName.get(normalized.replace(/\.md$/u, ''));
        if (key !== undefined && key !== doc.name) inbound.set(key, (inbound.get(key) ?? 0) + 1);
      }
    }

    if (doc.updatedAt === '') nodesMissingUpdatedAt += 1;
    else {
      const age = daysBetween(doc.updatedAt, now);
      if (age !== null && age > STALE_DAYS) {
        staleCount += 1;
        staleNodes.push({ node: doc.name, updatedAt: doc.updatedAt });
      }
    }
  }

  for (const doc of docs) {
    const referenced = (inbound.get(doc.name) ?? 0) > 0 || articleNodeIds.has(doc.name);
    if (!referenced) orphanCount += 1;
  }
  const orphanNodes = docs.filter((doc) => (inbound.get(doc.name) ?? 0) === 0 && !articleNodeIds.has(doc.name)).map((doc) => doc.name);

  const duplicateClaimRows: { text: string; nodes: string[] }[] = [];
  let duplicateClaims = 0;
  for (const [text, holders] of claimTextNodes) {
    if (holders.size > 1) {
      duplicateClaims += 1;
      duplicateClaimRows.push({
        text,
        nodes: [...holders].map((file) => fileToName.get(file) ?? file),
      });
    }
  }

  return {
    generatedAt: ctx.clock.now(),
    nodes: docs.length,
    nodesWithClaims,
    nodesWithoutClaims: nodesWithoutClaims.length,
    nodesWithoutDefinition: nodesWithoutDefinitionCount,
    nodesMissingUpdatedAt,
    claims,
    claimsWithoutSource: claimsWithoutSourceCount,
    rawSources: rawSet.size,
    brokenLinks: brokenLinkCount,
    missingRawLinks: missingRawCount,
    orphanNodes: orphanCount,
    duplicateNodeGroups: duplicateNodeGroups.length,
    duplicateClaims,
    staleNodes: staleCount,
    issues: {
      brokenLinks: brokenLinks.slice(0, ISSUE_LIMIT),
      missingRawLinks: missingRawLinks.slice(0, ISSUE_LIMIT),
      orphanNodes: orphanNodes.slice(0, ISSUE_LIMIT),
      nodesWithoutClaims: nodesWithoutClaims.slice(0, ISSUE_LIMIT),
      nodesWithoutDefinition: nodesWithoutDefinition.slice(0, ISSUE_LIMIT),
      claimsWithoutSource: claimsWithoutSource.slice(0, ISSUE_LIMIT),
      duplicateNodeGroups: duplicateNodeGroups.slice(0, ISSUE_LIMIT),
      duplicateClaims: duplicateClaimRows.slice(0, ISSUE_LIMIT),
      staleNodes: staleNodes.slice(0, ISSUE_LIMIT),
    },
  };
}

/** 供页面显示上限提示。 */
export const KNOWLEDGE_HEALTH_ISSUE_LIMIT = ISSUE_LIMIT;
