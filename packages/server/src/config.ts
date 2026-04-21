export interface ServerConfig {
  port: number;              // where we listen (0 = auto)
  targetUrl: string;         // user's app upstream
  cwd: string;               // claude session cwd
  shellDir: string;          // absolute path to shell/dist
  injectFile: string;        // absolute path to inject/dist/inject.js
}

export function getConfigFromEnv(): ServerConfig {
  return {
    port: parseInt(process.env.VISUAL_COMPANION_PORT ?? '0', 10),
    targetUrl: process.env.VISUAL_COMPANION_TARGET_URL ?? 'http://localhost:3000',
    cwd: process.env.VISUAL_COMPANION_CWD ?? process.cwd(),
    shellDir: process.env.VISUAL_COMPANION_SHELL_DIR ?? '',
    injectFile: process.env.VISUAL_COMPANION_INJECT_FILE ?? '',
  };
}
