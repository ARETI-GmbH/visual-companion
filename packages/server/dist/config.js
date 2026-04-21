export function getConfigFromEnv() {
    return {
        port: parseInt(process.env.VISUAL_COMPANION_PORT ?? '0', 10),
        targetUrl: process.env.VISUAL_COMPANION_TARGET_URL ?? 'http://localhost:3000',
        cwd: process.env.VISUAL_COMPANION_CWD ?? process.cwd(),
        shellDir: process.env.VISUAL_COMPANION_SHELL_DIR ?? '',
        injectFile: process.env.VISUAL_COMPANION_INJECT_FILE ?? '',
    };
}
//# sourceMappingURL=config.js.map