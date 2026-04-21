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
    // Diagnostic: first 24 bytes as hex so we can see every escape
    // sequence the xterm sends. Goes to the daemon log (not xterm).
    const hex = Array.from(data.slice(0, 24))
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join(' ');
    process.stderr.write(
      `[vc] in  len=${data.length}  hex=${hex}  validBefore=${bufferValid}\n`,
    );

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
    if (remainder.length === 0) return; // pure focus/mouse noise

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

  function commitWithPrefix(pty: IPty): boolean {
    if (!pendingPrefix) return false;
    if (!bufferValid || userBuffer.length === 0) {
      // Can't safely splice — the Ctrl+A/E fallback caused a double-Enter
      // in Claude Code's Ink-based TUI (which doesn't treat them as line
      // navigation), so we now drop the prefix and send a plain Enter.
      // Loses the context for that one turn, but Enter works cleanly.
      process.stderr.write(
        `[vc] commit DROP: valid=${bufferValid} buf=${userBuffer.length}\n`,
      );
      pendingPrefix = null;
      return false;
    }
    process.stderr.write(
      `[vc] commit OK: buf=${userBuffer.length} prefixLen=${pendingPrefix.length}\n`,
    );
    const deletion = '\x7f'.repeat(userBuffer.length);
    pty.write(deletion + pendingPrefix + userBuffer + '\r');
    userBuffer = '';
    pendingPrefix = null;
    bufferValid = true;
    return true;
  }

  // Ring-buffer of recent pty output. If the shell reloads (plugin
  // update, Cmd+R, etc.) the fresh xterm would otherwise start blank
  // and the user would lose their conversation view. With claude's
  // Ink/React TUI we force a SIGWINCH redraw right after reconnect —
  // Ink re-renders the whole message list. We also replay the last
  // chunk of output, so even if the redraw is slow the view isn't
  // empty for long.
  const REPLAY_MAX = 64 * 1024;
  let replayBuffer = '';
  let ptyOutputWired = false;

  function wirePtyOutput(pty: IPty): void {
    if (ptyOutputWired) return;
    ptyOutputWired = true;
    pty.onData((data) => {
      replayBuffer += data;
      if (replayBuffer.length > REPLAY_MAX) {
        replayBuffer = replayBuffer.slice(-REPLAY_MAX);
      }
      if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
        currentSocket.send(JSON.stringify({ type: 'data', data }));
      }
    });
    pty.onExit(({ exitCode, signal }) => {
      const msg = `\r\n\x1b[90m[visual-companion] claude exited (code ${exitCode}${signal ? `, signal ${signal}` : ''})\x1b[0m\r\n`;
      replayBuffer += msg;
      if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
        currentSocket.send(JSON.stringify({ type: 'data', data: msg }));
        currentSocket.send(JSON.stringify({ type: 'exit', exitCode }));
      }
      currentPty = null;
      ptyOutputWired = false;
      replayBuffer = '';
    });
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

    // --- reconnect path: pty already alive (shell was reloaded) ----
    if (currentPty) {
      process.stderr.write('[vc] pty reconnect — replaying buffer + forcing redraw\n');
      // Clear the new xterm, replay the tail of what we've seen so
      // the user's view isn't blank, then SIGWINCH (via a resize
      // roundtrip) to make claude's Ink TUI redraw its full state.
      sendData(socket, '\x1b[2J\x1b[H\x1b[3J');
      if (replayBuffer.length > 0) sendData(socket, replayBuffer);
      setTimeout(() => {
        try {
          currentPty?.resize(121, 30);
          setTimeout(() => {
            try { currentPty?.resize(120, 30); } catch {}
          }, 40);
        } catch {}
      }, 120);
      wireInputFromSocket(socket);
      return;
    }

    // --- first connect: actually spawn claude -----------------------
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      VISUAL_COMPANION_PORT: String(companionPort),
      TERM: 'xterm-256color',
    };

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
    wirePtyOutput(pty);
    wireInputFromSocket(socket);
  });

  function wireInputFromSocket(socket: WebSocket): void {
    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'data' && currentPty) {
          const data = String(msg.data);
          if (data === '\r' || data === '\n' || data === '\r\n') {
            process.stderr.write(
              `[vc] ENTER  valid=${bufferValid} buf=${userBuffer.length} prefix=${!!pendingPrefix}\n`,
            );
            if (!commitWithPrefix(currentPty)) currentPty.write(data);
            userBuffer = '';
            bufferValid = true;
          } else {
            consumeInputChunk(data);
            currentPty.write(data);
          }
          for (const h of inputListeners) h(data);
        }
        if (msg.type === 'resize' && currentPty) {
          currentPty.resize(msg.cols, msg.rows);
        }
      } catch {
        // ignore malformed
      }
    });
    socket.on('close', () => {
      // Do NOT kill the pty. Shell reloads (plugin update, Cmd+R)
      // tear the socket down but the user expects to come back to
      // the same claude session. The idle watchdog in index.ts
      // handles eventual cleanup if no client reconnects within 60s.
      if (currentSocket === socket) currentSocket = null;
      process.stderr.write('[vc] pty socket closed — pty kept alive\n');
    });
  }

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
      process.stderr.write(`[vc] setPendingPrefix: len=${text.length}\n`);
    },
    onTerminalInput(handler) {
      inputListeners.add(handler);
      return () => inputListeners.delete(handler);
    },
  };
}
