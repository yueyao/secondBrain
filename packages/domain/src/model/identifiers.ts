/**
 * 品牌类型（branded types）：把 string 收紧为"已验证的"领域标识。
 * 所有构造都返回 Result，避免把非法路径带进领域层。
 */
import { domainError, type DomainError } from './errors';
import { err, ok, type Result } from './result';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RawPath = Brand<string, 'RawPath'>;
export type DraftId = Brand<string, 'DraftId'>;
export type CommitSha = Brand<string, 'CommitSha'>;
export type NodeId = Brand<string, 'NodeId'>;
export type ContentHash = Brand<string, 'ContentHash'>;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DRAFT_ID_RE = /^draft-[0-9a-zA-Z]{6,40}$/;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/** raw/ 下的 markdown 路径：必须以 raw/ 开头、.md 结尾，禁止越级与绝对路径。 */
export function parseRawPath(input: string): Result<RawPath, DomainError> {
  const fail = (reason: string): Result<RawPath, DomainError> =>
    err(domainError('INVALID_RAW_PATH', `非法 raw 路径：${reason}`, { input }));

  if (input.length < 8 || input.length > 1024) return fail('长度不合法');
  if (!input.startsWith('raw/')) return fail('必须以 raw/ 开头');
  if (!input.endsWith('.md')) return fail('必须以 .md 结尾');
  if (input.startsWith('/')) return fail('不得是绝对路径');
  if (input.includes('\\')) return fail('不得包含反斜杠');
  if (CONTROL_CHARS.test(input)) return fail('不得包含控制字符');
  const segments = input.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return fail('不得包含空段、. 或 ..');
  }
  return ok(input as RawPath);
}

export function parseDraftId(input: string): Result<DraftId, DomainError> {
  if (!DRAFT_ID_RE.test(input)) {
    return err(domainError('INVALID_DRAFT_ID', '草稿 id 必须形如 draft-xxxxxxxx', { input }));
  }
  return ok(input as DraftId);
}

export function parseCommitSha(input: string): Result<CommitSha, DomainError> {
  if (!COMMIT_SHA_RE.test(input)) {
    return err(domainError('INVALID_COMMIT_SHA', '提交 sha 必须为 7-40 位十六进制', { input }));
  }
  return ok(input as CommitSha);
}

export function parseContentHash(input: string): Result<ContentHash, DomainError> {
  if (!CONTENT_HASH_RE.test(input)) {
    return err(domainError('INVALID_CONTENT_HASH', '内容哈希必须形如 sha256:<64 hex>', { input }));
  }
  return ok(input as ContentHash);
}

export function parseNodeId(input: string): Result<NodeId, DomainError> {
  if (input.length === 0 || input.length > 200) {
    return err(domainError('INVALID_NODE_ID', '节点 id 长度必须在 1-200 之间', { input }));
  }
  if (/[[\]|#^]/.test(input)) {
    return err(domainError('INVALID_NODE_ID', '节点 id 不得包含 Obsidian 链接保留字符', { input }));
  }
  return ok(input as NodeId);
}

/** 节点 id 的规范形式：'concept:二元帝国' */
export function makeNodeId(kind: 'concept' | 'topic' | 'person', name: string): NodeId {
  return `${kind}:${name}` as NodeId;
}
