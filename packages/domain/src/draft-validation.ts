/**
 * 草稿结构校验（纯函数）：模型输出在进入领域层之前必须过这一关。
 * 对应 ADR 0005「契约层」：非法输出 = 契约违反，绝不产生半成品草稿。
 */
import { domainError, type DomainError } from './model/errors';
import type { Claim, DraftProposal, DraftTier, NodeAction, NodeChange, NodeType } from './model/draft';
import { err, ok, type Result } from './model/result';

const TIERS: readonly DraftTier[] = ['patch', 'standard', 'accelerated', 'full'];
const NODE_TYPES: readonly NodeType[] = ['concept', 'topic', 'person'];
const ACTIONS: readonly NodeAction[] = ['patch', 'new'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseClaim(raw: unknown, index: number): Result<Claim, DomainError> {
  if (!isRecord(raw)) return err(domainError('INVALID_CLAIM', `claims[${index}] 不是对象`));
  const { text, inference, source } = raw;
  if (typeof text !== 'string' || text.trim().length < 8) {
    return err(domainError('INVALID_CLAIM', `claims[${index}].text 必须是不少于 8 字的字符串`));
  }
  if (typeof inference !== 'boolean') {
    return err(domainError('INVALID_CLAIM', `claims[${index}].inference 必须是布尔值`));
  }
  if (typeof source !== 'string' || !source.startsWith('raw/')) {
    return err(domainError('INVALID_CLAIM', `claims[${index}].source 必须以 raw/ 开头`));
  }
  return ok({ text, inference, source });
}

function parseNode(raw: unknown, index: number, claimCount: number): Result<NodeChange, DomainError> {
  if (!isRecord(raw)) return err(domainError('INVALID_NODE', `nodes[${index}] 不是对象`));
  const { name, nodeType, action, definition } = raw;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return err(domainError('INVALID_NODE', `nodes[${index}].name 必须是非空字符串`));
  }
  if (typeof nodeType !== 'string' || !NODE_TYPES.includes(nodeType as NodeType)) {
    return err(domainError('INVALID_NODE', `nodes[${index}].nodeType 非法`));
  }
  if (typeof action !== 'string' || !ACTIONS.includes(action as NodeAction)) {
    return err(domainError('INVALID_NODE', `nodes[${index}].action 非法`));
  }
  if (definition !== null && definition !== undefined && typeof definition !== 'string') {
    return err(domainError('INVALID_NODE', `nodes[${index}].definition 必须是字符串或 null`));
  }

  const rawIndexes = raw.claimIndexes;
  if (rawIndexes !== undefined && rawIndexes !== null) {
    if (!Array.isArray(rawIndexes) || rawIndexes.length === 0) {
      return err(domainError('INVALID_NODE', `nodes[${index}].claimIndexes 必须是非空数组`));
    }
    const seen = new Set<number>();
    for (const value of rawIndexes) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= claimCount) {
        return err(domainError('INVALID_NODE', `nodes[${index}].claimIndexes 含非法下标：${String(value)}`));
      }
      if (seen.has(value)) {
        return err(domainError('INVALID_NODE', `nodes[${index}].claimIndexes 含重复下标：${value}`));
      }
      seen.add(value);
    }
  }

  return ok({
    name,
    nodeType: nodeType as NodeType,
    action: action as NodeAction,
    definition: typeof definition === 'string' ? definition : null,
    claimIndexes: Array.isArray(rawIndexes) ? (rawIndexes as number[]) : [],
  });
}

/** 校验模型给出的任意 JSON，通过后才是可信的 DraftProposal。 */
export function validateDraftProposal(raw: unknown): Result<DraftProposal, DomainError> {
  if (!isRecord(raw)) return err(domainError('INVALID_PROPOSAL', '草稿不是对象'));

  if (typeof raw.tier !== 'string' || !TIERS.includes(raw.tier as DraftTier)) {
    return err(domainError('INVALID_PROPOSAL', 'tier 非法', { tier: raw.tier }));
  }
  if (typeof raw.rationale !== 'string') {
    return err(domainError('INVALID_PROPOSAL', 'rationale 必须是字符串'));
  }
  if (!Array.isArray(raw.claims) || raw.claims.length === 0 || raw.claims.length > 60) {
    return err(domainError('INVALID_PROPOSAL', 'claims 数量必须在 1-60 之间'));
  }
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0 || raw.nodes.length > 5) {
    return err(domainError('INVALID_PROPOSAL', 'nodes 数量必须在 1-5 之间'));
  }

  const claims: Claim[] = [];
  for (const [index, item] of raw.claims.entries()) {
    const parsed = parseClaim(item, index);
    if (!parsed.ok) return parsed;
    claims.push(parsed.value);
  }

  const nodes: NodeChange[] = [];
  for (const [index, item] of raw.nodes.entries()) {
    const parsed = parseNode(item, index, claims.length);
    if (!parsed.ok) return parsed;
    nodes.push(parsed.value);
  }

  return ok({ tier: raw.tier as DraftTier, rationale: raw.rationale, claims, nodes });
}
