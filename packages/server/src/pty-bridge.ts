import { FastifyInstance } from 'fastify';
import { spawn, IPty } from 'node-pty';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import WebSocket from 'ws';

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
  /** Queue a context prefix to be silently prepended to the user's next
   *  prompt. At Enter time the bridge rewrites the line so claude sees
   *  "prefix + user text" as a single message — without the prefix ever
   *  appearing in the user's prompt line. Replaces any previous pending
   *  prefix. */
  setPendingPrefix(text: string): void;
  onTerminalInput(handler: (data: string) => void): () => void;
}

/**
 * Locate the user's `claude` binary once at daemon startup. Checks common
 * install paths, then falls back to `which claude` via an interactive login
 * shell (which sources .zshrc and has the user's full PATH).
 *
 * Returns the absolute path, or empty string if not found.
 */
function detectClaudeBinary(): string {
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
    if (existsSync(p)) return p;
  }
  // Ask the login shell
  try {
    const shell = process.env.SHELL ?? '/bin/zsh';
    const result = spawnSync(shell, ['-lic', 'command -v claude'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const found = (result.stdout ?? '').trim().split('\n').pop()?.trim();
    if (found && existsSync(found)) return found;
  } catch {
    // fall through
  }
  return '';
}

const CLAUDE_BIN = detectClaudeBinary();
// eslint-disable-next-line no-console
console.log(`visual-companion: claude binary = ${CLAUDE_BIN || '<NOT FOUND>'}`);

function sendData(socket: WebSocket, data: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'data', data }));
  }
}

export function registerPtyBridge(app: FastifyInstance, opts: PtyBridgeOptions): PtyBridgeControl {
  let currentPty: IPty | null = null;
  let currentSocket: WebSocket | null = null;
  const inputListeners = new Set<(d: string) => void>();

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
  let pendingPrefix: string | null = null;

  function consumeInputChunk(data: string): void {
    if (data === '\x7f' || data === '\b') {
      userBuffer = userBuffer.slice(0, -1);
      return;
    }
    if (data === '\x03' || data === '\x15') {
      // Ctrl+C (abort) or Ctrl+U (clear line) — prompt is being reset.
      userBuffer = '';
      pendingPrefix = null;
      bufferValid = true;
      return;
    }
    if (data.charCodeAt(0) === 0x1b) {
      // Escape sequence (arrow keys, function keys, mouse reports, …).
      // Claude's buffer may no longer match ours; bail out of tracking.
      bufferValid = false;
      return;
    }
    if (data.length === 1 && data >= ' ') {
      userBuffer += data;
      return;
    }
    if (data.length > 1) {
      // Multi-byte chunk — paste, UTF-8 sequence, or wrapped typing.
      // Strip controls and append the rest; still best-effort.
      const stripped = data.replace(/[\x00-\x1f\x7f]/g, '');
      if (stripped !== data) bufferValid = false;
      userBuffer += stripped;
      return;
    }
    // Anything else (unknown single control char) — can't track.
    bufferValid = false;
  }

  function commitWithPrefix(pty: IPty): boolean {
    if (!pendingPrefix || !bufferValid || userBuffer.length === 0) return false;
    // Backspace over whatever the user typed, then retype prefix+text
    // and send Enter as a single write so claude sees it as one edit.
    const deletion = '\x7f'.repeat(userBuffer.length);
    pty.write(deletion + pendingPrefix + userBuffer + '\r');
    userBuffer = '';
    pendingPrefix = null;
    bufferValid = true;
    return true;
  }

  app.get('/_companion/pty', { websocket: true } as any, (conn: any) => {
    const socket: WebSocket = conn.socket ?? conn;
    currentSocket = socket;

    // If no claude binary, tell the user exactly what's wrong.
    if (!CLAUDE_BIN) {
      sendData(
        socket,
        '\r\n\x1b[31m[visual-companion] Could not find the `claude` CLI binary.\x1b[0m\r\n' +
          '\x1b[90mChecked: ~/.local/bin, ~/.claude/bin, /opt/homebrew/bin, /usr/local/bin,\r\n' +
          '         ~/.npm-global/bin, ~/.volta/bin, ~/.yarn/bin, ~/.bun/bin,\r\n' +
          '         plus `command -v claude` in your login shell.\x1b[0m\r\n\r\n' +
          'Run `which claude` in your normal terminal to find where it lives,\r\n' +
          'then symlink it to one of the paths above or report the path.\r\n',
      );
      socket.close();
      return;
    }

    const companionPort =
      typeof opts.companionPort === 'function' ? opts.companionPort() : opts.companionPort;

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      VISUAL_COMPANION_PORT: String(companionPort),
      TERM: 'xterm-256color',
    };

    // Diagnostic header so the user can see exactly what was spawned.
    sendData(
      socket,
      `\x1b[90m[visual-companion] spawning: ${CLAUDE_BIN}${(opts.claudeArgs ?? []).length ? ' ' + (opts.claudeArgs ?? []).join(' ') : ''}\x1b[0m\r\n` +
        `\x1b[90m[visual-companion] cwd: ${opts.cwd}\x1b[0m\r\n` +
        `\x1b[90m[visual-companion] VISUAL_COMPANION_PORT=${companionPort}\x1b[0m\r\n\r\n`,
    );

    let pty: IPty;
    try {
      pty = spawn(CLAUDE_BIN, opts.claudeArgs ?? [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: opts.cwd,
        env: childEnv as { [key: string]: string },
      });
    } catch (err) {
      sendData(
        socket,
        `\r\n\x1b[31m[visual-companion] spawn failed: ${(err as Error).message}\x1b[0m\r\n`,
      );
      socket.close();
      return;
    }
    currentPty = pty;

    pty.onData((data) => sendData(socket, data));
    pty.onExit(({ exitCode, signal }) => {
      sendData(
        socket,
        `\r\n\x1b[90m[visual-companion] claude exited (code ${exitCode}${signal ? `, signal ${signal}` : ''})\x1b[0m\r\n`,
      );
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'exit', exitCode }));
      }
    });

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'data') {
          const data = String(msg.data);
          // Enter / Return commits the prompt. If we have a pending
          // selection prefix and a trackable buffer, intercept and
          // rewrite the line so claude receives "prefix + buffer".
          if (data === '\r' || data === '\n' || data === '\r\n') {
            if (!commitWithPrefix(pty)) pty.write(data);
            userBuffer = '';
            bufferValid = true;
          } else {
            consumeInputChunk(data);
            pty.write(data);
          }
          for (const h of inputListeners) h(data);
        }
        if (msg.type === 'resize') pty.resize(msg.cols, msg.rows);
      } catch {
        // ignore malformed
      }
    });
    socket.on('close', () => {
      try { pty.kill(); } catch {}
      if (currentSocket === socket) currentSocket = null;
      if (currentPty === pty) currentPty = null;
    });
  });

  return {
    // Render text in the xterm display on the right pane. Goes via the
    // WebSocket that streams claude's stdout — we do NOT write to
    // claude's stdin, which would make ANSI sequences get parsed as
    // keystrokes and vanish silently.
    writeToTerminal(text: string) {
      if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
        currentSocket.send(JSON.stringify({ type: 'data', data: text }));
      }
    },
    // Type text into claude's stdin as if the user were typing. Lands
    // in claude's prompt line; the user can append their question
    // afterwards and hit Enter.
    injectInput(text: string) {
      if (currentPty) currentPty.write(text);
    },
    setPendingPrefix(text: string) {
      pendingPrefix = text;
    },
    onTerminalInput(handler) {
      inputListeners.add(handler);
      return () => inputListeners.delete(handler);
    },
  };
}
