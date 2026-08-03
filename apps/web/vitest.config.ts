import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      'shared/constants': fileURLToPath(new URL('../../packages/shared/src/constants/index.ts', import.meta.url)),
      'shared/types': fileURLToPath(new URL('../../packages/shared/src/types/index.ts', import.meta.url)),
      'shared/schemas': fileURLToPath(new URL('../../packages/shared/src/schemas/index.ts', import.meta.url)),
      'shared/agent': fileURLToPath(new URL('../../packages/shared/src/agent/index.ts', import.meta.url)),
      'shared/formatting': fileURLToPath(new URL('../../packages/shared/src/formatting/index.ts', import.meta.url)),
    },
  },
});
