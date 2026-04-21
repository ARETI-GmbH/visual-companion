export interface ServerConfig {
    port: number;
    targetUrl: string;
    cwd: string;
    shellDir: string;
    injectFile: string;
}
export declare function getConfigFromEnv(): ServerConfig;
