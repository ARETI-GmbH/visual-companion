#!/usr/bin/env node
/**
 * /visual-companion-stop entry point.
 *
 * Finds and terminates every running companion daemon and its isolated
 * Chrome-app window. Useful after a plugin update so the next
 * /visual-companion call spawns a fresh daemon from the updated cache.
 *
 * Kills in two waves:
 *  1. SIGTERM everything — daemons cleanly close Fastify, kill the
 *     dev-server child (via VISUAL_COMPANION_DEV_PID), and remove the
 *     Chrome profile dir. Chrome itself exits when its top process dies.
 *  2. After a short grace period, SIGKILL anything still alive.
 *
 * MCP stdio processes (`mcp-entry.js`) are intentionally left alone —
 * those are controlled by the Claude CLI, not by the companion window.
 */

const { execSync } = require('node:child_process');

function ps() {
  try {
    return execSync('ps -axo pid=,command=', { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function scan(psOut) {
  const daemons = [];
  const chromes = [];
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const cmd = m[2];
    if (pid === process.pid) continue;
    if (/\bnode\b/.test(cmd) && /visual-companion.*packages\/server\/dist\/index\.js/.test(cmd)) {
      daemons.push({ pid, cmd });
    } else if (/Google Chrome/.test(cmd) && /--user-data-dir=\/tmp\/visual-companion-/.test(cmd)) {
      chromes.push({ pid, cmd });
    }
  }
  return { daemons, chromes };
}

function killAll(list, signal) {
  for (const { pid } of list) {
    try { process.kill(pid, signal); } catch {}
  }
}

function wait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // spin-wait is fine here, we only wait ~2s total
    try { execSync('sleep 0.1'); } catch {}
  }
}

(function main() {
  const initial = scan(ps());
  const total = initial.daemons.length + initial.chromes.length;
  if (total === 0) {
    console.log('visual-companion-stop: nothing running.');
    return;
  }

  console.log(
    `visual-companion-stop: stopping ${initial.daemons.length} daemon(s) ` +
      `and ${initial.chromes.length} chrome window(s).`,
  );
  for (const d of initial.daemons) console.log(`  daemon  pid=${d.pid}`);
  for (const c of initial.chromes) console.log(`  chrome  pid=${c.pid}`);

  killAll(initial.daemons, 'SIGTERM');
  killAll(initial.chromes, 'SIGTERM');

  // Give daemons up to 2s to run their shutdown() (dev-server kill, rmSync)
  wait(2000);

  const remaining = scan(ps());
  if (remaining.daemons.length || remaining.chromes.length) {
    console.log(
      `visual-companion-stop: ${remaining.daemons.length + remaining.chromes.length} ` +
        `process(es) still alive, sending SIGKILL.`,
    );
    killAll(remaining.daemons, 'SIGKILL');
    killAll(remaining.chromes, 'SIGKILL');
  }

  console.log('visual-companion-stop: done.');
})();
