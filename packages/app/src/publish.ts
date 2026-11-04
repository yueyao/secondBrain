/**
 * Publish：定稿 / 重新打开 / Markdown 导出（Compose C4）。
 *
 * - 定稿：draft/review → final，状态与事件同事务；
 * - 重新打开：final → review，回到主编审以便继续改稿；
 * - 导出：按当前版本生成带引用来源的 Markdown（下载 / 发布用，不写文件系统）。
 *
 * 应用层只做状态守卫、事件与纯文本渲染；文件名与正文格式在这里定死，
 * 入口（apps/*）只负责把结果交给浏览器。
 */
import type {
  ArticleCitation,
  ArticleRecord,
  ArticleStatus,
  ArticleVersionRecord,
} from '@sb/contracts';
import { AppError, type AppContext } from './context';
import { formatDateTime } from './format';

/** 导出结果：文件名与 Markdown 由应用层给定，入口只负责传输。 */
export interface ExportArticleResult {
  readonly filename: string;
  readonly markdown: string;
  readonly status: ArticleStatus;
  readonly versionNo: number;
}

/** 中文状态标签，与审核台 / 文章库展示保持一致。 */
const STATUS_LABELS: Readonly<Record<ArticleStatus, string>> = {
  draft: '草稿',
  review: '待主编审',
  final: '已定稿',
};

/** 文件名里安全标题的最大码点数（中文按一个字算）。 */
const MAX_FILENAME_TITLE_CHARS = 60;

/** 文件名非法字符（含空白）：连续命中合并成一个 '-'。 */
const FILENAME_UNSAFE = /[\s\\/:*?"<>|]+/gu;

/** 合并连续 '-' 并去掉首尾 '-'。 */
const FILENAME_TRIM = /^-+|-+$/g;

/** 标题 → 安全标题：清洗非法字符、合并/去首尾 '-'、按码点截断，全空回退 'article'。 */
function safeTitle(title: string): string {
  const cleaned = title
    .trim()
    .replace(FILENAME_UNSAFE, '-')
    .replace(/-{2,}/g, '-')
    .replace(FILENAME_TRIM, '');
  const truncated = [...cleaned].slice(0, MAX_FILENAME_TITLE_CHARS).join('');
  return truncated.length === 0 ? 'article' : truncated;
}

/** 导出文件名：`${安全标题}-v${versionNo}.md`（C4 下载文件名契约）。 */
export function articleExportFilename(title: string, versionNo: number): string {
  return `${safeTitle(title)}-v${versionNo}.md`;
}

/**
 * 定稿：draft / review → final。
 * 事件 `article:finalized` 与状态更新同事务，payload 带上定稿的版本号。
 */
export async function finalizeArticle(ctx: AppContext, id: string): Promise<ArticleRecord> {
  const now = ctx.clock.now();
  return ctx.store.transaction(async (tx) => {
    const article = await tx.articles.get(id);
    if (!article) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
    if (!article.currentVersionId) throw new AppError('INVALID_STATE', '还没有正文，不能定稿');
    if (article.status === 'final') throw new AppError('INVALID_STATE', '已经是定稿状态');
    const version = await tx.articleVersions.get(article.currentVersionId);
    if (!version) throw new AppError('INVALID_STATE', '当前版本记录缺失，无法定稿');

    await tx.articles.setStatus(id, 'final', now);
    await tx.events.append({
      at: now,
      actor: 'owner',
      type: 'article:finalized',
      aggregateId: id,
      payload: { versionNo: version.versionNo },
    });
    const updated = await tx.articles.get(id);
    if (!updated) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
    return updated;
  });
}

/** 重新打开：只有 final 能回到 review（改稿后再次进入主编审）。 */
export async function reopenArticle(ctx: AppContext, id: string): Promise<ArticleRecord> {
  const now = ctx.clock.now();
  return ctx.store.transaction(async (tx) => {
    const article = await tx.articles.get(id);
    if (!article) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
    if (article.status !== 'final') throw new AppError('INVALID_STATE', '只有定稿文章可以重新打开');

    await tx.articles.setStatus(id, 'review', now);
    await tx.events.append({
      at: now,
      actor: 'owner',
      type: 'article:reopened',
      aggregateId: id,
      payload: {},
    });
    const updated = await tx.articles.get(id);
    if (!updated) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
    return updated;
  });
}

/** 引用列表 → Markdown 列表项：按原顺序去重，空来源跳过。 */
function citationLines(citations: readonly ArticleCitation[]): readonly string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const citation of citations) {
    if (citation.source.length === 0 || seen.has(citation.source)) continue;
    seen.add(citation.source);
    lines.push(`- [[${citation.source}]]`);
  }
  return lines;
}

/** 正文 + 元信息头 + 引用来源；没有引用时整个「引用来源」章节（含 ---）省略。 */
function renderArticleMarkdown(
  article: ArticleRecord,
  version: ArticleVersionRecord,
  exportedAt: string,
): string {
  const theme = article.theme.trim().length === 0 ? '未设主题' : article.theme.trim();
  const lines: string[] = [
    `# ${article.title}`,
    '',
    `> 主题：${theme} · 状态：${STATUS_LABELS[article.status]} · 版本 v${version.versionNo} · 导出时间 ${exportedAt}`,
    '',
    version.contentMd.trim(),
  ];
  const sources = citationLines(version.citations);
  if (sources.length > 0) {
    lines.push('', '---', '', '## 引用来源', '', ...sources);
  }
  return `${lines.join('\n')}\n`;
}

/** 按当前版本导出 Markdown（只读：状态、版本号、文件名都取自当前版本）。 */
export async function exportArticleMarkdown(ctx: AppContext, id: string): Promise<ExportArticleResult> {
  const now = ctx.clock.now();
  return ctx.store.transaction(async (tx) => {
    const article = await tx.articles.get(id);
    if (!article) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
    if (!article.currentVersionId) throw new AppError('INVALID_STATE', '还没有正文，无法导出');
    const version = await tx.articleVersions.get(article.currentVersionId);
    if (!version) throw new AppError('INVALID_STATE', '当前版本记录缺失，无法导出');

    return {
      filename: articleExportFilename(article.title, version.versionNo),
      markdown: renderArticleMarkdown(article, version, formatDateTime(now)),
      status: article.status,
      versionNo: version.versionNo,
    };
  });
}
