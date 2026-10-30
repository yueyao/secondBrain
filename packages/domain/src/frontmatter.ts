/**
 * frontmatter 解析/序列化（纯函数，放领域层）。
 * 只支持本仓库需要的 YAML 子集：标量、布尔、数字、内联数组、块数组。
 */

export type FrontmatterValue = string | number | boolean | readonly string[];
export type Frontmatter = Readonly<Record<string, FrontmatterValue>>;

export interface ParsedMarkdown {
  readonly data: Frontmatter;
  readonly body: string;
}

function unquote(value: string): string | number | boolean | string {
  const text = value.trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return '';
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function parseInlineArray(value: string): readonly string[] {
  const inner = value.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((part) => String(unquote(part.trim())))
    .filter((part) => part.length > 0);
}

export function parseFrontmatter(text: string): ParsedMarkdown {
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };

  const head = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\n+/, '');
  const data: Record<string, FrontmatterValue> = {};
  let key: string | null = null;

  for (const rawLine of head.split('\n')) {
    const line = rawLine.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && key) {
      const current = data[key];
      const list = Array.isArray(current) ? [...current] : [];
      list.push(String(unquote(listItem[1] ?? '')));
      data[key] = list;
      continue;
    }

    const entry = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!entry) continue;
    key = entry[1] ?? null;
    if (!key) continue;
    const value = (entry[2] ?? '').trim();
    if (value === '') data[key] = [];
    else if (value.startsWith('[')) data[key] = parseInlineArray(value);
    else data[key] = unquote(value);
  }

  return { data, body };
}

export function stringifyFrontmatter(data: Frontmatter, body: string): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${JSON.stringify(String(item))}`);
      continue;
    }
    if (typeof value === 'boolean' || typeof value === 'number') lines.push(`${key}: ${value}`);
    else lines.push(`${key}: ${JSON.stringify(String(value))}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}${body.replace(/^\n+/, '')}`;
}

/** 从正文取一级标题，用于节点名兜底。 */
export function firstHeading(body: string): string | null {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}
