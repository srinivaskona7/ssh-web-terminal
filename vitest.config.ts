import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact'
  },
  resolve: {
    alias: {
      '@webssh/protocol': path.resolve(__dirname, 'packages/protocol/src/index.ts'),
      '@webssh/ui-kit': path.resolve(__dirname, 'packages/ui-kit/src/index.ts')
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./apps/web/src/test-setup.ts'],
    include: [
      'packages/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
      'apps/web/src/**/*.test.tsx'
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'packages/protocol/src/**/*.ts',
        'apps/web/src/vault/**/*.ts',
        'apps/web/src/transport/**/*.ts',
        'apps/web/src/files/**/*.ts',
        'apps/web/src/prefs/**/*.ts',
        'apps/web/src/hosts/**/*.ts'
      ],
      exclude: ['**/*.test.ts', '**/index.ts'],
      thresholds: {
        lines: 75,
        functions: 75,
        statements: 75
      }
    }
  }
});
