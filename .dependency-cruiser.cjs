/**
 * Monorepo 依赖规则（设计文档 §2，改造为多包版）。
 * 图级检查交给 dependency-cruiser；源码细节（throw / 时钟 / 深引）交给 tools/check-boundaries.mjs。
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-must-be-pure',
      comment: 'domain 不允许任何 I/O 与外部依赖',
      severity: 'error',
      from: { path: '^packages/domain/src' },
      to: { path: '^node:' },
    },
    {
      name: 'domain-must-not-depend-on-contracts',
      comment: '依赖只能向内：domain 是最内层，不能引用契约包',
      severity: 'error',
      from: { path: '^packages/domain/src' },
      to: { path: '^packages/contracts' },
    },
    {
      name: 'contracts-must-be-pure',
      comment: '契约包只声明接口与 DTO，不实现 I/O',
      severity: 'error',
      from: { path: '^packages/contracts/src' },
      to: { path: '^node:' },
    },
    {
      name: 'contracts-must-not-depend-on-implementations',
      comment: '契约不得反向依赖应用/适配器/入口',
      severity: 'error',
      from: { path: '^packages/contracts/src' },
      to: { path: '^(packages/(app|adapters[^/]*)|apps)/' },
    },
    {
      name: 'domain-must-not-depend-on-adapters',
      comment: '适配器是外层，domain 不得引用',
      severity: 'error',
      from: { path: '^packages/domain/src' },
      to: { path: '^packages/adapters' },
    },
    {
      name: 'adapters-must-not-depend-on-app-or-entry',
      comment: '适配器不得引用应用层与入口',
      severity: 'error',
      from: { path: '^packages/adapters' },
      to: { path: '^(packages/app|apps)/' },
    },
    {
      name: 'agent-runtime-must-not-depend-on-outer-layers',
      comment: '模型运行时只依赖契约与领域',
      severity: 'error',
      from: { path: '^packages/agent-runtime/src' },
      to: { path: '^(packages/(app|adapters)|apps)/' },
    },
    {
      name: 'app-must-not-depend-on-adapters',
      comment: '应用层只依赖端口，不依赖任何适配器实现',
      severity: 'error',
      from: { path: '^packages/app/src' },
      to: { path: '^packages/adapters' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: ['\\.d\\.ts$', '(^|/)index\\.ts$', '(^|/)main\\.ts$'],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
