/** 节点渲染：新建 / 追加（纯函数，便于单测）。 */
import {
  parseFrontmatter,
  stringifyFrontmatter,
  type Claim,
  type NodeChange,
  type NodeType,
} from '@sb/domain';

const DIRS: Readonly<Record<NodeType, string>> = {
  concept: 'wiki/concepts',
  topic: 'wiki/topics',
  person: 'wiki/people',
};

export function nodeFile(node: NodeChange): string {
  return `${DIRS[node.nodeType]}/${node.name}.md`;
}

function claimLines(claims: readonly Claim[]): string {
  return claims.map((claim) => `- ${claim.text}（来源：[[${claim.source}]]）`).join('\n');
}

export function renderNewNode(node: NodeChange, claims: readonly Claim[], rawPath: string, today: string): string {
  const data = {
    type: 'node',
    node_type: node.nodeType,
    name: node.name,
    aliases: [],
    review_status: 'active',
    updated_at: today,
    confirmed: true,
    tags: ['layer/wiki', `node/${node.nodeType}`],
  };
  const body = [
    `# ${node.name}`, '',
    '## 一句话定义', '', node.definition ?? '', '',
    '## 核心观点', '', claimLines(claims), '',
    '## 相关概念', '', '',
    '## 来源', '', `- [[${rawPath}]]`, '',
  ].join('\n');
  return stringifyFrontmatter(data, body);
}

/** 追加到已有节点的「核心观点」，并把当前 raw 补进「来源」。 */
export function renderPatchedNode(existing: string, claims: readonly Claim[], rawPath: string, today: string): string {
  const { data, body } = parseFrontmatter(existing);
  const fresh = claimLines(claims);
  const marker = '## 核心观点';

  let next: string;
  if (body.includes(marker)) {
    const start = body.indexOf(marker) + marker.length;
    const rest = body.slice(start);
    const nextSection = rest.search(/\n## /);
    const insertAt = nextSection === -1 ? body.length : start + nextSection;
    next = `${body.slice(0, insertAt).replace(/\s*$/, '\n')}${fresh}\n${body.slice(insertAt)}`;
  } else {
    next = `${body.replace(/\s*$/, '\n')}\n${marker}\n\n${fresh}\n`;
  }

  if (!next.includes(`[[${rawPath}]]`)) {
    next = `${next.replace(/\s*$/, '\n')}\n## 来源\n\n- [[${rawPath}]]\n`;
  }

  return stringifyFrontmatter({ ...data, updated_at: today }, next);
}
