/**
 * 写作质量检查（P0）：
 *
 * 1. `evaluateWritingContract`：成稿契约的确定性检查（引用、结构、边界/反例、机制、修辞红线、句长起伏、具体信息、AI 味分）；
 *    规则参考李继刚 ljg-writes 的"四项成文契约 + 迁移/反例 + 风格红线"，以及我们已有的 AI 味体检。
 * 2. `auditArticleCitations`：审引清单（引用是否来自知识库 claims、是否可回溯 raw、格式与版本记录是否一致）。
 *
 * 全部是只读检查，不阻断保存；结果用于主编台页面提示与人工判断。
 */
import { analyzeAiFlavor, CITATION_MARKER, extractCitationSources } from '@sb/domain';
import type { AppContext } from './context';

export type QualityStatus = 'pass' | 'warn' | 'fail';

export interface QualityCheck {
  readonly id: string;
  readonly label: string;
  readonly status: QualityStatus;
  readonly detail: string;
}

export interface WritingContractReport {
  readonly checks: readonly QualityCheck[];
  readonly passCount: number;
  readonly warnCount: number;
  readonly failCount: number;
}

const ANTITHESIS_PATTERN = /不是[^。！？\n]{1,30}?而是/gu;
const BOUNDARY_PATTERN = /边界|反例|失效|例外|不成立|前提|除非|一旦|只在|适用范围/u;
const MECHANISM_PATTERN = /导致|因为|所以|取决于|机制|条件|结果|从而|使得|意味着/gu;

function check(id: string, label: string, status: QualityStatus, detail: string): QualityCheck {
  return { id, label, status, detail };
}

function tally(checks: readonly QualityCheck[]): WritingContractReport {
  return {
    checks,
    passCount: checks.filter((item) => item.status === 'pass').length,
    warnCount: checks.filter((item) => item.status === 'warn').length,
    failCount: checks.filter((item) => item.status === 'fail').length,
  };
}

/**
 * 成稿契约检查（确定性）。
 *
 * 设计取舍：
 * - 只对"明显不该出现"的情况判 fail（0 引用/0 小节/排比式转折过多/AI 味过重），其余给 warn；
 * - 不用它替代人工判断，只把"该看的点"摆出来。
 */
export function evaluateWritingContract(text: string): WritingContractReport {
  const chars = [...text].length;
  const citationCount = [...text.matchAll(CITATION_MARKER)].length;
  const uniqueCitationCount = extractCitationSources(text).length;
  const headingCount = text.split('\n').filter((line) => /^##\s+/u.test(line)).length;
  const antithesisCount = [...text.matchAll(ANTITHESIS_PATTERN)].length;
  const mechanismCount = [...text.matchAll(MECHANISM_PATTERN)].length;
  const digitGroups = (text.match(/\d+(?:\.\d+)?/gu) ?? []).length;
  const flavor = analyzeAiFlavor(text);

  const checks: QualityCheck[] = [
    check(
      'citations',
      '引用可回溯（至少 2 处引用）',
      citationCount >= 2 ? 'pass' : citationCount === 1 ? 'warn' : 'fail',
      `引用标记 ${citationCount} 处 / 去重来源 ${uniqueCitationCount} 个`,
    ),
    check(
      'length',
      '篇幅充足（800–30000 字）',
      chars >= 800 && chars <= 30_000 ? 'pass' : chars < 800 ? 'warn' : 'warn',
      `正文 ${chars} 字`,
    ),
    check(
      'structure',
      '有可读的小节结构（≥3 个 ## 小节）',
      headingCount >= 3 ? 'pass' : headingCount >= 1 ? 'warn' : 'fail',
      `## 小节 ${headingCount} 个`,
    ),
    check(
      'boundary',
      '有边界/反例意识',
      BOUNDARY_PATTERN.test(text) ? 'pass' : 'warn',
      BOUNDARY_PATTERN.test(text) ? '文中出现了边界/反例类表述' : '未发现"边界/反例/失效/前提"等表述，建议补一个失效场景',
    ),
    check(
      'mechanism',
      '讲清条件—机制—结果',
      mechanismCount >= 3 ? 'pass' : mechanismCount >= 1 ? 'warn' : 'warn',
      `因果/机制类连接 ${mechanismCount} 处`,
    ),
    check(
      'antithesis',
      '少用"不是…而是…"式修辞转折',
      antithesisCount <= 2 ? 'pass' : antithesisCount <= 4 ? 'warn' : 'fail',
      `"不是…而是…" ${antithesisCount} 处（建议 ≤2）`,
    ),
    check(
      'variation',
      '句长有起伏',
      flavor.metrics.sentenceVariation >= 0.3 ? 'pass' : 'warn',
      `句长变异系数 ${flavor.metrics.sentenceVariation}（≥0.3 更好）`,
    ),
    check(
      'concrete',
      '有具体信息（数字/日期/引用）',
      flavor.metrics.concreteSignalCount >= 3 || digitGroups >= 3 ? 'pass' : 'warn',
      `具体信息点 ${flavor.metrics.concreteSignalCount} 个 / 数字 ${digitGroups} 组`,
    ),
    check(
      'ai-flavor',
      'AI 味不过重',
      flavor.score <= 45 ? 'pass' : flavor.score <= 70 ? 'warn' : 'fail',
      `AI 味分 ${flavor.score}（≤45 更稳；可用「去 AI 味」处理）`,
    ),
  ];
  return tally(checks);
}

/** 与 compose.ts 的 claim 解析保持一致（`- 判断（来源：[[raw/...]]）`）。 */
function claimsIn(body: string): { text: string; source: string }[] {
  const rows: { text: string; source: string }[] = [];
  for (const line of body.split('\n')) {
    const match = line.match(/^- (.+?)（来源：\[\[(raw\/[^\]]+)\]\]/);
    if (match) rows.push({ text: match[1] as string, source: match[2] as string });
  }
  return rows;
}

