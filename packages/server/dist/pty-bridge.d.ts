import { FastifyInstance } from 'fastify';
export interface PtyBridgeOptions {
    cwd: string;
    companionPort: number | (() => number);
    shell?: string;
    claudeArgs?: string[];
    /** Called when claude transitions between actively streaming output
     *  (busy, e.g. typing a response / running a tool) and quiet
     *  (idle, prompt ready). Used by the daemon to tell the inject
     *  overlay to hide during claude's turn so the view isn't
     *  constantly flickering as the iframe HMR-reloads from claude's
     *  edits, and re-show when the turn is done. */
    onActivityChange?: (isBusy: boolean) => void;
}
export interface PtyBridgeControl {
    /** Push `text` to the xterm display (visible to the user). Does NOT
     *  reach claude's stdin; use for status lines / notifications. */
    writeToTerminal(text: string): void;
    /** Type `text` into claude's stdin as if the user typed it. Use for
     *  quick-injecting selected-element context into the prompt line. */
    injectInput(text: string): void;
    /** Queue a context prefix to be silently prepended to the user's next
     *  prompt. At Enter time the bridge rewrites the line so claude sees
     *  "prefix + user text" as a single message — without the prefix ever
     *  appearing in the user's prompt line. Stays sticky across commits
     *  so follow-up messages (incl. across iframe navigation) retain the
     *  context. Replaces any previous pending prefix. */
    setPendingPrefix(text: string): void;
    /** Clear any sticky pending prefix — usually called when the user
     *  presses Esc on the companion pane to drop the active selection. */
    clearPendingPrefix(): void;
    /** Simulate the user pressing Enter in the terminal: commits the
     *  current prefix (if any) + userBuffer and fires the newline.
     *  Used by the shell's "Send to claude" button. */
    pressEnter(): void;
    onTerminalInput(handler: (data: string) => void): () => void;
}
export declare function registerPtyBridge(app: FastifyInstance, opts: PtyBridgeOptions): PtyBridgeControl;
