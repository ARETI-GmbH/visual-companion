import { spawn } from 'node-pty';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import WebSocket from 'ws';
/**
 * Locate the user's `claude` binary once at daemon startup. Checks common
 * install paths, then falls back to `which claude` via an interactive login
 * shell (which sources .zshrc and has the user's full PATH).
 *
 * Returns the absolute path, or empty string if not found.
 */
function detectClaudeBinary() {
    const commonPaths = [
        `${process.env.HOME}/.local/bin/claude`,
        `${process.env.HOME}/.claude/bin/claude`,
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        `${process.env.HOME}/.npm-global/bin/claude`,
        `${process.env.HOME}/.volta/bin/claude`,
        `${process.env.HOME}/.yarn/bin/claude`,
        `${process.env.HOME}/.bun/bin/claude`,
    ];
    for (const p of commonPaths) {
        if (existsSync(p))
            return p;
    }
    // Ask the login shell
    try {
        const shell = process.env.SHELL ?? '/bin/zsh';
        const result = spawnSync(shell, ['-lic', 'command -v claude'], {
            encoding: 'utf8',
            timeout: 5000,
        });
        const found = (result.stdout ?? '').trim().split('\n').pop()?.trim();
        if (found && existsSync(found))
            return found;
    }
    catch {
        // fall through
    }
    return '';
}
const CLAUDE_BIN = detectClaudeBinary();
// eslint-disable-next-line no-console
console.log(`visual-companion: claude binary = ${CLAUDE_BIN || '<NOT FOUND>'}`);
function sendData(socket, data) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'data', data }));
    }
}
export function registerPtyBridge(app, opts) {
    let currentPty = null;
    let currentSocket = null;
    const inputListeners = new Set();
    app.get('/_companion/pty', { websocket: true }, (conn) => {
        const socket = conn.socket ?? conn;
        currentSocket = socket;
        // If no claude binary, tell the user exactly what's wrong.
        if (!CLAUDE_BIN) {
            sendData(socket, '\r\n\x1b[31m[visual-companion] Could not find the `claude` CLI binary.\x1b[0m\r\n' +
                '\x1b[90mChecked: ~/.local/bin, ~/.claude/bin, /opt/homebrew/bin, /usr/local/bin,\r\n' +
                '         ~/.npm-global/bin, ~/.volta/bin, ~/.yarn/bin, ~/.bun/bin,\r\n' +
                '         plus `command -v claude` in your login shell.\x1b[0m\r\n\r\n' +
                'Run `which claude` in your normal terminal to find where it lives,\r\n' +
                'then symlink it to one of the paths above or report the path.\r\n');
            socket.close();
            return;
        }
        const companionPort = typeof opts.companionPort === 'function' ? opts.companionPort() : opts.companionPort;
        const childEnv = {
            ...process.env,
            VISUAL_COMPANION_PORT: String(companionPort),
            TERM: 'xterm-256color',
        };
        // Diagnostic header so the user can see exactly what was spawned.
        sendData(socket, `\x1b[90m[visual-companion] spawning: ${CLAUDE_BIN}${(opts.claudeArgs ?? []).length ? ' ' + (opts.claudeArgs ?? []).join(' ') : ''}\x1b[0m\r\n` +
            `\x1b[90m[visual-companion] cwd: ${opts.cwd}\x1b[0m\r\n` +
            `\x1b[90m[visual-companion] VISUAL_COMPANION_PORT=${companionPort}\x1b[0m\r\n\r\n`);
        let pty;
        try {
            pty = spawn(CLAUDE_BIN, opts.claudeArgs ?? [], {
                name: 'xterm-256color',
                cols: 120,
                rows: 30,
                cwd: opts.cwd,
                env: childEnv,
            });
        }
        catch (err) {
            sendData(socket, `\r\n\x1b[31m[visual-companion] spawn failed: ${err.message}\x1b[0m\r\n`);
            socket.close();
            return;
        }
        currentPty = pty;
        pty.onData((data) => sendData(socket, data));
        pty.onExit(({ exitCode, signal }) => {
            sendData(socket, `\r\n\x1b[90m[visual-companion] claude exited (code ${exitCode}${signal ? `, signal ${signal}` : ''})\x1b[0m\r\n`);
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'exit', exitCode }));
            }
        });
        socket.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'data') {
                    pty.write(msg.data);
                    for (const h of inputListeners)
                        h(msg.data);
                }
                if (msg.type === 'resize')
                    pty.resize(msg.cols, msg.rows);
            }
            catch {
                // ignore malformed
            }
        });
        socket.on('close', () => {
            try {
                pty.kill();
            }
            catch { }
            if (currentSocket === socket)
                currentSocket = null;
            if (currentPty === pty)
                currentPty = null;
        });
    });
    return {
        // Render text in the xterm display on the right pane. Goes via the
        // WebSocket that streams claude's stdout — we do NOT write to
        // claude's stdin, which would make ANSI sequences get parsed as
        // keystrokes and vanish silently.
        writeToTerminal(text) {
            if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
                currentSocket.send(JSON.stringify({ type: 'data', data: text }));
            }
        },
        // Type text into claude's stdin as if the user were typing. Lands
        // in claude's prompt line; the user can append their question
        // afterwards and hit Enter.
        injectInput(text) {
            if (currentPty)
                currentPty.write(text);
        },
        onTerminalInput(handler) {
            inputListeners.add(handler);
            return () => inputListeners.delete(handler);
        },
    };
}
//# sourceMappingURL=pty-bridge.js.map