export interface CitationAuditReport {
  readonly versionNo: number;
  readonly markerCount: number;
  readonly uniqueSources: number;
  readonly checks: readonly QualityCheck[];
  readonly passed: boolean;
  readonly missingRaw: readonly string[];
  readonly notInClaims: readonly string[];
}

/**
 * 审引清单：文章当前版本的引用是否可信。
 *
 * 检查项：
 * 1. 正文有引用标记且数量合理（≥2）；
 * 2. 每个引用来源都来自文章所选知识节点的 claims（不是模型编的）；
 * 3. 每个引用来源都能在 raw/ 中找到（可回溯）；
 * 4. 引用格式统一为 `（来源：[[raw/...]]）`；
 * 5. 正文引用与版本记录 citations 一致；
 * 6. 引用记录带有判断句文本（方便读者判断引了什么）。
 */
export async function auditArticleCitations(ctx: AppContext, id: string): Promise<CitationAuditReport | null> {
  const found = await ctx.store.transaction(async (tx) => {
    const article = await tx.articles.get(id);
    if (!article || article.currentVersionId === null) return null;
    const version = await tx.articleVersions.get(article.currentVersionId);
    if (!version) return null;
    return { article, version };
  });
  if (found === null) return null;
  const { article, version } = found;

  const text = version.contentMd;
  const markerMatches = [...text.matchAll(CITATION_MARKER)];
  const markerCount = markerMatches.length;
  const uniqueSources = extractCitationSources(text);
  const wellFormedCount = (text.match(/[（(]\s*来源\s*[：:]\s*\[\[raw\/[^\]]+\]\]\s*[）)]/gu) ?? []).length;

  const rawSet = new Set((await ctx.vault.listRaw()).map((ref) => String(ref.path)));
  const docs = ctx.search.allDocs();
  const claimSources = new Set<string>();
  for (const nodeId of article.nodeIds) {
    const doc = docs.find((entry) => entry.name === nodeId || entry.aliases.includes(nodeId));
    if (!doc) continue;
    for (const claim of claimsIn(doc.body)) claimSources.add(claim.source);
  }

  const missingRaw = uniqueSources.filter((source) => !rawSet.has(source));
  const notInClaims = claimSources.size === 0 ? [] : uniqueSources.filter((source) => !claimSources.has(source));
  const recordSources = new Set(version.citations.map((citation) => citation.source));
  const textSources = new Set(uniqueSources);
  const sameSets = recordSources.size === textSources.size
    && [...textSources].every((source) => recordSources.has(source));
  const citationTexts = version.citations.filter((citation) => citation.text.trim() !== '').length;
  const citationTextRatio = version.citations.length === 0 ? 0 : citationTexts / version.citations.length;

  const checks: QualityCheck[] = [
    check(
      'markers',
      '正文有引用且数量合理（≥2）',
      markerCount >= 2 ? 'pass' : markerCount === 1 ? 'warn' : 'fail',
      `引用标记 ${markerCount} 处 / 去重来源 ${uniqueSources.length} 个`,
    ),
    check(
      'from-claims',
      '引用来源来自知识库 claims',
      claimSources.size === 0 ? 'warn' : notInClaims.length === 0 ? 'pass' : 'fail',
      claimSources.size === 0
        ? '所选节点没有 claims，无法核对（建议人工确认）'
        : notInClaims.length === 0
          ? '全部引用都能在节点 claims 中找到'
          : `有 ${notInClaims.length} 个引用不在 claims 池：${notInClaims.slice(0, 3).join('、')}`,
    ),
    check(
      'raw-exists',
      '引用可回溯到 raw 原文',
      missingRaw.length === 0 ? 'pass' : 'fail',
      missingRaw.length === 0
        ? '全部引用路径存在于 raw/'
        : `有 ${missingRaw.length} 个引用找不到原文：${missingRaw.slice(0, 3).join('、')}`,
    ),
    check(
      'format',
      '引用格式统一（（来源：[[raw/…]]））',
      markerCount > 0 && wellFormedCount === markerCount ? 'pass' : 'warn',
      `规范标记 ${wellFormedCount} / 总标记 ${markerCount}`,
    ),
    check(
      'record',
      '正文引用与版本记录一致',
      sameSets ? 'pass' : 'warn',
      sameSets ? '版本 citations 与正文完全一致' : '版本记录与正文引用集合不一致（可能由旧版本/手工编辑造成）',
    ),
    check(
      'citation-text',
      '引用带判断句原文',
      version.citations.length === 0 ? 'warn' : citationTextRatio >= 0.8 ? 'pass' : 'warn',
      `带文本的引用 ${citationTexts}/${version.citations.length}`,
    ),
  ];

  return {
    versionNo: version.versionNo,
    markerCount,
    uniqueSources: uniqueSources.length,
    checks,
    passed: checks.every((item) => item.status !== 'fail'),
    missingRaw,
    notInClaims,
  };
}

/** 供页面在无正文时展示的统一文案。 */
export function emptyQualityReport(): WritingContractReport {
  return tally([check('empty', '还没有正文', 'warn', '生成正文后这里会显示写作契约检查结果')]);
}

