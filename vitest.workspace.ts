import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  './packages/server/vitest.config.ts',
  './packages/inject/vitest.config.ts',
]);
