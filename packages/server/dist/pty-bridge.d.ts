import { FastifyInstance } from 'fastify';
export interface PtyBridgeOptions {
    cwd: string;
    companionPort: number | (() => number);
    shell?: string;
    claudeArgs?: string[];
}
export interface PtyBridgeControl {
    writeToTerminal(text: string): void;
    onTerminalInput(handler: (data: string) => void): () => void;
}
export declare function registerPtyBridge(app: FastifyInstance, opts: PtyBridgeOptions): PtyBridgeControl;
