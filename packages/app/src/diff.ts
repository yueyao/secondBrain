/**
 * 行级文本 diff（Compose C3）。
 *
 * 纯函数：把两个 Markdown 文本按行做 LCS（最长公共子序列）比较，
 * 输出"保留 / 删除 / 新增"的逐行序列，供主编台版本对比页渲染。
 *
 * 约定：
 * - 行号 1-based；`same` / `del` 带 fromNo，`same` / `add` 带 toNo，另一侧为 null；
 * - 先归一化换行（CRLF / 裸 CR → LF），空文本视为 0 行；
 * - 输出顺序确定：同一位置的删除行排在新增行之前（与常见 unified diff 一致）。
 */

export type DiffLineKind = 'same' | 'add' | 'del';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** 旧文本里的行号（1-based）；新增行为 null。 */
  readonly fromNo: number | null;
  /** 新文本里的行号（1-based）；删除行为 null。 */
  readonly toNo: number | null;
}

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
  readonly same: number;
}

/** 按行切分：空文本没有行；统一换行符，避免 CRLF 被误判成差异。 */
function splitLines(text: string): readonly string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * 行级 diff：经典 LCS 动规 + 从左上回溯。
 *
 * 表大小是 O(行数²)，文章版本通常几十到几百行，够用；不做字符级 diff
 * 是因为主编台只需要"哪几段被改写"，行级更易读、也避免大文本的二次复杂度。
 */
export function diffLines(from: string, to: string): readonly DiffLine[] {
  const fromLines = splitLines(from);
  const toLines = splitLines(to);
  const n = fromLines.length;
  const m = toLines.length;

  // 从右下角往前填 LCS 长度表；width 比 to 行数多 1，方便取 i+1 / j+1。
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    const fromLine = fromLines[i] as string;
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = fromLine === toLines[j]
        ? (table[(i + 1) * width + j + 1] as number) + 1
        : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const fromLine = fromLines[i] as string;
    const toLine = toLines[j] as string;
    if (fromLine === toLine) {
      lines.push({ kind: 'same', text: fromLine, fromNo: i + 1, toNo: j + 1 });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      // 平局时先输出删除行：保证同一输入永远得到同一顺序。
      lines.push({ kind: 'del', text: fromLine, fromNo: i + 1, toNo: null });
      i += 1;
    } else {
      lines.push({ kind: 'add', text: toLine, fromNo: null, toNo: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    lines.push({ kind: 'del', text: fromLines[i] as string, fromNo: i + 1, toNo: null });
    i += 1;
  }
  while (j < m) {
    lines.push({ kind: 'add', text: toLines[j] as string, fromNo: null, toNo: j + 1 });
    j += 1;
  }
  return lines;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const line of lines) {
    if (line.kind === 'add') added += 1;
    else if (line.kind === 'del') removed += 1;
    else same += 1;
  }
  return { added, removed, same };
}
