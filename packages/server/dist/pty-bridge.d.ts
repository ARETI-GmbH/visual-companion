import { FastifyInstance } from 'fastify';
export interface PtyBridgeOptions {
    cwd: string;
    companionPort: number | (() => number);
    shell?: string;
    claudeArgs?: string[];
}
export interface PtyBridgeControl {
    /** Push `text` to the xterm display (visible to the user). Does NOT
     *  reach claude's stdin; use for status lines / notifications. */
    writeToTerminal(text: string): void;
    /** Type `text` into claude's stdin as if the user typed it. Use for
     *  quick-injecting selected-element context into the prompt line. */
    injectInput(text: string): void;
    onTerminalInput(handler: (data: string) => void): () => void;
}
export declare function registerPtyBridge(app: FastifyInstance, opts: PtyBridgeOptions): PtyBridgeControl;
