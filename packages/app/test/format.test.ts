import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_TIME_ZONE, formatClock, formatDate, formatDateTime } from '../src/format';

describe('展示时间格式化（ISO → 本地可读、去掉 T）', () => {
  it('UTC ISO 转成 Asia/Shanghai 的「年-月-日 时:分」', () => {
    expect(formatDateTime('2026-11-03T15:45:02.619Z')).toBe('2026-11-03 23:45');
    expect(formatDateTime('2026-11-03T15:45:02.619Z', { seconds: true })).toBe('2026-11-03 23:45:02');
  });

  it('带 +08:00 的输入不重复偏移', () => {
    expect(formatDateTime('2026-10-30T23:00:00+08:00')).toBe('2026-10-30 23:00');
  });

  it('跨日边界：UTC 晚上转本地是次日', () => {
    expect(formatDate('2026-11-03T17:30:00Z')).toBe('2026-11-04');
    expect(formatDate('2026-11-03T15:30:00Z')).toBe('2026-11-03');
  });

  it('只取时钟（worker 状态更新时间）', () => {
    expect(formatClock('2026-11-03T15:45:02.619Z')).toBe('23:45:02');
  });

  it('可显式指定时区；非法时间原样返回', () => {
    expect(formatDateTime('2026-11-03T15:45:00Z', { timeZone: 'UTC' })).toBe('2026-11-03 15:45');
    expect(formatDateTime('not-a-time')).toBe('not-a-time');
    expect(DEFAULT_DISPLAY_TIME_ZONE).toBe('Asia/Shanghai');
  });
});
