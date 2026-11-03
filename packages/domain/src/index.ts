/**
 * @sb/domain 公开面。
 * 规则：包外只允许从本文件导入，不得深引 src/*（由 tools/check-boundaries.mjs 强制）。
 */
export * from './model/result';
export * from './model/errors';
export * from './model/identifiers';
export * from './model/finding';
export * from './model/triage';
export * from './model/draft';
export * from './model/raw-state';
export * from './model/rule-input';
export * from './state-machine';
export * from './text';
export * from './ai-flavor';
export * from './frontmatter';
export * from './draft-validation';
export * from './policies';
export * from './rules/registry';
