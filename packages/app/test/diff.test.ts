import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, type DiffLine } from '../src/diff';

/** 只取 kind / fromNo / toNo，避免在断言里重复整行对象。 */
function shape(lines: readonly DiffLine[]): (readonly [string, number | null, number | null])[] {
  return lines.map((line) => [line.kind, line.fromNo, line.toNo] as const);
}

describe('行级 diff（LCS）', () => {
  it('内容完全相同：全部为 same，行号一一对应', () => {
    const lines = diffLines('第一行\n第二行\n第三行', '第一行\n第二行\n第三行');
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.kind === 'same')).toBe(true);
    expect(shape(lines)).toEqual([
      ['same', 1, 1],
      ['same', 2, 2],
      ['same', 3, 3],
    ]);
    expect(lines.map((line) => line.text)).toEqual(['第一行', '第二行', '第三行']);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0, same: 3 });
  });

  it('只改一行：该行先删除后新增，其余行保持 same', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc');
    expect(shape(lines)).toEqual([
      ['same', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['same', 3, 3],
    ]);
    expect(lines.map((line) => line.text)).toEqual(['a', 'b', 'B', 'c']);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1, same: 2 });
  });

  it('纯新增：新增行 fromNo 为 null，后续旧行行号顺延', () => {
    const lines = diffLines('a\nb', 'a\nx\ny\nb');
    expect(shape(lines)).toEqual([
      ['same', 1, 1],
      ['add', null, 2],
      ['add', null, 3],
      ['same', 2, 4],
    ]);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 0, same: 2 });
  });

  it('纯删除：删除行 toNo 为 null', () => {
    const lines = diffLines('a\nx\ny\nb', 'a\nb');
    expect(shape(lines)).toEqual([
      ['same', 1, 1],
      ['del', 2, null],
      ['del', 3, null],
      ['same', 4, 2],
    ]);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 2, same: 2 });
  });

  it('空文本：空 → 非空全部为新增，空 → 空没有差异行', () => {
    expect(shape(diffLines('', '新增一\n新增二'))).toEqual([
      ['add', null, 1],
      ['add', null, 2],
    ]);
    expect(diffLines('', '')).toEqual([]);
    expect(shape(diffLines('旧行', ''))).toEqual([['del', 1, null]]);
    expect(diffStats([])).toEqual({ added: 0, removed: 0, same: 0 });
  });

  it('换行符归一化：CRLF 与 LF 视为相同内容', () => {
    const lines = diffLines('a\r\nb\r\nc', 'a\nb\nc');
    expect(lines.every((line) => line.kind === 'same')).toBe(true);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 0, same: 3 });
  });

  it('确定性：同一输入多次调用得到完全相同的输出', () => {
    const from = '# 标题\n\n第一段\n第二段\n第三段\n结尾';
    const to = '# 标题\n\n第一段\n改写后的第二段\n第三段\n结尾';
    expect(diffLines(from, to)).toEqual(diffLines(from, to));
  });
});
