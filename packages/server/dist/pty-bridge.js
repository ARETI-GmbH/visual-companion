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
    // --- hidden prefix injection -------------------------------------
    // Tracks the printable text the user has typed since the last prompt
    // commit. We track best-effort from input bytes so that at Enter
    // time we can delete what they typed, retype <pending-prefix +
    // buffer>, and let claude see the combined text as one message.
    //
    // If the user does anything we can't cleanly track (arrow keys,
    // history recall, tab completion, paste with newlines, …) we set
    // bufferValid=false and fall back to a plain Enter. Safety over
    // cleverness.
    let userBuffer = '';
    let bufferValid = true;
    let pendingPrefix = null;
    function consumeInputChunk(data) {
        // Diagnostic: first 24 bytes as hex so we can see every escape
        // sequence the xterm sends. Goes to the daemon log (not xterm).
        const hex = Array.from(data.slice(0, 24))
            .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
            .join(' ');
        process.stderr.write(`[vc] in  len=${data.length}  hex=${hex}  validBefore=${bufferValid}\n`);
        if (data === '\x7f' || data === '\b') {
            userBuffer = userBuffer.slice(0, -1);
            return;
        }
        if (data === '\x03' || data === '\x15') {
            userBuffer = '';
            pendingPrefix = null;
            bufferValid = true;
            return;
        }
        // Strip everything we know is position-neutral from the chunk
        // (focus reports, SGR mouse, bracketed-paste markers, bare ESC).
        // What remains is either printable or a buffer-breaking key.
        let remainder = data
            .replace(/\x1b\[I/g, '')
            .replace(/\x1b\[O/g, '')
            .replace(/\x1b\[<[\d;]*[Mm]/g, '')
            .replace(/\x1b\[M.../g, '')
            .replace(/\x1b\[200~/g, '')
            .replace(/\x1b\[201~/g, '');
        if (remainder.length === 0)
            return; // pure focus/mouse noise
        // Arrow keys, home/end, delete, etc. — cursor-moving sequences.
        // Recognize them and invalidate (we can't reconstruct buffer
        // position after the user moved the cursor).
        if (/\x1b\[[A-D]/.test(remainder) || /\x1bO[A-D]/.test(remainder)) {
            bufferValid = false;
            return;
        }
        // Any other CSI we don't understand: be conservative — strip it
        // and keep going. Most unknown CSI responses don't edit the
        // prompt line.
        remainder = remainder.replace(/\x1b\[[\d;<>?]*[A-Za-z~]/g, '');
        remainder = remainder.replace(/\x1bO./g, '');
        // Control bytes (tab, newline accidentally in paste, etc.) are
        // ambiguous — strip and keep tracking but append nothing for them.
        const printable = remainder.replace(/[\x00-\x1f\x7f]/g, '');
        userBuffer += printable;
    }
    function commitWithPrefix(pty) {
        if (!pendingPrefix) {
            process.stderr.write('[vc] commit skipped: no pending prefix\n');
            return false;
        }
        if (bufferValid && userBuffer.length > 0) {
            // Clean path: delete what the user typed, retype prefix+buffer.
            process.stderr.write(`[vc] commit PRIMARY: buf=${userBuffer.length} prefixLen=${pendingPrefix.length}\n`);
            const deletion = '\x7f'.repeat(userBuffer.length);
            pty.write(deletion + pendingPrefix + userBuffer + '\r');
        }
        else {
            // Fallback: we don't know buffer state (arrow keys, empty, …).
            // Use Ctrl+A (home) + prefix + Ctrl+E (end) + Enter — lands the
            // prefix at the start of whatever claude's line contains right
            // now. Works even if our tracking drifted.
            process.stderr.write(`[vc] commit FALLBACK (ctrl-a/e): bufValid=${bufferValid} bufLen=${userBuffer.length} prefixLen=${pendingPrefix.length}\n`);
            pty.write('\x01' + pendingPrefix + '\x05\r');
        }
        userBuffer = '';
        pendingPrefix = null;
        bufferValid = true;
        return true;
    }
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
                    const data = String(msg.data);
                    // Enter / Return commits the prompt. If we have a pending
                    // selection prefix and a trackable buffer, intercept and
                    // rewrite the line so claude receives "prefix + buffer".
                    if (data === '\r' || data === '\n' || data === '\r\n') {
                        process.stderr.write(`[vc] ENTER  valid=${bufferValid} buf=${userBuffer.length} prefix=${!!pendingPrefix}\n`);
                        if (!commitWithPrefix(pty))
                            pty.write(data);
                        userBuffer = '';
                        bufferValid = true;
                    }
                    else {
                        consumeInputChunk(data);
                        pty.write(data);
                    }
                    for (const h of inputListeners)
                        h(data);
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
        setPendingPrefix(text) {
            pendingPrefix = text;
            process.stderr.write(`[vc] setPendingPrefix: len=${text.length}\n`);
        },
        onTerminalInput(handler) {
            inputListeners.add(handler);
            return () => inputListeners.delete(handler);
        },
    };
}
//# sourceMappingURL=pty-bridge.js.map