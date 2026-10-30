/** 测试夹具：6 篇 mock 原文 + 3 个既有节点，覆盖正常/新建/重复事件/低价值/超长。 */
import { stringifyFrontmatter, type FrontmatterValue } from '@sb/domain';

export interface MockRaw {
  readonly path: string;
  readonly frontmatter: Record<string, string>;
  readonly body: string;
}

export const MOCK_RAW: readonly MockRaw[] = [
  {
    path: 'raw/knowledge/cubox/mock-2026-10-01 反脆弱的第二条证据.md',
    frontmatter: { source: 'cubox', title: '反脆弱的第二条证据', node_hint: '反脆弱' },
    body: `# 反脆弱的第二条证据

冗余不是效率的敌人，而是极端事件下的续命装置。
关键是冗余必须分层：第一层保命，第二层保机会，第三层才是效率优化的对象。
边界在于：不轮换的备份等于没有备份。
我推测，多数危机中崩掉的组织，问题不在战略，而在保命层被当成成本中心。
`,
  },
  {
    path: 'raw/knowledge/notions/mock-2026-10-02 幂律分布.md',
    frontmatter: { source: 'notions', title: '幂律分布与头部效应', node_hint: '幂律分布' },
    body: `# 幂律分布与头部效应

幂律分布是指少数个体占据绝大部分总量的分布形态，与正态分布的根本差别在于尾部极厚。
在幂律世界里，平均值失去意义，因为平均结果无法被任何单个样本复现。
这意味着"努力就有回报"只在正态分布里成立。
关键是识别自己所在领域是正态还是幂律。
`,
  },
  {
    path: 'raw/knowledge/podcast/mock-E999 长期主义与时间套利.md',
    frontmatter: { source: 'podcast', event_id: 'e999', title: '长期主义与时间套利', node_hint: '长期主义' },
    body: `# 长期主义与时间套利

长期主义不是把时间拉长，而是让同一段时间里的选择互相加强。
时间套利的本质是用别人不愿意等的耐心，换取别人拿不到的定价。
因为复利依赖连续性，所以中断一次不是少赚一次，而是把曲线打回原点。
代价在于机会成本：长期主义意味着主动放弃短期看起来更好的选项。
`,
  },
  {
    path: 'raw/knowledge/podcast/mock-E999b 长期主义（另一份转录）.md',
    frontmatter: { source: 'podcast', event_id: 'e999', title: '长期主义（另一份转录）', node_hint: '长期主义' },
    body: `# 长期主义（另一份转录）

长期主义不是坚持很久，而是让选择在时间上产生复利。
时间套利指的是用耐心换取别人拿不到的定价，本质是用等待换取折价。
因为复利依赖连续性，所以中断一次会把曲线打回原点。
关键是筛掉不会累积的活动，代价是放弃短期更优选项。
边界在于方向：方向错误时时间只是放大器。
`,
  },
  {
    path: 'raw/knowledge/cubox/mock-2026-10-03 产品快讯.md',
    frontmatter: { source: 'cubox', title: '某公司发布新一代笔记工具快讯' },
    body: `# 某公司发布新一代笔记工具快讯

某公司今日发布新一代笔记工具，售价 199 元/年，支持离线同步与 AI 摘要，将于 10 月 15 日开售。
`,
  },
  {
    path: 'raw/knowledge/dedao/mock-超长访谈.md',
    frontmatter: { source: 'dedao', title: '七小时长访谈' },
    body: `# 七小时长访谈

${'规模化生产带来的边际成本下降，会改变整个行业的竞争结构。当单位成本随产量下降时，先行者可以通过降价把后来者挤出市场。\n\n'.repeat(1200)}`,
  },
];

export interface MockNode {
  readonly file: string;
  readonly frontmatter: Readonly<Record<string, FrontmatterValue>>;
  readonly body: string;
}

export const MOCK_NODES: readonly MockNode[] = [
  {
    file: 'wiki/concepts/反脆弱.md',
    frontmatter: {
      type: 'node', node_type: 'concept', name: '反脆弱', aliases: ['antifragile'],
      review_status: 'active', updated_at: '2026-09-01', confirmed: true,
      tags: ['layer/wiki', 'node/concept'],
    },
    body: `# 反脆弱

## 一句话定义

反脆弱是指系统在承受波动后不仅不变差，反而变得更强的性质。

## 核心观点

- 反脆弱不是坚强，而是从波动中获益。（来源：[[raw/knowledge/cubox/mock-legacy.md]]）

## 相关概念

- [[安全边际]]

## 来源

- [[raw/knowledge/cubox/mock-legacy.md]]
`,
  },
  {
    file: 'wiki/concepts/长期主义.md',
    frontmatter: {
      type: 'node', node_type: 'concept', name: '长期主义', aliases: [],
      review_status: 'active', updated_at: '2026-09-01', confirmed: true,
      tags: ['layer/wiki', 'node/concept'],
    },
    body: `# 长期主义

## 一句话定义

长期主义是指把当下选择放进长时间尺度里评估的取舍方式。

## 核心观点

- 长期主义不是坚持得久，而是让选择进入复利轨道。（来源：[[raw/knowledge/cubox/mock-legacy.md]]）

## 相关概念

- [[反脆弱]]

## 来源

- [[raw/knowledge/cubox/mock-legacy.md]]
`,
  },
  {
    file: 'wiki/concepts/安全边际.md',
    frontmatter: {
      type: 'node', node_type: 'concept', name: '安全边际', aliases: ['margin of safety'],
      review_status: 'active', updated_at: '2026-09-01', confirmed: true,
      tags: ['layer/wiki', 'node/concept'],
    },
    body: `# 安全边际

## 一句话定义

安全边际是指用价格或约束为判断错误预留缓冲空间的决策原则。

## 核心观点

- 安全边际的本质是用价格保护自己的判断错误。（来源：[[raw/knowledge/cubox/mock-legacy.md]]）

## 相关概念

- [[反脆弱]]

## 来源

- [[raw/knowledge/cubox/mock-legacy.md]]
`,
  },
];

export const LEGACY_RAW = {
  path: 'raw/knowledge/cubox/mock-legacy.md',
  content: stringifyFrontmatter({ source: 'cubox', title: '既有来源' }, '# 既有来源\n\n反脆弱与安全边际的旧文。\n'),
};
