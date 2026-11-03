/**
 * 去 AI 味用例（应用层）：文本改写 + 把改写结果落成文章新版本。
 *
 * 分工：
 * - 「哪里像 AI」由 @sb/domain 的确定性体检负责（analyzeAiFlavor）；
 * - 「怎么改」交给 DeAiPort（真实模型 / MockDeAi），本层只做：
 *   长度校验、引用保护、把体检发现变成提示词输入、版本落库与事件。
 *
 * 引用是正文的一部分（ADR 0009 D4）：原文里的每个 `（来源：[[raw/...]]）`
 * 改写后必须原样还在，否则拒收——宁可失败，也不产生无法回溯的版本。
 */
import type {
  AgentProvenance,
  ArticleCitation,
  ArticleVersionRecord,
  DeAiIssue,
  DeAiStyle,
} from '@sb/contracts';
import { analyzeAiFlavor, extractCitationSources, type AiFlavorReport } from '@sb/domain';
import { AppError, type AppContext } from './context';

/** 改写长度下限：太短没有改写价值（与文章正文最小长度同一量级）。 */
const MIN_TEXT_CHARS = 80;
/** 改写长度上限：留足模型上下文余量，避免把整本书塞进去。 */
const MAX_TEXT_CHARS = 20_000;

export interface DeAiTextInput {
  readonly text: string;
  readonly title?: string | null;
  readonly style?: DeAiStyle;
  readonly instruction?: string | null;
}

export interface DeAiTextResult {
  /** 原文（trim 后） */
  readonly original: string;
  /** 改写结果（trim 后） */
  readonly rewritten: string;
  /** 改写前体检报告 */
  readonly before: AiFlavorReport;
  /** 改写后体检报告（用于展示分数变化） */
  readonly after: AiFlavorReport;
  readonly provenance: AgentProvenance;
  readonly cost: number;
}

function charCount(text: string): number {
  return [...text].length;
}

/**
 * 改写目标长度：AI 味越重、可压缩空间越大。
 *
 * 只删套话的文章会显著变短（业界 humanizer 也承认"信息优先于形状"），
 * 因此下限按体检分数自适应：重度 0.45x、中度 0.6x、轻度 0.75x；上限统一 1.4x。
 */
export function deAiLengthTarget(textLength: number, score: number): { readonly minChars: number; readonly maxChars: number } {
  const minRatio = score >= 60 ? 0.45 : score >= 30 ? 0.6 : 0.75;
  return {
    minChars: Math.max(1, Math.floor(textLength * minRatio)),
    maxChars: Math.max(1, Math.ceil(textLength * 1.4)),
  };
}

/** 可选字符串归一化：空串与未传都视为「没有」。 */
function optionalText(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 改写一段文本（不改库）。
 *
 * 防御校验（端口实现被替换 / 模型跑偏时兜底）：
 * 1) 结果非空；
 * 2) 长度落在原文的 [0.5 倍, 2 倍]；
 * 3) 原文里的引用来源必须全部还在（不得丢失，也不在应用层强制「不得新增」，
 *    新增来源由执行层契约拦截）。
 */
