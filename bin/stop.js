#!/usr/bin/env node
/**
 * /visual-companion-stop entry point.
 *
 * Default: stops only the companion session tied to the current working
 * directory — exactly the project the user is asking from. Every other
 * session (different project, different claude window) is left alone.
 *
 * Pass `--all` to stop every running companion on the machine.
 *
 * Each launch.js writes a state file under
 *   /tmp/visual-companion-state-<daemonPid>.json
 * with { daemonPid, devServerPid, cwd, chromeProfileDir, … }. We read
 * those and only touch the matching daemon's daemon process + chrome
 * window. MCP stdio processes (`mcp-entry.js`) are owned by the Claude
 * CLI and never killed here.
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function readStateFiles() {
  let entries;
  try {
    entries = fs.readdirSync('/tmp');
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!/^visual-companion-state-\d+\.json$/.test(name)) continue;
    const file = path.join('/tmp', name);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof data.daemonPid === 'number') {
        out.push({ file, ...data });
      }
    } catch {
      // stale / corrupt, skip
    }
  }
  return out;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ps() {
  try {
    return execSync('ps -axo pid=,command=', { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function chromePidsForProfile(profileDir) {
  if (!profileDir) return [];
  const pids = [];
  for (const line of ps().split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    if (pid === process.pid) continue;
    const cmd = m[2];
    if (/Google Chrome/.test(cmd) && cmd.includes(`--user-data-dir=${profileDir}`)) {
      pids.push(pid);
    }
  }
  return pids;
}

function killAll(pids, signal) {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch {}
  }
}

function wait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { execSync('sleep 0.1'); } catch {}
  }
}

(function main() {
  const wantAll = process.argv.includes('--all');
  const cwd = process.cwd();
  const states = readStateFiles().filter((s) => isAlive(s.daemonPid));

  if (states.length === 0) {
    console.log('visual-companion-stop: nothing running.');
    return;
  }

  const targets = wantAll ? states : states.filter((s) => s.cwd === cwd);
  const others = states.filter((s) => !targets.includes(s));

  if (targets.length === 0) {
    console.log(`visual-companion-stop: no session in ${cwd}.`);
    if (others.length) {
      console.log(`  ${others.length} other session(s) running:`);
      for (const s of others) {
        console.log(`    - daemon pid=${s.daemonPid} cwd=${s.cwd}`);
      }
      console.log('  run `/visual-companion-stop --all` to stop everything.');
    }
    return;
  }

  console.log(
    `visual-companion-stop: stopping ${targets.length} session(s)${wantAll ? ' (--all)' : ''}.`,
  );
  if (others.length && !wantAll) {
    console.log(
      `  leaving ${others.length} other session(s) untouched (use --all to include them).`,
    );
  }

  const allChromePids = [];
  for (const t of targets) {
    const chromePids = chromePidsForProfile(t.chromeProfileDir);
    console.log(
      `  daemon pid=${t.daemonPid} cwd=${t.cwd}  (${chromePids.length} chrome pid(s))`,
    );
    try { process.kill(t.daemonPid, 'SIGTERM'); } catch {}
    allChromePids.push(...chromePids);
  }
  killAll(allChromePids, 'SIGTERM');

  // Give daemons ~2s to run their shutdown (removes state file, kills
  // dev server, runs reverse-transform if applicable).
  wait(2000);

  const stragglerDaemons = targets
    .filter((t) => isAlive(t.daemonPid))
    .map((t) => t.daemonPid);
  const stragglerChromes = [];
  for (const t of targets) {
    for (const pid of chromePidsForProfile(t.chromeProfileDir)) {
      if (isAlive(pid)) stragglerChromes.push(pid);
    }
  }
  if (stragglerDaemons.length || stragglerChromes.length) {
    console.log(
      `visual-companion-stop: ${
        stragglerDaemons.length + stragglerChromes.length
      } straggler(s) — sending SIGKILL.`,
    );
    killAll(stragglerDaemons, 'SIGKILL');
    killAll(stragglerChromes, 'SIGKILL');
  }

  // Delete state files for daemons we stopped (daemons clean their
  // own on graceful shutdown; this covers SIGKILL'd ones too).
  for (const t of targets) {
    try { fs.unlinkSync(t.file); } catch {}
  }

  console.log('visual-companion-stop: done.');
})();
