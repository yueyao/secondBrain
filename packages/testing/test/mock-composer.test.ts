import { describe, expect, it } from 'vitest';
import type { ComposeNodeMaterial, ComposeRequest } from '@sb/contracts';
import { CITATION_MARKER, extractCitationSources } from '@sb/domain';
import { MockComposer } from '../src/mock-composer';

const NODES: readonly ComposeNodeMaterial[] = [
  {
    name: '反脆弱',
    nodeType: 'concept',
    claims: [{ text: '反脆弱不是坚强，而是从波动中获益。', source: 'raw/knowledge/cubox/a.md' }],
  },
  {
    name: '长期主义',
    nodeType: 'concept',
    claims: [{ text: '长期主义不是坚持得久，而是让选择进入复利轨道。', source: 'raw/knowledge/cubox/b.md' }],
  },
  {
    name: '安全边际',
    nodeType: 'concept',
    claims: [{ text: '安全边际的本质是用价格保护自己的判断错误。', source: 'raw/knowledge/cubox/c.md' }],
  },
];

function request(overrides: Partial<ComposeRequest> = {}): ComposeRequest {
  return { kind: 'outline', title: '测试文章', theme: '长期主义', outline: null, nodes: NODES, instruction: null, ...overrides };
}

const charCount = (text: string): number => [...text].length;
const headings = (text: string): readonly string[] => text.split('\n').filter((line) => line.startsWith('## '));
const markerCount = (text: string): number => [...text.matchAll(CITATION_MARKER)].length;

describe('MockComposer：大纲', () => {
  it('生成 4-7 节 Markdown、长度 ≥ 80、无引用，provenance 确定', async () => {
    const composer = new MockComposer();
    const result = await composer.write(request());

    expect(headings(result.text).length).toBeGreaterThanOrEqual(4);
    expect(headings(result.text).length).toBeLessThanOrEqual(7);
    expect(charCount(result.text)).toBeGreaterThanOrEqual(80);
    expect(result.citations).toEqual([]);
    expect(result.cost).toBe(0);
    expect(result.provenance).toEqual({
      profileId: 'mock-profile',
      provider: 'mock',
      model: 'heuristic-v1',
      promptId: 'compose-outline',
      promptVersion: 1,
      promptSha256: 'mock',
      inputTokens: expect.any(Number) as number,
      outputTokens: expect.any(Number) as number,
      latencyMs: 500,
      fallbackChain: [],
      cacheHit: false,
    });
  });

  it('确定性：同样输入两次结果完全一致', async () => {
    const composer = new MockComposer();
    const first = await composer.write(request());
    const second = await composer.write(request());
    expect(second.text).toBe(first.text);
    expect(second.provenance).toEqual(first.provenance);
  });
});

describe('MockComposer：正文', () => {
  it('长度 ≥ 400，含 ≥ 2 个引用标记，且小节与大纲对应', async () => {
    const composer = new MockComposer();
    const outline = await composer.write(request());
    const body = await composer.write(request({ kind: 'body', outline: outline.text }));

    expect(charCount(body.text)).toBeGreaterThanOrEqual(400);
    expect(markerCount(body.text)).toBeGreaterThanOrEqual(2);
    expect(extractCitationSources(body.text).length).toBeGreaterThanOrEqual(2);
    expect(headings(body.text)).toEqual(headings(outline.text));
    expect(body.citations.length).toBeGreaterThanOrEqual(2);
    expect(body.citations[0]?.text).toBe('');
    expect(body.provenance.promptId).toBe('compose-body');
    expect(body.cost).toBe(0);
  });

  it('只有一个去重来源时重复引用同一来源，仍满足 ≥2 个标记', async () => {
    const nodes: readonly ComposeNodeMaterial[] = [
      {
        name: '反脆弱',
        nodeType: 'concept',
        claims: [
          { text: '反脆弱不是坚强，而是从波动中获益。', source: 'raw/knowledge/cubox/a.md' },
          { text: '冗余必须分层，第一层保命，第二层保机会。', source: 'raw/knowledge/cubox/a.md' },
        ],
      },
    ];
    const composer = new MockComposer();
    const body = await composer.write(request({ kind: 'body', outline: '## 一、反脆弱', nodes }));

    expect(markerCount(body.text)).toBeGreaterThanOrEqual(2);
    expect(extractCitationSources(body.text)).toEqual(['raw/knowledge/cubox/a.md']);
    expect(charCount(body.text)).toBeGreaterThanOrEqual(400);
  });

  it('节点不足 4 个时补足到 4 节，节点过多时截到 7 节', async () => {
    const composer = new MockComposer();
    const one = await composer.write(request({ kind: 'outline', nodes: [NODES[0]!] }));
    expect(headings(one.text)).toHaveLength(4);

    const many: ComposeNodeMaterial[] = Array.from({ length: 9 }, (_, index) => ({
      name: `节点${index + 1}`,
      nodeType: 'concept',
      claims: [{ text: `第 ${index + 1} 个节点的判断。`, source: 'raw/knowledge/cubox/a.md' }],
    }));
    const capped = await composer.write(request({ kind: 'outline', nodes: many }));
    expect(headings(capped.text)).toHaveLength(7);
  });
});