export async function deAiText(ctx: AppContext, input: DeAiTextInput): Promise<DeAiTextResult> {
  const text = input.text.trim();
  const length = charCount(text);
  if (length < MIN_TEXT_CHARS || length > MAX_TEXT_CHARS) {
    throw new AppError(
      'INVALID_STATE',
      `正文长度需在 ${MIN_TEXT_CHARS}-${MAX_TEXT_CHARS} 字之间（当前 ${length} 字）`,
    );
  }

  const port = ctx.deAi;
  if (!port) throw new AppError('MODEL_UNAVAILABLE', '未配置模型生成能力');

  const before = analyzeAiFlavor(text);
  const issues: readonly DeAiIssue[] = before.findings.map((finding) => ({
    category: finding.category,
    label: finding.label,
    count: finding.count,
    examples: finding.examples,
  }));
  const keepCitations = extractCitationSources(text);
  // 目标长度按原文比例 + AI 味分数自适应：套话越多，允许压缩越多；但不得明显变长。
  const target = deAiLengthTarget(length, before.score);

  const baseRequest = {
    text,
    title: optionalText(input.title),
    style: input.style ?? 'auto',
    issues,
    keepCitations,
    target,
    instruction: optionalText(input.instruction),
  };

  /** 校验单次改写结果；失败抛 AppError（重试时会被捕获并忽略这一次）。 */
  const validate = (candidate: string): string => {
    const rewritten = candidate.trim();
    if (rewritten.length === 0) throw new AppError('INVALID_STATE', '改写结果为空');
    const rewrittenLength = charCount(rewritten);
    if (rewrittenLength < target.minChars || rewrittenLength > target.maxChars) {
      throw new AppError(
        'INVALID_STATE',
        `改写结果长度超出目标区间（${rewrittenLength} 字，目标 ${target.minChars}-${target.maxChars} 字）`,
      );
    }
    if (keepCitations.length > 0) {
      const rewrittenSources = new Set(extractCitationSources(rewritten));
      const missing = keepCitations.filter((source) => !rewrittenSources.has(source));
      if (missing.length > 0) throw new AppError('INVALID_STATE', '改写结果丢失了引用来源', { missing });
    }
    return rewritten;
  };

  const result = await port.humanize(baseRequest);
  const rewritten = validate(result.text);
  let after = analyzeAiFlavor(rewritten);
  let finalResult = result;

  // 质量门：改写后分数没有明显下降（尤其是带大量引用、模型偏保守时）→ 更彻底地重写一次。
  // 只重试一次；若第二次更差，保留第一次。
  if (before.score >= 30 && after.score > before.score - 5) {
    try {
      const retry = await port.humanize({
        ...baseRequest,
        instruction: [
          optionalText(input.instruction) ?? '',
          '【第二次改写】上一版几乎没有降低 AI 味。请逐句重写，不得整句照抄原文；带引用的句子也要改写，只把“（来源：[[raw/...]]）”留在对应句末。目标是让 AI 味复检分数明显下降。',
        ].filter((part) => part !== '').join('\n'),
      });
      const retryText = validate(retry.text);
      const retryAfter = analyzeAiFlavor(retryText);
      if (retryAfter.score < after.score) {
        after = retryAfter;
        finalResult = retry;
        return { original: text, rewritten: retryText, before, after, provenance: retry.provenance, cost: result.cost + retry.cost };
      }
    } catch {
      // 第二次不合规（长度/引用/模型错误）→ 保留第一次结果
    }
  }

  return { original: text, rewritten, before, after, provenance: finalResult.provenance, cost: finalResult.cost };
}

/**
 * 对文章当前版本做「去 AI 味」，追加一条 source='deai' 的新版本。
 *
 * 版本只增不改（ADR 0009 D2）：新版本 basedOnVersionId 指向改写前的当前版本；
 * 即使文章已定稿也回到 review，等待主编重新确认。引用记录保留原文的判断句，
 * 只替换来源列表（改写不应改变引用的事实归属）。
 */
export async function deAiArticleVersion(ctx: AppContext, id: string): Promise<ArticleVersionRecord> {
  const article = await ctx.store.transaction(async (tx) => tx.articles.get(id));
  if (!article) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
  const currentVersionId = article.currentVersionId;
  if (currentVersionId === null) {
    throw new AppError('INVALID_STATE', '当前还没有正文，先生成 v1');
  }
  const current = await ctx.store.transaction(async (tx) => tx.articleVersions.get(currentVersionId));
  if (!current) throw new AppError('NOT_FOUND', `当前版本不存在：${currentVersionId}`);

  // 模型调用在事务外完成，避免长时间占用写事务。
  const result = await deAiText(ctx, { text: current.contentMd, title: article.title, style: 'auto' });

  const now = ctx.clock.now();
  return ctx.store.transaction(async (tx) => {
    const fresh = await tx.articles.get(id);
    if (!fresh) throw new AppError('NOT_FOUND', `文章不存在：${id}`);
    const existing = await tx.articleVersions.listByArticle(id);
    const versionNo = existing.reduce((max, version) => Math.max(max, version.versionNo), 0) + 1;
    // 引用记录：来源取自改写结果（覆盖校验已保证不丢），判断句沿用原版本的同一来源。
    const citations: readonly ArticleCitation[] = extractCitationSources(result.rewritten).map((source) => ({
      source,
      text: current.citations.find((citation) => citation.source === source)?.text ?? '',
    }));
    const record: ArticleVersionRecord = {
      id: `${id}-v${versionNo}`,
      articleId: id,
      versionNo,
      contentMd: result.rewritten,
      citations,
      basedOnVersionId: current.id,
      source: 'deai',
      instruction: null,
      provider: result.provenance.provider,
      model: result.provenance.model,
      promptVersion: result.provenance.promptVersion,
      inputTokens: result.provenance.inputTokens,
      outputTokens: result.provenance.outputTokens,
      cost: result.cost,
      note: `去 AI 味：AI 味分 ${result.before.score} → ${result.after.score}`,
      createdAt: now,
    };
    await tx.articleVersions.append(record);
    await tx.articles.setCurrentVersion(id, record.id, now);
    await tx.articles.setStatus(id, 'review', now);
    await tx.events.append({
      at: now,
      actor: 'owner',
      type: 'article:version_created',
      aggregateId: id,
      payload: {
        versionNo,
        source: 'deai',
        scoreBefore: result.before.score,
        scoreAfter: result.after.score,
      },
    });
    return record;
  });
}
