/**
 * 展示时间格式化（UI / 导出文档用）。
 *
 * 存储层统一用 ISO 8601 UTC（`2026-11-03T15:45:02.619Z`），直接展示会带一个 T 且不是本地时间；
 * 这里统一转成 **Asia/Shanghai** 并去掉 T，输出 `2026-11-03 23:45` 这类人类可读格式。
 * 纯函数（只依赖 Intl），不读环境变量；需要其他时区时显式传 `timeZone`。
 */

export const DEFAULT_DISPLAY_TIME_ZONE = 'Asia/Shanghai';

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  const cached = FORMATTER_CACHE.get(key);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat('zh-CN', { timeZone, hour12: false, ...options });
  FORMATTER_CACHE.set(key, created);
  return created;
}

/** 无法解析的时间串原样返回，避免页面出现 `Invalid Date`。 */
function formatWith(value: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  // 用 Date.parse 解析「传入的字符串」，而不是 new Date()——应用层禁止读当前时钟
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return formatter(timeZone, options).format(timestamp).replace(/\//gu, '-');
}

/** `2026-11-03T15:45:02.619Z` → `2026-11-03 23:45`（或带秒）。 */
export function formatDateTime(value: string, options: { readonly seconds?: boolean; readonly timeZone?: string } = {}): string {
  return formatWith(value, options.timeZone ?? DEFAULT_DISPLAY_TIME_ZONE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(options.seconds === true ? { second: '2-digit' } : {}),
  });
}

/** 只要日期：`2026-11-03`。 */
export function formatDate(value: string, timeZone: string = DEFAULT_DISPLAY_TIME_ZONE): string {
  return formatWith(value, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** 只要时钟：`23:45:02`（用于 worker 状态更新时间等）。 */
export function formatClock(value: string, timeZone: string = DEFAULT_DISPLAY_TIME_ZONE): string {
  return formatWith(value, timeZone, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
