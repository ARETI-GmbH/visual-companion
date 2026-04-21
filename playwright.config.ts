import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: { headless: true, viewport: { width: 1280, height: 800 } },
  webServer: {
    command: 'npm run start -w @areti-gmbh/visual-companion-server',
    url: 'http://localhost:7788/_companion/health',
    reuseExistingServer: false,
    timeout: 10_000,
    env: {
      VISUAL_COMPANION_PORT: '7788',
      VISUAL_COMPANION_TARGET_URL: 'http://127.0.0.1:7789',
      VISUAL_COMPANION_CWD: process.cwd(),
      VISUAL_COMPANION_SHELL_DIR: `${process.cwd()}/packages/shell/dist`,
      VISUAL_COMPANION_INJECT_FILE: `${process.cwd()}/packages/inject/dist/inject.js`,
    },
  },
});
