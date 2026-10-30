import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const fromRoot = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // workspace 包的公开面（与 tsconfig.base.json 的 paths 保持一致）
      '@sb/domain': fromRoot('./packages/domain/src/index.ts'),
      '@sb/contracts': fromRoot('./packages/contracts/src/index.ts'),
      '@sb/adapters-sqlite': fromRoot('./packages/adapters-sqlite/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
