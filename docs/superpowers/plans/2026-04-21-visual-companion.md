# Visual Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@areti-gmbh/visual-companion` Claude-Code plugin — a unified Chrome-App-Mode window combining a reverse-proxied user web-app pane with an xterm.js Claude Code session, connected by a live event stream and MCP tool surface.

**Architecture:** Node.js daemon (Fastify + WebSockets) that hosts a reverse proxy (injects a companion script into the user's app), a WebSocket event gateway, an in-memory ring-buffer event store, a node-pty bridge to a spawned `claude` process, and an MCP stdio server. The Chrome App window loads a split-view shell (iframe + xterm.js). All state is ephemeral — no disk persistence, isolated browser profile per window.

**Tech Stack:** Node.js 20+, TypeScript, Fastify, `@fastify/websocket`, `ws`, `node-pty`, xterm.js (+ `xterm-addon-fit`, `xterm-addon-web-links`), `@modelcontextprotocol/sdk`, `html2canvas` (screenshot MVP), Vitest + jsdom (unit), Playwright (e2e), esbuild (bundling).

---

## Repository Layout (target end state)

```
visual-companion/
├── claude-plugin.json            # Plugin-Manifest
├── package.json                  # Root workspace (npm workspaces)
├── tsconfig.base.json
├── vitest.config.ts
├── .eslintrc.cjs
├── bin/
│   └── launch.js                 # /visual-companion entry (CJS, no build)
├── packages/
│   ├── server/                   # Companion Daemon + MCP Server
│   │   ├── src/
│   │   │   ├── index.ts          # Server entry
│   │   │   ├── mcp-entry.ts      # MCP stdio entry (--mcp-mode)
│   │   │   ├── proxy.ts          # Reverse Proxy
│   │   │   ├── websocket.ts      # WS Gateway
│   │   │   ├── event-store.ts    # Ring-Buffer + Screenshot LRU
│   │   │   ├── pty-bridge.ts     # node-pty ↔ xterm.js
│   │   │   ├── mcp-tools.ts      # MCP Tool implementations
│   │   │   └── types.ts          # Shared TypeScript types
│   │   ├── test/
│   │   │   ├── event-store.test.ts
│   │   │   ├── proxy.test.ts
│   │   │   └── websocket.test.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── shell/                    # Companion Window (Chrome App)
│   │   ├── src/
│   │   │   ├── window.html
│   │   │   ├── window.ts         # Split layout + titlebar + status
│   │   │   ├── terminal.ts       # xterm.js wiring
│   │   │   ├── iframe.ts         # iframe lifecycle + keybindings
│   │   │   └── styles.css
│   │   ├── dist/                 # Build output (served by server)
│   │   ├── package.json
│   │   └── esbuild.config.mjs
│   └── inject/                   # Injected Companion Script
│       ├── src/
│       │   ├── index.ts          # Entry, WS-connect, dispatch
│       │   ├── console-patch.ts
│       │   ├── network-patch.ts
│       │   ├── error-handler.ts
│       │   ├── mutation-observer.ts
│       │   ├── navigation-hooks.ts
│       │   ├── overlay.ts        # Shadow DOM UI
│       │   ├── pointer.ts        # Alt-key + element capture
│       │   ├── selector-gen.ts   # Unique CSS selector
│       │   ├── style-filter.ts   # Computed styles filtering
│       │   ├── screenshot.ts     # html2canvas wrapper
│       │   └── source-map.ts     # Source-Map lookup
│       ├── test/
│       │   ├── selector-gen.test.ts
│       │   └── style-filter.test.ts
│       ├── dist/
│       ├── package.json
│       └── esbuild.config.mjs
└── tests/
    └── e2e/
        ├── ares-fixture.html
        ├── ares-proxy.spec.ts
        └── nextjs-proxy.spec.ts
```

---

## Phase 1 — Project Scaffolding

### Task 1: Initialize root npm workspace

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.eslintrc.cjs`
- Create: `.prettierrc`
- Modify: `.gitignore` (add `dist/`, `node_modules/`, `*.tsbuildinfo`, `coverage/`)

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "@areti-gmbh/visual-companion",
  "version": "0.1.0",
  "private": true,
  "description": "Unified Chrome-App Window mit Live-Pointer für Web-App-Entwicklung",
  "license": "UNLICENSED",
  "workspaces": [
    "packages/server",
    "packages/shell",
    "packages/inject"
  ],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "playwright test",
    "lint": "eslint 'packages/**/src/**/*.ts'",
    "typecheck": "tsc -b packages/*/tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@typescript-eslint/eslint-plugin": "^7.13.0",
    "@typescript-eslint/parser": "^7.13.0",
    "eslint": "^8.57.0",
    "prettier": "^3.3.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0",
    "jsdom": "^24.1.0",
    "@playwright/test": "^1.44.0"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

- [ ] **Step 3: Update `.gitignore`**

Append to existing `.gitignore`:
```
node_modules/
dist/
coverage/
*.tsbuildinfo
.vitest-cache/
test-results/
playwright-report/
```

- [ ] **Step 4: Create `.eslintrc.cjs`**

```js
module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'off'
  },
  env: { node: true, es2022: true }
};
```

- [ ] **Step 5: Create `.prettierrc`**

```json
{
  "singleQuote": true,
  "semi": true,
  "printWidth": 100,
  "trailingComma": "es5"
}
```

- [ ] **Step 6: Install and verify**

Run: `npm install`
Expected: installs root dev dependencies, no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.base.json .eslintrc.cjs .prettierrc .gitignore
git commit -m "chore: initialize npm workspace + tooling"
```

---

### Task 2: Create workspace package skeletons

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/src/index.ts`
- Create: `packages/shell/package.json`
- Create: `packages/shell/src/window.html`
- Create: `packages/inject/package.json`
- Create: `packages/inject/src/index.ts`

- [ ] **Step 1: Create `packages/server/package.json`**

```json
{
  "name": "@areti-gmbh/visual-companion-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "fastify": "^4.27.0",
    "@fastify/websocket": "^10.0.1",
    "@fastify/http-proxy": "^9.5.0",
    "ws": "^8.17.0",
    "node-pty": "^1.0.0",
    "@modelcontextprotocol/sdk": "^0.5.0",
    "undici": "^6.19.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.10"
  }
}
```

- [ ] **Step 2: Create `packages/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "test"]
}
```

- [ ] **Step 3: Create placeholder `packages/server/src/index.ts`**

```ts
export const VISUAL_COMPANION_VERSION = '0.1.0';
console.log('companion-server: entry reached');
```

- [ ] **Step 4: Create `packages/shell/package.json`**

```json
{
  "name": "@areti-gmbh/visual-companion-shell",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node esbuild.config.mjs"
  },
  "dependencies": {
    "xterm": "^5.3.0",
    "xterm-addon-fit": "^0.8.0",
    "xterm-addon-web-links": "^0.9.0"
  },
  "devDependencies": {
    "esbuild": "^0.21.4"
  }
}
```

- [ ] **Step 5: Create placeholder `packages/shell/src/window.html`**

```html
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>Visual Companion</title>
  <link rel="stylesheet" href="./window.css">
</head>
<body>
  <div id="app">Visual Companion placeholder</div>
  <script type="module" src="./window.js"></script>
</body>
</html>
```

- [ ] **Step 6: Create `packages/inject/package.json`**

```json
{
  "name": "@areti-gmbh/visual-companion-inject",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node esbuild.config.mjs",
    "test": "vitest run"
  },
  "dependencies": {
    "html2canvas": "^1.4.1"
  },
  "devDependencies": {
    "esbuild": "^0.21.4"
  }
}
```

- [ ] **Step 7: Create placeholder `packages/inject/src/index.ts`**

```ts
console.log('[visual-companion] inject script loaded');
```

- [ ] **Step 8: Install workspaces**

Run: `npm install`
Expected: installs workspace dependencies, creates `node_modules` at root.

- [ ] **Step 9: Commit**

```bash
git add packages/
git commit -m "chore: add workspace package skeletons"
```

---

### Task 3: Configure esbuild for shell + inject

**Files:**
- Create: `packages/shell/esbuild.config.mjs`
- Create: `packages/inject/esbuild.config.mjs`

- [ ] **Step 1: Create `packages/shell/esbuild.config.mjs`**

```js
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('./dist', { recursive: true });

await build({
  entryPoints: ['./src/window.ts'],
  bundle: true,
  outfile: './dist/window.js',
  format: 'esm',
  target: ['chrome120'],
  sourcemap: 'inline',
  logLevel: 'info',
});

await copyFile('./src/window.html', './dist/window.html');
await copyFile('./src/styles.css', './dist/window.css');
console.log('shell: build complete');
```

- [ ] **Step 2: Create `packages/inject/esbuild.config.mjs`**

```js
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('./dist', { recursive: true });

await build({
  entryPoints: ['./src/index.ts'],
  bundle: true,
  outfile: './dist/inject.js',
  format: 'iife',
  globalName: '__visualCompanion__',
  target: ['chrome100'],
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

console.log('inject: build complete');
```

- [ ] **Step 3: Create `packages/shell/src/window.ts` + `styles.css` stubs**

```ts
// packages/shell/src/window.ts
console.log('[shell] window.ts bootstrap');
```

```css
/* packages/shell/src/styles.css */
body { margin: 0; font-family: -apple-system, sans-serif; }
```

- [ ] **Step 4: Verify builds**

Run: `npm run build -w @areti-gmbh/visual-companion-shell`
Expected: `dist/window.js`, `window.html`, `window.css` exist.

Run: `npm run build -w @areti-gmbh/visual-companion-inject`
Expected: `dist/inject.js` exists, minified.

- [ ] **Step 5: Commit**

```bash
git add packages/shell/esbuild.config.mjs packages/shell/src/styles.css packages/inject/esbuild.config.mjs
git commit -m "chore: add esbuild configs for shell + inject"
```

---

## Phase 2 — Event Store

### Task 4: Ring-Buffer Event Store

**Files:**
- Create: `packages/server/src/types.ts`
- Create: `packages/server/src/event-store.ts`
- Create: `packages/server/test/event-store.test.ts`

- [ ] **Step 1: Define event types in `types.ts`**

```ts
export type EventType = 'pointer' | 'console' | 'network' | 'mutation' | 'navigation' | 'error';

export interface BaseEvent {
  id: string;
  timestamp: number;
  type: EventType;
  url: string;
}

export interface PointerEventPayload {
  tagName: string;
  id: string | null;
  classes: string[];
  dataAttributes: Record<string, string>;
  outerHTML: string;
  cssSelector: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  textContent: string;
  computedStyles: {
    layout: Record<string, string>;
    typography: Record<string, string>;
    colors: Record<string, string>;
    spacing: Record<string, string>;
  };
  screenshotDataUrl: string | null;
  sourceLocation: { file: string; line: number; column: number } | null;
  ancestors: Array<{
    tagName: string;
    id: string | null;
    classes: string[];
    cssSelector: string;
  }>;
}

export interface ConsoleEventPayload {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  args: unknown[];
}

export interface NetworkEventPayload {
  method: string;
  url: string;
  status: number;
  durationMs: number;
  requestSize: number;
  responseSize: number;
}

export type CompanionEvent =
  | (BaseEvent & { type: 'pointer'; payload: PointerEventPayload })
  | (BaseEvent & { type: 'console'; payload: ConsoleEventPayload })
  | (BaseEvent & { type: 'network'; payload: NetworkEventPayload })
  | (BaseEvent & { type: 'mutation'; payload: { adds: number; removes: number; attributeChanges: number } })
  | (BaseEvent & { type: 'navigation'; payload: { newUrl: string; referrer: string } })
  | (BaseEvent & { type: 'error'; payload: { message: string; stack: string | null } });
```

- [ ] **Step 2: Write failing test `event-store.test.ts`**

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../src/event-store';
import type { CompanionEvent } from '../src/types';

function consoleEvent(ts: number, msg: string): CompanionEvent {
  return {
    id: `e-${ts}`,
    timestamp: ts,
    type: 'console',
    url: 'http://localhost:3000',
    payload: { level: 'log', args: [msg] },
  };
}

describe('EventStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('appends and queries events since a timestamp', () => {
    const store = new EventStore({ maxEvents: 100, maxAgeMs: 5 * 60_000 });
    store.append(consoleEvent(1000, 'a'));
    store.append(consoleEvent(2000, 'b'));
    store.append(consoleEvent(3000, 'c'));
    expect(store.querySince(2000)).toHaveLength(2);
  });

  it('filters by type', () => {
    const store = new EventStore({ maxEvents: 100, maxAgeMs: 5 * 60_000 });
    store.append(consoleEvent(1000, 'a'));
    store.append({
      id: 'p-1',
      timestamp: 1500,
      type: 'pointer',
      url: 'http://localhost:3000',
      payload: {} as any,
    });
    expect(store.query({ types: ['console'] })).toHaveLength(1);
    expect(store.query({ types: ['pointer'] })).toHaveLength(1);
  });

  it('evicts by maxEvents', () => {
    const store = new EventStore({ maxEvents: 3, maxAgeMs: Infinity });
    store.append(consoleEvent(1, 'a'));
    store.append(consoleEvent(2, 'b'));
    store.append(consoleEvent(3, 'c'));
    store.append(consoleEvent(4, 'd'));
    const all = store.query({});
    expect(all).toHaveLength(3);
    expect(all.map((e) => (e.payload as any).args[0])).toEqual(['b', 'c', 'd']);
  });

  it('evicts by maxAgeMs', () => {
    const nowMs = Date.now();
    const store = new EventStore({ maxEvents: 100, maxAgeMs: 1000 });
    store.append(consoleEvent(nowMs - 2000, 'old'));
    store.append(consoleEvent(nowMs - 500, 'recent'));
    store.prune();
    const all = store.query({});
    expect(all).toHaveLength(1);
    expect((all[0].payload as any).args[0]).toBe('recent');
  });

  it('getPointedElement returns latest pointer event', () => {
    const store = new EventStore({ maxEvents: 100, maxAgeMs: 5 * 60_000 });
    store.append(consoleEvent(1000, 'a'));
    store.append({
      id: 'p-1',
      timestamp: 2000,
      type: 'pointer',
      url: 'x',
      payload: { tagName: 'div' } as any,
    });
    store.append({
      id: 'p-2',
      timestamp: 3000,
      type: 'pointer',
      url: 'y',
      payload: { tagName: 'button' } as any,
    });
    const last = store.getLatestPointer();
    expect(last?.id).toBe('p-2');
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `npm test -w @areti-gmbh/visual-companion-server`
Expected: FAIL with "Cannot find module '../src/event-store'".

- [ ] **Step 4: Implement `event-store.ts`**

```ts
import type { CompanionEvent, EventType } from './types';

export interface EventStoreOptions {
  maxEvents: number;
  maxAgeMs: number;
}

export interface QueryOptions {
  sinceMs?: number;
  types?: EventType[];
  limit?: number;
}

export class EventStore {
  private events: CompanionEvent[] = [];
  constructor(private readonly opts: EventStoreOptions) {}

  append(event: CompanionEvent): void {
    this.events.push(event);
    this.evictIfNeeded();
  }

  querySince(sinceMs: number): CompanionEvent[] {
    return this.events.filter((e) => e.timestamp >= sinceMs);
  }

  query(opts: QueryOptions): CompanionEvent[] {
    let out = this.events;
    if (opts.sinceMs !== undefined) out = out.filter((e) => e.timestamp >= opts.sinceMs!);
    if (opts.types) out = out.filter((e) => opts.types!.includes(e.type));
    if (opts.limit !== undefined) out = out.slice(-opts.limit);
    return out;
  }

  getLatestPointer(): CompanionEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === 'pointer') return this.events[i];
    }
    return null;
  }

  prune(): void {
    const cutoff = Date.now() - this.opts.maxAgeMs;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
  }

  size(): number {
    return this.events.length;
  }

  private evictIfNeeded(): void {
    if (this.events.length > this.opts.maxEvents) {
      this.events.splice(0, this.events.length - this.opts.maxEvents);
    }
  }
}
```

- [ ] **Step 5: Run test — verify it passes**

Run: `npm test -w @areti-gmbh/visual-companion-server`
Expected: PASS all 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/types.ts packages/server/src/event-store.ts packages/server/test/event-store.test.ts
git commit -m "feat(server): add ring-buffer event store"
```

---

### Task 5: Screenshot LRU cache

**Files:**
- Create: `packages/server/src/screenshot-cache.ts`
- Create: `packages/server/test/screenshot-cache.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/server/test/screenshot-cache.test.ts
import { describe, expect, it } from 'vitest';
import { ScreenshotCache } from '../src/screenshot-cache';

describe('ScreenshotCache', () => {
  it('stores and retrieves by id', () => {
    const cache = new ScreenshotCache(10);
    cache.set('abc', Buffer.from('png-bytes'));
    expect(cache.get('abc')?.toString()).toBe('png-bytes');
  });

  it('evicts LRU when over capacity', () => {
    const cache = new ScreenshotCache(2);
    cache.set('a', Buffer.from('1'));
    cache.set('b', Buffer.from('2'));
    cache.set('c', Buffer.from('3'));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')?.toString()).toBe('2');
    expect(cache.get('c')?.toString()).toBe('3');
  });

  it('refreshes recency on get', () => {
    const cache = new ScreenshotCache(2);
    cache.set('a', Buffer.from('1'));
    cache.set('b', Buffer.from('2'));
    cache.get('a'); // mark 'a' as recent
    cache.set('c', Buffer.from('3'));
    expect(cache.get('a')?.toString()).toBe('1');
    expect(cache.get('b')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npm test -w @areti-gmbh/visual-companion-server`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
// packages/server/src/screenshot-cache.ts
export class ScreenshotCache {
  private map = new Map<string, Buffer>();
  constructor(private readonly maxSize: number) {}

  set(id: string, data: Buffer): void {
    if (this.map.has(id)) this.map.delete(id);
    this.map.set(id, data);
    if (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
  }

  get(id: string): Buffer | undefined {
    const val = this.map.get(id);
    if (val === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, val);
    return val;
  }

  size(): number {
    return this.map.size;
  }
}
```

- [ ] **Step 4: Run test — verify pass**

Run: `npm test -w @areti-gmbh/visual-companion-server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/screenshot-cache.ts packages/server/test/screenshot-cache.test.ts
git commit -m "feat(server): add LRU screenshot cache"
```

---

## Phase 3 — Reverse Proxy

### Task 6: Proxy core with header stripping

**Files:**
- Create: `packages/server/src/proxy.ts`
- Create: `packages/server/test/proxy.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/server/test/proxy.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import http from 'node:http';
import { registerProxy } from '../src/proxy';

function startUpstream(handler: http.RequestListener): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve({ port: address.port, server });
    });
  });
}

describe('proxy', () => {
  let app: FastifyInstance | null = null;
  let upstream: http.Server | null = null;
  afterEach(async () => {
    if (app) await app.close();
    if (upstream) upstream.close();
    app = null;
    upstream = null;
  });

  it('strips X-Frame-Options and CSP frame-ancestors, preserves other headers', async () => {
    const { port, server } = await startUpstream((_req, res) => {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; script-src 'self'");
      res.setHeader('X-Custom', 'keep-me');
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head></head><body>hi</body></html>');
    });
    upstream = server;
    app = Fastify();
    await registerProxy(app, { targetOrigin: `http://127.0.0.1:${port}` });
    await app.ready();
    const resp = await app.inject({ method: 'GET', url: '/app/' });
    expect(resp.headers['x-frame-options']).toBeUndefined();
    expect(resp.headers['content-security-policy']).toBe("script-src 'self'");
    expect(resp.headers['x-custom']).toBe('keep-me');
  });

  it('forwards non-HTML responses untouched', async () => {
    const { port, server } = await startUpstream((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
    upstream = server;
    app = Fastify();
    await registerProxy(app, { targetOrigin: `http://127.0.0.1:${port}` });
    await app.ready();
    const resp = await app.inject({ method: 'GET', url: '/app/api/data' });
    expect(resp.statusCode).toBe(200);
    expect(resp.payload).toBe('{"ok":true}');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npm test -w @areti-gmbh/visual-companion-server -- proxy`
Expected: FAIL

- [ ] **Step 3: Implement `proxy.ts`**

```ts
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { request as undiciRequest } from 'undici';

export interface ProxyOptions {
  targetOrigin: string; // e.g. "http://localhost:3000"
  injectScriptTag?: string; // will be inserted before </head>
}

const STRIPPED_RESPONSE_HEADERS = new Set(['x-frame-options', 'content-length']);

export async function registerProxy(app: FastifyInstance, opts: ProxyOptions): Promise<void> {
  const { targetOrigin } = opts;

  app.all('/app/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const upstreamUrl = new URL(
      (req.params as { '*': string })['*'] || '',
      targetOrigin + '/',
    );
    // preserve query
    for (const [k, v] of Object.entries(req.query as Record<string, string>)) {
      upstreamUrl.searchParams.set(k, v);
    }
    // forward request
    const forwardHeaders = { ...(req.headers as Record<string, string>) };
    delete forwardHeaders.host;
    delete forwardHeaders['content-length'];

    const upstreamResp = await undiciRequest(upstreamUrl.toString(), {
      method: req.method as any,
      headers: forwardHeaders,
      body: req.raw,
    });

    // copy headers except stripped
    for (const [key, value] of Object.entries(upstreamResp.headers)) {
      const lower = key.toLowerCase();
      if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
      if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
        const filtered = stripFrameAncestors(Array.isArray(value) ? value.join(', ') : String(value));
        if (filtered) reply.header(key, filtered);
        continue;
      }
      reply.header(key, value as string);
    }
    reply.status(upstreamResp.statusCode);

    const ctype = upstreamResp.headers['content-type'];
    const isHtml = typeof ctype === 'string' && ctype.includes('text/html');
    if (isHtml && opts.injectScriptTag) {
      const body = await upstreamResp.body.text();
      const injected = injectScript(body, opts.injectScriptTag);
      reply.send(injected);
    } else {
      reply.send(upstreamResp.body);
    }
  });
}

export function stripFrameAncestors(cspValue: string): string {
  return cspValue
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^frame-ancestors\b/i.test(part))
    .join('; ');
}

export function injectScript(html: string, scriptTag: string): string {
  const headClose = html.match(/<\/head\s*>/i);
  if (headClose) {
    return html.slice(0, headClose.index!) + scriptTag + html.slice(headClose.index!);
  }
  const bodyOpen = html.match(/<body\b[^>]*>/i);
  if (bodyOpen) {
    const insertAt = bodyOpen.index! + bodyOpen[0].length;
    return html.slice(0, insertAt) + scriptTag + html.slice(insertAt);
  }
  return scriptTag + html;
}
```

- [ ] **Step 4: Run test — verify pass**

Run: `npm test -w @areti-gmbh/visual-companion-server -- proxy`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/proxy.ts packages/server/test/proxy.test.ts
git commit -m "feat(server): add reverse proxy with CSP/XFO stripping"
```

---

### Task 7: Proxy script injection

**Files:**
- Modify: `packages/server/test/proxy.test.ts` (add injection tests)
- Modify: `packages/server/src/proxy.ts` (wire injectScriptTag through)

- [ ] **Step 1: Add failing test for injection**

Append to `proxy.test.ts`:

```ts
  it('injects companion script before </head>', async () => {
    const { port, server } = await startUpstream((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head><title>t</title></head><body></body></html>');
    });
    upstream = server;
    app = Fastify();
    await registerProxy(app, {
      targetOrigin: `http://127.0.0.1:${port}`,
      injectScriptTag: '<script src="/_companion/inject.js"></script>',
    });
    await app.ready();
    const resp = await app.inject({ method: 'GET', url: '/app/' });
    expect(resp.payload).toContain('<script src="/_companion/inject.js"></script></head>');
  });

  it('falls back to <body> when no </head>', async () => {
    const { port, server } = await startUpstream((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<body><div>hi</div></body>');
    });
    upstream = server;
    app = Fastify();
    await registerProxy(app, {
      targetOrigin: `http://127.0.0.1:${port}`,
      injectScriptTag: '<script>X</script>',
    });
    await app.ready();
    const resp = await app.inject({ method: 'GET', url: '/app/' });
    expect(resp.payload).toMatch(/<body><script>X<\/script><div>hi/);
  });
```

- [ ] **Step 2: Run test — inject tests already pass from Task 6**

Run: `npm test -w @areti-gmbh/visual-companion-server -- proxy`
Expected: PASS (the proxy.ts from Task 6 already implements this).

- [ ] **Step 3: Commit**

```bash
git add packages/server/test/proxy.test.ts
git commit -m "test(server): assert script injection fallbacks"
```

---

### Task 8: WebSocket transparent proxying

**Files:**
- Modify: `packages/server/src/proxy.ts` (add ws passthrough)
- Create: `packages/server/test/proxy-ws.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/server/test/proxy-ws.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { registerProxy } from '../src/proxy';
import { AddressInfo } from 'node:net';

describe('proxy WebSocket passthrough', () => {
  let app: FastifyInstance | null = null;
  let upstreamWss: WebSocketServer | null = null;
  afterEach(async () => {
    if (app) await app.close();
    if (upstreamWss) upstreamWss.close();
    app = null;
    upstreamWss = null;
  });

  it('forwards WebSocket messages both ways', async () => {
    upstreamWss = new WebSocketServer({ port: 0 });
    upstreamWss.on('connection', (ws) => {
      ws.on('message', (msg) => ws.send('echo:' + msg.toString()));
    });
    await new Promise<void>((res) => upstreamWss!.on('listening', res));
    const upstreamPort = (upstreamWss.address() as AddressInfo).port;

    app = Fastify();
    await registerProxy(app, { targetOrigin: `http://127.0.0.1:${upstreamPort}` });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const proxyPort = (app.server.address() as AddressInfo).port;

    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/app/ws`);
    const received = await new Promise<string>((resolve) => {
      client.on('open', () => client.send('hello'));
      client.on('message', (data) => resolve(data.toString()));
    });
    client.close();
    expect(received).toBe('echo:hello');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npm test -w @areti-gmbh/visual-companion-server -- proxy-ws`
Expected: FAIL

- [ ] **Step 3: Extend `proxy.ts` with WS upgrade handling**

Append to `packages/server/src/proxy.ts`:

```ts
import WebSocket from 'ws';
import { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';

export function attachWebSocketProxy(
  httpServer: { on: (evt: string, cb: (...args: any[]) => void) => void },
  targetOrigin: string,
): void {
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url?.startsWith('/app/')) return;
    const upstreamPath = req.url.slice('/app'.length);
    const upstreamWsUrl = targetOrigin.replace(/^http/, 'ws') + upstreamPath;
    const upstreamSocket = new WebSocket(upstreamWsUrl, {
      headers: { ...req.headers, host: new URL(targetOrigin).host },
    });
    upstreamSocket.on('open', () => {
      const rawUpstream = (upstreamSocket as any)._socket as Duplex;
      socket.pipe(rawUpstream);
      rawUpstream.pipe(socket);
    });
    upstreamSocket.on('error', () => socket.destroy());
  });
}
```

Also modify `registerProxy` to call `attachWebSocketProxy(app.server, targetOrigin)` at the end.

- [ ] **Step 4: Run test — verify pass**

Run: `npm test -w @areti-gmbh/visual-companion-server -- proxy-ws`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/proxy.ts packages/server/test/proxy-ws.test.ts
git commit -m "feat(server): transparent WebSocket proxying"
```

---

## Phase 4 — WebSocket Gateway & Event Ingest

### Task 9: Companion WebSocket endpoint

**Files:**
- Create: `packages/server/src/websocket.ts`
- Create: `packages/server/test/websocket.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/server/test/websocket.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { AddressInfo } from 'node:net';
import { registerCompanionWebSocket } from '../src/websocket';
import { EventStore } from '../src/event-store';

describe('companion websocket', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { if (app) await app.close(); app = null; });

  it('accepts connections and stores console events', async () => {
    app = Fastify();
    await app.register(fastifyWebsocket);
    const store = new EventStore({ maxEvents: 100, maxAgeMs: 300_000 });
    registerCompanionWebSocket(app, { store });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const client = new WebSocket(`ws://127.0.0.1:${port}/_companion/ws`);
    await new Promise<void>((r) => client.once('open', r));
    client.send(JSON.stringify({
      type: 'console',
      payload: { level: 'log', args: ['hello'] },
      url: 'http://test',
      timestamp: Date.now(),
    }));
    await new Promise((r) => setTimeout(r, 50));
    client.close();
    expect(store.size()).toBe(1);
  });

  it('broadcasts server-to-browser messages to connected clients', async () => {
    app = Fastify();
    await app.register(fastifyWebsocket);
    const store = new EventStore({ maxEvents: 100, maxAgeMs: 300_000 });
    const gateway = registerCompanionWebSocket(app, { store });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const client = new WebSocket(`ws://127.0.0.1:${port}/_companion/ws`);
    const received = new Promise<string>((resolve) => {
      client.on('message', (msg) => resolve(msg.toString()));
    });
    await new Promise<void>((r) => client.once('open', r));
    gateway.broadcast({ type: 'highlight', selector: '.foo', durationMs: 800 });
    expect(JSON.parse(await received)).toEqual({
      type: 'highlight', selector: '.foo', durationMs: 800,
    });
    client.close();
  });
});
```

- [ ] **Step 2: Run test — verify fail**

Run: `npm test -w @areti-gmbh/visual-companion-server -- websocket`
Expected: FAIL

- [ ] **Step 3: Implement `websocket.ts`**

```ts
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { EventStore } from './event-store';
import type { CompanionEvent } from './types';

export interface WebSocketOptions {
  store: EventStore;
}

export interface ServerMessage {
  type: 'highlight' | 'scroll_to' | 'navigate' | 'reload' | 'evaluate';
  [k: string]: unknown;
}

export interface WebSocketGateway {
  broadcast(msg: ServerMessage): void;
  connectionCount(): number;
}

export function registerCompanionWebSocket(
  app: FastifyInstance,
  opts: WebSocketOptions,
): WebSocketGateway {
  const clients = new Set<WebSocket>();

  app.get('/_companion/ws', { websocket: true } as any, (conn: any) => {
    const socket: WebSocket = conn.socket ?? conn;
    clients.add(socket);
    socket.on('message', (raw: Buffer) => {
      try {
        const incoming = JSON.parse(raw.toString());
        const event: CompanionEvent = {
          id: randomUUID(),
          timestamp: incoming.timestamp ?? Date.now(),
          type: incoming.type,
          url: incoming.url ?? '',
          payload: incoming.payload,
        };
        opts.store.append(event);
      } catch {
        // ignore malformed
      }
    });
    socket.on('close', () => clients.delete(socket));
  });

  return {
    broadcast(msg: ServerMessage) {
      const payload = JSON.stringify(msg);
      for (const c of clients) {
        if (c.readyState === WebSocket.OPEN) c.send(payload);
      }
    },
    connectionCount() { return clients.size; },
  };
}
```

- [ ] **Step 4: Run test — verify pass**

Run: `npm test -w @areti-gmbh/visual-companion-server -- websocket`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/websocket.ts packages/server/test/websocket.test.ts
git commit -m "feat(server): WebSocket gateway for events + broadcast"
```

---

### Task 10: Server bootstrap wiring proxy + WS + store

**Files:**
- Modify: `packages/server/src/index.ts`
- Create: `packages/server/src/config.ts`

- [ ] **Step 1: Implement `config.ts`**

```ts
export interface ServerConfig {
  port: number;              // where we listen (0 = auto)
  targetUrl: string;         // user's app upstream
  cwd: string;               // claude session cwd
  shellDir: string;          // absolute path to shell/dist
  injectFile: string;        // absolute path to inject/dist/inject.js
}

export function getConfigFromEnv(): ServerConfig {
  return {
    port: parseInt(process.env.VISUAL_COMPANION_PORT ?? '0', 10),
    targetUrl: process.env.VISUAL_COMPANION_TARGET_URL ?? 'http://localhost:3000',
    cwd: process.env.VISUAL_COMPANION_CWD ?? process.cwd(),
    shellDir: process.env.VISUAL_COMPANION_SHELL_DIR ?? '',
    injectFile: process.env.VISUAL_COMPANION_INJECT_FILE ?? '',
  };
}
```

- [ ] **Step 2: Replace `index.ts` with full bootstrap**

```ts
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getConfigFromEnv } from './config.js';
import { registerProxy } from './proxy.js';
import { registerCompanionWebSocket } from './websocket.js';
import { EventStore } from './event-store.js';
import { ScreenshotCache } from './screenshot-cache.js';

async function main(): Promise<void> {
  const cfg = getConfigFromEnv();
  const app = Fastify({ logger: { level: 'info' } });
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: cfg.shellDir,
    prefix: '/window/',
  });

  const store = new EventStore({ maxEvents: 5000, maxAgeMs: 5 * 60 * 1000 });
  const screenshots = new ScreenshotCache(100);
  const gateway = registerCompanionWebSocket(app, { store });

  app.get('/_companion/inject.js', async (_req, reply) => {
    reply.type('application/javascript');
    return readFileSync(cfg.injectFile);
  });

  const injectTag = `<script src="/_companion/inject.js" data-companion-port="${cfg.port}"></script>`;
  await registerProxy(app, { targetOrigin: cfg.targetUrl, injectScriptTag: injectTag });

  app.get('/', (_req, reply) => reply.redirect('/window/'));
  app.get('/_companion/health', async () => ({ ok: true, events: store.size() }));

  const address = await app.listen({ port: cfg.port, host: '127.0.0.1' });
  // STDOUT signal for launch.js — DO NOT CHANGE FORMAT
  console.log(`READY port=${new URL(address).port}`);

  process.on('SIGTERM', async () => { await app.close(); process.exit(0); });

  // silence unused vars
  void screenshots; void gateway;
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Add `@fastify/static` dependency**

```bash
npm install --workspace @areti-gmbh/visual-companion-server @fastify/static@^7.0.0
```

- [ ] **Step 4: Build and smoke-test**

Run:
```bash
npm run build -w @areti-gmbh/visual-companion-server
npm run build -w @areti-gmbh/visual-companion-inject
VISUAL_COMPANION_PORT=7777 \
  VISUAL_COMPANION_TARGET_URL=http://example.com \
  VISUAL_COMPANION_SHELL_DIR=$(pwd)/packages/shell/dist \
  VISUAL_COMPANION_INJECT_FILE=$(pwd)/packages/inject/dist/inject.js \
  node packages/server/dist/index.js &
SERVER_PID=$!
sleep 1
curl -s http://127.0.0.1:7777/_companion/health
kill $SERVER_PID
```
Expected: `{"ok":true,"events":0}` in output.

- [ ] **Step 5: Commit**

```bash
git add packages/server/
git commit -m "feat(server): bootstrap with proxy + ws + static shell"
```

---

## Phase 5 — Injected Script: Event Capture

### Task 11: Injected script bootstrap & WS connect

**Files:**
- Modify: `packages/inject/src/index.ts`
- Create: `packages/inject/src/dispatcher.ts`

- [ ] **Step 1: Implement `dispatcher.ts`**

```ts
export interface DispatcherOptions {
  port: number;
  onServerMessage: (msg: any) => void;
}

export class Dispatcher {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private reconnectMs = 1000;

  constructor(private opts: DispatcherOptions) {
    this.connect();
  }

  send(event: { type: string; payload: unknown; url: string; timestamp: number }): void {
    const msg = JSON.stringify(event);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      this.queue.push(msg);
    }
  }

  private connect(): void {
    const ws = new WebSocket(`ws://localhost:${this.opts.port}/_companion/ws`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectMs = 1000;
      for (const q of this.queue) ws.send(q);
      this.queue = [];
    });
    ws.addEventListener('message', (ev) => {
      try { this.opts.onServerMessage(JSON.parse(String(ev.data))); } catch {}
    });
    ws.addEventListener('close', () => {
      this.ws = null;
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);
    });
    ws.addEventListener('error', () => ws.close());
  }
}
```

- [ ] **Step 2: Replace `index.ts`**

```ts
import { Dispatcher } from './dispatcher';

const scriptTag = document.currentScript as HTMLScriptElement | null;
const port = parseInt(scriptTag?.dataset.companionPort ?? '7777', 10);

const dispatcher = new Dispatcher({
  port,
  onServerMessage: (msg) => {
    console.debug('[visual-companion] server msg:', msg);
  },
});

(window as any).__visualCompanion = { dispatcher };
```

- [ ] **Step 3: Build & verify**

Run: `npm run build -w @areti-gmbh/visual-companion-inject`
Expected: `dist/inject.js` exists, contains "Dispatcher" identifier (minified).

- [ ] **Step 4: Commit**

```bash
git add packages/inject/src/
git commit -m "feat(inject): bootstrap script + WS dispatcher with reconnect"
```

---

### Task 12: Console patches

**Files:**
- Create: `packages/inject/src/console-patch.ts`
- Modify: `packages/inject/src/index.ts`

- [ ] **Step 1: Implement `console-patch.ts`**

```ts
import type { Dispatcher } from './dispatcher';

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type Level = (typeof LEVELS)[number];

export function patchConsole(dispatcher: Dispatcher): void {
  for (const level of LEVELS) {
    const original = (console as any)[level].bind(console);
    (console as any)[level] = (...args: unknown[]) => {
      original(...args);
      try {
        dispatcher.send({
          type: 'console',
          timestamp: Date.now(),
          url: window.location.href,
          payload: { level, args: args.map(serializeArg) },
        });
      } catch {}
    };
  }
}

function serializeArg(arg: unknown): unknown {
  if (arg === null || arg === undefined) return arg;
  const t = typeof arg;
  if (t === 'string' || t === 'number' || t === 'boolean') return arg;
  if (arg instanceof Error) return { __type: 'Error', message: arg.message, stack: arg.stack };
  if (arg instanceof Node) {
    const el = arg as Element;
    return { __type: 'Node', tag: el.tagName?.toLowerCase(), id: el.id || null };
  }
  try {
    return JSON.parse(JSON.stringify(arg));
  } catch {
    return String(arg);
  }
}
```

- [ ] **Step 2: Wire into `index.ts`**

Add to `index.ts` after `const dispatcher = ...`:

```ts
import { patchConsole } from './console-patch';
patchConsole(dispatcher);
```

- [ ] **Step 3: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-inject`
Expected: builds cleanly.

- [ ] **Step 4: Commit**

```bash
git add packages/inject/src/console-patch.ts packages/inject/src/index.ts
git commit -m "feat(inject): patch console.* to emit events"
```

---

### Task 13: Network patches (fetch + XHR)

**Files:**
- Create: `packages/inject/src/network-patch.ts`
- Modify: `packages/inject/src/index.ts`

- [ ] **Step 1: Implement `network-patch.ts`**

```ts
import type { Dispatcher } from './dispatcher';

export function patchNetwork(dispatcher: Dispatcher): void {
  patchFetch(dispatcher);
  patchXHR(dispatcher);
}

function patchFetch(dispatcher: Dispatcher): void {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const start = performance.now();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    let response: Response;
    try {
      response = await origFetch(input as any, init);
    } catch (err) {
      dispatcher.send({
        type: 'network',
        timestamp: Date.now(),
        url: window.location.href,
        payload: { method, url, status: 0, durationMs: performance.now() - start, requestSize: 0, responseSize: 0 },
      });
      throw err;
    }
    const durationMs = performance.now() - start;
    dispatcher.send({
      type: 'network',
      timestamp: Date.now(),
      url: window.location.href,
      payload: {
        method, url,
        status: response.status,
        durationMs,
        requestSize: getBodyLen(init?.body),
        responseSize: parseInt(response.headers.get('content-length') ?? '0', 10),
      },
    });
    return response;
  };
}

function patchXHR(dispatcher: Dispatcher): void {
  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;
  OrigXHR.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any).__vc = { method, url: url.toString(), start: 0, size: 0 };
    return origOpen.call(this, method, url, ...(rest as [boolean?]));
  };
  OrigXHR.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const ctx = (this as any).__vc;
    if (ctx) {
      ctx.start = performance.now();
      ctx.size = getBodyLen(body);
      this.addEventListener('loadend', () => {
        dispatcher.send({
          type: 'network',
          timestamp: Date.now(),
          url: window.location.href,
          payload: {
            method: ctx.method, url: ctx.url,
            status: this.status,
            durationMs: performance.now() - ctx.start,
            requestSize: ctx.size,
            responseSize: parseInt(this.getResponseHeader('content-length') ?? '0', 10),
          },
        });
      });
    }
    return origSend.call(this, body as any);
  };
}

function getBodyLen(b: unknown): number {
  if (!b) return 0;
  if (typeof b === 'string') return b.length;
  if (b instanceof Blob) return b.size;
  if (b instanceof ArrayBuffer) return b.byteLength;
  return 0;
}
```

- [ ] **Step 2: Wire into `index.ts`**

Add `import { patchNetwork } from './network-patch'; patchNetwork(dispatcher);`

- [ ] **Step 3: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-inject`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add packages/inject/src/network-patch.ts packages/inject/src/index.ts
git commit -m "feat(inject): patch fetch + XHR to emit network events"
```

---

### Task 14: Error, mutation, navigation hooks

**Files:**
- Create: `packages/inject/src/error-handler.ts`
- Create: `packages/inject/src/mutation-observer.ts`
- Create: `packages/inject/src/navigation-hooks.ts`
- Modify: `packages/inject/src/index.ts`

- [ ] **Step 0: Also implement service worker unregister injection**

Create `packages/inject/src/sw-cleanup.ts`:

```ts
export function unregisterExistingServiceWorkers(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistrations()
    .then((regs) => regs.forEach((r) => r.unregister().catch(() => {})))
    .catch(() => {});
}
```

Wire in `packages/inject/src/index.ts`:

```ts
import { unregisterExistingServiceWorkers } from './sw-cleanup';
unregisterExistingServiceWorkers();
```

This prevents a stale SW from a previous session interfering with proxy-injection.

- [ ] **Step 1: Implement `error-handler.ts`**

```ts
import type { Dispatcher } from './dispatcher';

export function attachErrorHandlers(dispatcher: Dispatcher): void {
  window.addEventListener('error', (e) => {
    dispatcher.send({
      type: 'error',
      timestamp: Date.now(),
      url: window.location.href,
      payload: { message: e.message, stack: (e.error instanceof Error) ? e.error.stack ?? null : null },
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e.reason instanceof Error) ? e.reason : null;
    dispatcher.send({
      type: 'error',
      timestamp: Date.now(),
      url: window.location.href,
      payload: { message: reason?.message ?? String(e.reason), stack: reason?.stack ?? null },
    });
  });
}
```

- [ ] **Step 2: Implement `mutation-observer.ts`** (batched, 500ms window)

```ts
import type { Dispatcher } from './dispatcher';

export function attachMutationObserver(dispatcher: Dispatcher): void {
  let adds = 0, removes = 0, attributeChanges = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (!adds && !removes && !attributeChanges) return;
    dispatcher.send({
      type: 'mutation',
      timestamp: Date.now(),
      url: window.location.href,
      payload: { adds, removes, attributeChanges },
    });
    adds = removes = attributeChanges = 0;
  };

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') { adds += r.addedNodes.length; removes += r.removedNodes.length; }
      if (r.type === 'attributes') attributeChanges++;
    }
    if (!pending) {
      pending = setTimeout(() => { pending = null; flush(); }, 500);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
}
```

- [ ] **Step 3: Implement `navigation-hooks.ts`**

```ts
import type { Dispatcher } from './dispatcher';

export function attachNavigationHooks(dispatcher: Dispatcher): void {
  let previousHref = window.location.href;
  const emit = () => {
    const href = window.location.href;
    if (href === previousHref) return;
    const referrer = previousHref;
    previousHref = href;
    dispatcher.send({
      type: 'navigation',
      timestamp: Date.now(),
      url: href,
      payload: { newUrl: href, referrer },
    });
  };

  window.addEventListener('popstate', emit);

  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args: [any, string, (string | URL | null)?]) {
    const ret = origPush(...args);
    queueMicrotask(emit);
    return ret;
  };
  history.replaceState = function (...args: [any, string, (string | URL | null)?]) {
    const ret = origReplace(...args);
    queueMicrotask(emit);
    return ret;
  };
}
```

- [ ] **Step 4: Wire into `index.ts`**

```ts
import { attachErrorHandlers } from './error-handler';
import { attachMutationObserver } from './mutation-observer';
import { attachNavigationHooks } from './navigation-hooks';
attachErrorHandlers(dispatcher);
if (document.body) attachMutationObserver(dispatcher);
else document.addEventListener('DOMContentLoaded', () => attachMutationObserver(dispatcher));
attachNavigationHooks(dispatcher);
```

- [ ] **Step 5: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-inject`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add packages/inject/src/
git commit -m "feat(inject): error + mutation (batched) + navigation hooks"
```

---

## Phase 6 — Injected Script: Pointer Interaction

### Task 15: Unique CSS selector generator

**Files:**
- Create: `packages/inject/src/selector-gen.ts`
- Create: `packages/inject/test/selector-gen.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/inject/test/selector-gen.test.ts
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { uniqueSelector } from '../src/selector-gen';

function dom(html: string): Document {
  return new JSDOM(html).window.document;
}

describe('uniqueSelector', () => {
  it('returns #id when id is unique', () => {
    const d = dom('<div id="hero"></div>');
    expect(uniqueSelector(d.querySelector('#hero')!)).toBe('#hero');
  });

  it('returns tag + class path when no id', () => {
    const d = dom('<div class="a"><span class="b c">x</span></div>');
    const el = d.querySelector('span')!;
    const sel = uniqueSelector(el);
    expect(d.querySelectorAll(sel)).toHaveLength(1);
  });

  it('uses nth-of-type when siblings share selector', () => {
    const d = dom('<ul><li class="x"></li><li class="x"></li><li class="x"></li></ul>');
    const el = d.querySelectorAll('li')[1];
    const sel = uniqueSelector(el);
    expect(d.querySelectorAll(sel)).toHaveLength(1);
  });

  it('ignores auto-generated framework classes (css modules, emotion)', () => {
    const d = dom('<button class="Button_button__xK3pQ button-primary">x</button>');
    const sel = uniqueSelector(d.querySelector('button')!);
    expect(sel).not.toContain('Button_button__xK3pQ');
    expect(sel).toContain('button-primary');
  });
});
```

- [ ] **Step 2: Add `jsdom` to inject devDeps**

```bash
npm install --workspace @areti-gmbh/visual-companion-inject -D jsdom @types/jsdom
```

Add vitest config to inject package:
```ts
// packages/inject/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom' } });
```

- [ ] **Step 3: Run test — fail**

Run: `npm test -w @areti-gmbh/visual-companion-inject`
Expected: FAIL (module not found)

- [ ] **Step 4: Implement `selector-gen.ts`**

```ts
const AUTO_CLASS_RE = /^[A-Z][A-Za-z]+_[a-zA-Z]+__[A-Za-z0-9]{5,}$/; // CSS Modules pattern
const EMOTION_RE = /^css-[a-z0-9]{6,}$/;                             // emotion
const STYLED_RE = /^sc-[a-zA-Z0-9]{5,}$/;                            // styled-components

function isAutoGenerated(cls: string): boolean {
  return AUTO_CLASS_RE.test(cls) || EMOTION_RE.test(cls) || STYLED_RE.test(cls);
}

export function uniqueSelector(el: Element): string {
  if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
    return `#${CSS.escape(el.id)}`;
  }
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    parts.unshift(localSelector(current));
    const combined = parts.join(' > ');
    if (document.querySelectorAll(combined).length === 1) return combined;
    current = current.parentElement;
  }
  return parts.join(' > ');
}

function localSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).filter((c) => !isAutoGenerated(c));
  let base = tag + classes.map((c) => '.' + CSS.escape(c)).join('');
  if (el.parentElement) {
    const siblings = Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName);
    if (siblings.length > 1) {
      const idx = siblings.indexOf(el) + 1;
      base += `:nth-of-type(${idx})`;
    }
  }
  return base;
}
```

Note: `CSS.escape` is jsdom-compatible since v16. Fallback if needed: polyfill manually.

- [ ] **Step 5: Run test — pass**

Run: `npm test -w @areti-gmbh/visual-companion-inject`
Expected: PASS 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/inject/src/selector-gen.ts packages/inject/test/selector-gen.test.ts packages/inject/vitest.config.ts packages/inject/package.json
git commit -m "feat(inject): unique CSS selector generator"
```

---

### Task 16: Computed styles filter

**Files:**
- Create: `packages/inject/src/style-filter.ts`
- Create: `packages/inject/test/style-filter.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/inject/test/style-filter.test.ts
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { filterComputedStyles } from '../src/style-filter';

describe('filterComputedStyles', () => {
  it('groups styles into layout/typography/colors/spacing', () => {
    const dom = new JSDOM('<div style="display:flex;width:100px;font-size:14px;color:red;padding:4px"></div>');
    const el = dom.window.document.querySelector('div')!;
    const styles = dom.window.getComputedStyle(el);
    const filtered = filterComputedStyles(styles);
    expect(filtered.layout.display).toBe('flex');
    expect(filtered.typography['font-size']).toBe('14px');
    expect(filtered.colors.color).toBeDefined();
    expect(filtered.spacing.padding).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

```ts
// packages/inject/src/style-filter.ts
const LAYOUT_PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height',
  'min-width', 'min-height', 'max-width', 'max-height', 'overflow',
  'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self',
  'gap', 'grid-template-columns', 'grid-template-rows', 'grid-area',
  'z-index',
];
const TYPOGRAPHY_PROPS = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'text-align', 'text-decoration', 'text-transform', 'white-space',
];
const COLOR_PROPS = ['color', 'background-color', 'background', 'border-color', 'opacity'];
const SPACING_PROPS = [
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-width', 'border-radius',
];

export function filterComputedStyles(styles: CSSStyleDeclaration): {
  layout: Record<string, string>;
  typography: Record<string, string>;
  colors: Record<string, string>;
  spacing: Record<string, string>;
} {
  return {
    layout: pick(styles, LAYOUT_PROPS),
    typography: pick(styles, TYPOGRAPHY_PROPS),
    colors: pick(styles, COLOR_PROPS),
    spacing: pick(styles, SPACING_PROPS),
  };
}

function pick(styles: CSSStyleDeclaration, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = styles.getPropertyValue(k);
    if (v && v !== '' && v !== 'normal' && v !== 'auto' && v !== '0px') out[k] = v;
  }
  return out;
}
```

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Commit**

```bash
git add packages/inject/src/style-filter.ts packages/inject/test/style-filter.test.ts
git commit -m "feat(inject): computed styles filter"
```

---

### Task 17: Shadow-DOM overlay system

**Files:**
- Create: `packages/inject/src/overlay.ts`

- [ ] **Step 1: Implement overlay**

```ts
export interface Overlay {
  showHover(el: Element, selector: string): void;
  hideHover(): void;
  pulseHighlight(selector: string, durationMs: number): void;
  showRegionBox(startX: number, startY: number, endX: number, endY: number): void;
  hideRegionBox(): void;
}

export function createOverlay(): Overlay {
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .hover { position:fixed; outline:2px solid #f59e0b; background:rgba(245,158,11,0.08); pointer-events:none; transition:all 0.08s }
      .hover .label { position:absolute; top:-18px; left:0; background:#f59e0b; color:#fff; font:600 10px/1.2 -apple-system,system-ui; padding:2px 6px; border-radius:3px; white-space:nowrap }
      .pulse { position:fixed; outline:3px solid #f59e0b; box-shadow:0 0 0 6px rgba(245,158,11,0.3); pointer-events:none; animation: pulse 0.26s ease-in-out 3 }
      @keyframes pulse { 0%,100% { box-shadow: 0 0 0 6px rgba(245,158,11,0.3) } 50% { box-shadow: 0 0 0 14px rgba(245,158,11,0.05) } }
      .region { position:fixed; border:2px dashed #3b82f6; background:rgba(59,130,246,0.08); pointer-events:none }
    </style>
    <div class="hover" style="display:none"><span class="label"></span></div>
    <div class="pulse" style="display:none"></div>
    <div class="region" style="display:none"></div>
  `;
  const hover = shadow.querySelector('.hover') as HTMLElement;
  const hoverLabel = shadow.querySelector('.hover .label') as HTMLElement;
  const pulse = shadow.querySelector('.pulse') as HTMLElement;
  const region = shadow.querySelector('.region') as HTMLElement;

  return {
    showHover(el, selector) {
      const r = el.getBoundingClientRect();
      Object.assign(hover.style, {
        display: 'block', top: r.top + 'px', left: r.left + 'px',
        width: r.width + 'px', height: r.height + 'px',
      });
      hoverLabel.textContent = selector;
    },
    hideHover() { hover.style.display = 'none'; },
    pulseHighlight(selector, durationMs) {
      const el = document.querySelector(selector);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const r = el.getBoundingClientRect();
      Object.assign(pulse.style, {
        display: 'block', top: r.top + 'px', left: r.left + 'px',
        width: r.width + 'px', height: r.height + 'px',
      });
      setTimeout(() => { pulse.style.display = 'none'; }, durationMs);
    },
    showRegionBox(sx, sy, ex, ey) {
      const x = Math.min(sx, ex), y = Math.min(sy, ey);
      const w = Math.abs(ex - sx), h = Math.abs(ey - sy);
      Object.assign(region.style, { display: 'block', top: y + 'px', left: x + 'px', width: w + 'px', height: h + 'px' });
    },
    hideRegionBox() { region.style.display = 'none'; },
  };
}
```

- [ ] **Step 2: Build — verify no errors**

Run: `npm run build -w @areti-gmbh/visual-companion-inject`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add packages/inject/src/overlay.ts
git commit -m "feat(inject): shadow-DOM overlay for hover/pulse/region"
```

---

### Task 18: Screenshot capture via html2canvas

**Files:**
- Create: `packages/inject/src/screenshot.ts`

- [ ] **Step 1: Implement screenshot**

```ts
import html2canvas from 'html2canvas';

export async function captureElementScreenshot(el: Element, paddingPx = 20): Promise<string | null> {
  try {
    const r = el.getBoundingClientRect();
    const canvas = await html2canvas(document.body, {
      x: Math.max(0, r.left - paddingPx),
      y: Math.max(0, r.top - paddingPx),
      width: r.width + paddingPx * 2,
      height: r.height + paddingPx * 2,
      backgroundColor: null,
      logging: false,
      scale: Math.min(window.devicePixelRatio, 2),
      useCORS: true,
    });
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.debug('[visual-companion] screenshot failed:', err);
    return null;
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-inject`
Expected: bundle includes html2canvas (note: ~180KB gzipped — acceptable).

- [ ] **Step 3: Commit**

```bash
git add packages/inject/src/screenshot.ts
git commit -m "feat(inject): element screenshot via html2canvas"
```

---

### Task 19: Source-map lookup

**Files:**
- Create: `packages/inject/src/source-map.ts`

- [ ] **Step 1: Implement source-map lookup (best-effort for Vite/Webpack dev)**

```ts
export async function lookupSourceLocation(el: Element): Promise<{ file: string; line: number; column: number } | null> {
  // 1. React DevTools fiber hook
  const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
  if (fiberKey) {
    const fiber = (el as any)[fiberKey];
    const source = fiber?._debugSource;
    if (source?.fileName) {
      return { file: source.fileName, line: source.lineNumber, column: source.columnNumber ?? 0 };
    }
  }
  // 2. Vue devtools hook
  const vueInst = (el as any).__vue__ || (el as any).__vueParentComponent;
  const vueFile = vueInst?.$options?.__file || vueInst?.type?.__file;
  if (vueFile) return { file: vueFile, line: 0, column: 0 };

  // 3. data-source attribute (some dev plugins add this)
  const ds = el.getAttribute('data-source');
  if (ds) {
    const m = ds.match(/^(.+):(\d+)(?::(\d+))?$/);
    if (m) return { file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3] ?? '0', 10) };
  }
  return null;
}
```

- [ ] **Step 2: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-inject`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add packages/inject/src/source-map.ts
git commit -m "feat(inject): source-map lookup (React fiber + Vue + data-source)"
```

---

### Task 20: Pointer interaction (Alt+Click, Multi-Select, Region)

**Files:**
- Create: `packages/inject/src/pointer.ts`
- Modify: `packages/inject/src/index.ts`

- [ ] **Step 1: Implement `pointer.ts`**

```ts
import type { Dispatcher } from './dispatcher';
import { createOverlay } from './overlay';
import { uniqueSelector } from './selector-gen';
import { filterComputedStyles } from './style-filter';
import { captureElementScreenshot } from './screenshot';
import { lookupSourceLocation } from './source-map';

export function installPointer(dispatcher: Dispatcher): void {
  const overlay = createOverlay();
  let altDown = false;
  let regionStart: { x: number; y: number } | null = null;

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && !altDown) {
      altDown = true;
      document.body.style.cursor = 'crosshair';
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      altDown = false;
      document.body.style.cursor = '';
      overlay.hideHover();
      overlay.hideRegionBox();
      regionStart = null;
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!altDown) return;
    if (regionStart) {
      overlay.showRegionBox(regionStart.x, regionStart.y, e.clientX, e.clientY);
      return;
    }
    const target = e.target as Element | null;
    if (target && target.nodeType === 1) {
      const sel = uniqueSelector(target);
      overlay.showHover(target, sel);
    }
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (!altDown || e.button !== 0) return;
    if (e.shiftKey) return; // let click handler deal with multi-select
    regionStart = { x: e.clientX, y: e.clientY };
  }, true);

  document.addEventListener('mouseup', async (e) => {
    if (!altDown) { regionStart = null; return; }
    if (regionStart) {
      const dx = Math.abs(e.clientX - regionStart.x);
      const dy = Math.abs(e.clientY - regionStart.y);
      if (dx > 5 || dy > 5) {
        // true drag → region event
        await emitRegion(dispatcher, regionStart, { x: e.clientX, y: e.clientY });
        regionStart = null;
        overlay.hideRegionBox();
        e.preventDefault(); e.stopPropagation();
        return;
      }
    }
    regionStart = null;
  }, true);

  document.addEventListener('click', async (e) => {
    if (!altDown) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target as Element;
    await emitPointer(dispatcher, el);
  }, true);
}

async function emitPointer(dispatcher: Dispatcher, el: Element): Promise<void> {
  const r = el.getBoundingClientRect();
  const styles = filterComputedStyles(window.getComputedStyle(el));
  const [screenshot, sourceLocation] = await Promise.all([
    captureElementScreenshot(el, 20),
    lookupSourceLocation(el),
  ]);
  const ancestors: Array<any> = [];
  let cur = el.parentElement;
  while (cur && cur !== document.body.parentElement) {
    ancestors.push({
      tagName: cur.tagName.toLowerCase(),
      id: cur.id || null,
      classes: Array.from(cur.classList),
      cssSelector: uniqueSelector(cur),
    });
    cur = cur.parentElement;
  }
  const dataAttributes: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-')) dataAttributes[attr.name] = attr.value;
  }
  dispatcher.send({
    type: 'pointer',
    timestamp: Date.now(),
    url: window.location.href,
    payload: {
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList),
      dataAttributes,
      outerHTML: (el.outerHTML || '').slice(0, 5000),
      cssSelector: uniqueSelector(el),
      boundingBox: { x: r.left, y: r.top, width: r.width, height: r.height },
      textContent: (el.textContent || '').slice(0, 500),
      computedStyles: styles,
      screenshotDataUrl: screenshot,
      sourceLocation,
      ancestors,
    },
  });
}

async function emitRegion(
  dispatcher: Dispatcher,
  start: { x: number; y: number },
  end: { x: number; y: number }
): Promise<void> {
  const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
  const enclosed: Element[] = [];
  document.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.left >= x && r.top >= y && r.right <= x + w && r.bottom <= y + h) enclosed.push(el);
  });
  // emit as a "region" pointer event (use first enclosed element as anchor)
  const anchor = enclosed[0];
  if (!anchor) return;
  await emitPointer(dispatcher, anchor);
}
```

- [ ] **Step 2: Wire into `index.ts`**

Add `import { installPointer } from './pointer'; installPointer(dispatcher);`

Also wire the server-message handler to route `highlight` and `scroll_to`:

```ts
import { createOverlay } from './overlay';
const overlay = createOverlay();
const dispatcher = new Dispatcher({
  port,
  onServerMessage: (msg) => {
    if (msg.type === 'highlight') overlay.pulseHighlight(msg.selector, msg.durationMs ?? 800);
    if (msg.type === 'scroll_to') document.querySelector(msg.selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (msg.type === 'navigate') window.location.href = msg.url;
    if (msg.type === 'reload') window.location.reload();
  },
});
```

(Note: remove duplicate overlay creation inside `installPointer` — pass overlay as parameter. Adjust accordingly.)

- [ ] **Step 3: Refactor — single overlay instance**

Change `installPointer(dispatcher: Dispatcher)` → `installPointer(dispatcher: Dispatcher, overlay: Overlay)` and remove `createOverlay()` call inside.

- [ ] **Step 4: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-inject`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add packages/inject/src/pointer.ts packages/inject/src/index.ts
git commit -m "feat(inject): pointer capture with Alt modifier + region drag"
```

---

## Phase 7 — PTY Bridge

### Task 21: node-pty spawn with WebSocket pipe

**Files:**
- Create: `packages/server/src/pty-bridge.ts`

- [ ] **Step 1: Implement**

```ts
import { FastifyInstance } from 'fastify';
import { spawn, IPty } from 'node-pty';
import WebSocket from 'ws';

export interface PtyBridgeOptions {
  cwd: string;
  companionPort: number;
  shell?: string;
  claudeArgs?: string[];
}

export function registerPtyBridge(app: FastifyInstance, opts: PtyBridgeOptions): void {
  app.get('/_companion/pty', { websocket: true } as any, (conn: any) => {
    const socket: WebSocket = conn.socket ?? conn;
    const pty: IPty = spawn(opts.shell ?? process.env.SHELL ?? '/bin/zsh', ['-lc', ['claude', ...(opts.claudeArgs ?? [])].join(' ')], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: opts.cwd,
      env: { ...process.env, VISUAL_COMPANION_PORT: String(opts.companionPort) },
    });

    pty.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'data', data }));
    });
    pty.onExit(({ exitCode }) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'exit', exitCode }));
      }
    });

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'data') pty.write(msg.data);
        if (msg.type === 'resize') pty.resize(msg.cols, msg.rows);
      } catch {}
    });
    socket.on('close', () => pty.kill());
  });
}
```

- [ ] **Step 2: Wire into `index.ts`**

Add in `main()` after gateway:
```ts
import { registerPtyBridge } from './pty-bridge.js';
const serverPort = parseInt(new URL(address).port, 10);
registerPtyBridge(app, { cwd: cfg.cwd, companionPort: serverPort });
```

(Note: wire after `app.listen` so `serverPort` is known. Call `registerPtyBridge` before `app.listen` and pass `cfg.port`, since at that point we know what we want to listen on.)

Actually, since `cfg.port` may be `0` (auto), resolve the actual listen port after `app.listen`. Put `registerPtyBridge` call AFTER `app.listen` and use the resolved port.

- [ ] **Step 3: Build server**

Run: `npm run build -w @areti-gmbh/visual-companion-server`
Expected: `dist/pty-bridge.js` exists, TypeScript compiles without errors.

- [ ] **Step 4: Manual smoke test**

```bash
node packages/server/dist/index.js &
# connect a ws client to /_companion/pty, send {"type":"data","data":"ls\n"}, expect output
```

(Skippable if tight on time; gets covered by e2e tests later.)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/pty-bridge.ts packages/server/src/index.ts
git commit -m "feat(server): PTY bridge spawning claude with env var"
```

---

## Phase 8 — Companion Shell (Window UI)

### Task 22: Shell HTML + split layout

**Files:**
- Modify: `packages/shell/src/window.html`
- Modify: `packages/shell/src/styles.css`
- Modify: `packages/shell/src/window.ts`

- [ ] **Step 1: Replace `window.html`**

```html
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Visual Companion</title>
  <link rel="stylesheet" href="./window.css">
  <link rel="stylesheet" href="./xterm.css">
</head>
<body>
  <header class="titlebar">
    <div class="traffic-lights"></div>
    <div class="title">Visual Companion</div>
    <div class="url-input-wrap"><input id="url-input" type="text" spellcheck="false"></div>
    <div class="actions">
      <button id="btn-reload" title="Reload (⌘R)">↻</button>
      <button id="btn-devtools" title="DevTools (⌘⌥I)">&lt;/&gt;</button>
      <button id="btn-settings" title="Settings">⚙</button>
    </div>
  </header>

  <main class="main">
    <section class="pane pane-left">
      <iframe id="app-frame" src="/app/" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
      <div class="pill hint">⌥ halten zum Zeigen</div>
      <div class="pill status" id="proxy-status">● Proxy verbunden</div>
    </section>
    <div class="divider" id="divider"></div>
    <section class="pane pane-right">
      <div id="terminal"></div>
    </section>
  </main>

  <footer class="statusbar">
    <span id="st-proxy">Proxy: — → —</span>
    <span id="st-events">Events: 0</span>
    <span id="st-mcp">MCP: —</span>
  </footer>

  <script type="module" src="./window.js"></script>
</body>
</html>
```

- [ ] **Step 2: Replace `styles.css`**

```css
:root {
  --bg: #0f172a;
  --bg-light: #1e293b;
  --fg: #e2e8f0;
  --fg-dim: #94a3b8;
  --accent: #f59e0b;
  --ok: #10b981;
  --divider: #334155;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100vh; overflow: hidden; font: 13px/1.4 -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--fg); }
.titlebar { display: flex; align-items: center; gap: 12px; padding: 6px 14px; background: #2a2a2a; border-bottom: 1px solid #444; -webkit-app-region: drag; }
.traffic-lights { width: 56px; }
.title { font-size: 11px; font-weight: 500; color: #ccc; }
.url-input-wrap { flex: 1; display: flex; justify-content: center; -webkit-app-region: no-drag; }
#url-input { width: 60%; background: #1a1a1a; color: #aaa; font: 11px monospace; padding: 4px 12px; border-radius: 4px; border: 1px solid #333; }
.actions { display: flex; gap: 6px; -webkit-app-region: no-drag; }
.actions button { background: #1a1a1a; color: #aaa; border: 1px solid #333; border-radius: 3px; padding: 3px 8px; font-size: 12px; cursor: pointer; }
.actions button:hover { background: #333; color: #fff; }

.main { display: flex; height: calc(100vh - 28px - 20px); }
.pane { position: relative; }
.pane-left { flex: 1.4; background: #fff; overflow: hidden; }
.pane-right { flex: 1; background: var(--bg); padding: 8px; overflow: hidden; }
#app-frame { width: 100%; height: 100%; border: 0; background: #fff; }
#terminal { height: 100%; }
.divider { width: 6px; background: var(--divider); cursor: col-resize; }

.pill { position: absolute; bottom: 12px; padding: 5px 10px; border-radius: 12px; font-size: 10px; font-family: monospace; }
.pill.hint { left: 12px; background: rgba(0,0,0,0.8); color: #fff; }
.pill.status { right: 12px; background: rgba(16,185,129,0.95); color: #fff; }

.statusbar { display: flex; justify-content: space-between; padding: 3px 14px; background: #1a1a1a; color: #888; font: 9px monospace; border-top: 1px solid #444; }
```

- [ ] **Step 3: Replace `window.ts` with layout + divider logic**

```ts
import { initTerminal } from './terminal';
import { initIframe } from './iframe';

const iframe = document.getElementById('app-frame') as HTMLIFrameElement;
const urlInput = document.getElementById('url-input') as HTMLInputElement;
const reloadBtn = document.getElementById('btn-reload')!;
const devtoolsBtn = document.getElementById('btn-devtools')!;
const divider = document.getElementById('divider')!;
const main = document.querySelector('.main') as HTMLElement;
const leftPane = document.querySelector('.pane-left') as HTMLElement;

const config = new URLSearchParams(window.location.search);
const targetUrl = config.get('target') ?? '/app/';

initIframe({ iframe, urlInput, reloadBtn, devtoolsBtn, targetUrl });
initTerminal({ container: document.getElementById('terminal')! });

// Draggable divider
let dragging = false;
divider.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
document.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const rect = main.getBoundingClientRect();
  const leftPercent = ((e.clientX - rect.left) / rect.width) * 100;
  const clamped = Math.max(25, Math.min(75, leftPercent));
  leftPane.style.flex = `${clamped} 0 0`;
  const rightPane = document.querySelector('.pane-right') as HTMLElement;
  rightPane.style.flex = `${100 - clamped} 0 0`;
});
```

- [ ] **Step 4: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-shell`
Expected: build fails because `terminal.ts` and `iframe.ts` don't exist yet. This is expected — next tasks create them.

- [ ] **Step 5: Commit the layout files**

```bash
git add packages/shell/src/window.html packages/shell/src/styles.css packages/shell/src/window.ts
git commit -m "feat(shell): HTML layout + splittable panes + draggable divider"
```

---

### Task 23: xterm.js terminal integration

**Files:**
- Create: `packages/shell/src/terminal.ts`

- [ ] **Step 1: Implement**

```ts
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

export function initTerminal(opts: { container: HTMLElement }): void {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'SF Mono, Menlo, Consolas, monospace',
    fontSize: 13,
    scrollback: 10_000,
    theme: {
      background: '#0f172a',
      foreground: '#e2e8f0',
      cursor: '#fbbf24',
      selectionBackground: '#334155',
    },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(opts.container);
  fitAddon.fit();

  const ws = new WebSocket(`ws://${window.location.host}/_companion/pty`);
  ws.addEventListener('open', () => {
    term.write('\x1b[90mConnecting to claude...\x1b[0m\r\n');
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  });
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === 'data') term.write(msg.data);
      if (msg.type === 'exit') term.write(`\r\n\x1b[90mSession ended (code ${msg.exitCode}). Press Enter to restart.\x1b[0m\r\n`);
    } catch {}
  });
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
  });
  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
  window.addEventListener('resize', () => fitAddon.fit());
}
```

- [ ] **Step 2: Ensure xterm CSS is copied to dist**

Update `packages/shell/esbuild.config.mjs`:

```js
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

await mkdir('./dist', { recursive: true });
await build({
  entryPoints: ['./src/window.ts'],
  bundle: true,
  outfile: './dist/window.js',
  format: 'esm',
  target: ['chrome120'],
  sourcemap: 'inline',
  loader: { '.css': 'empty' }, // we copy xterm.css manually
  logLevel: 'info',
});
await copyFile('./src/window.html', './dist/window.html');
await copyFile('./src/styles.css', './dist/window.css');
await copyFile(require.resolve('xterm/css/xterm.css'), './dist/xterm.css');
console.log('shell: build complete');
```

- [ ] **Step 3: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-shell`
Expected: builds; still fails because `iframe.ts` doesn't exist yet — create stub.

Create `packages/shell/src/iframe.ts`:
```ts
export function initIframe(_opts: any): void { /* implemented in next task */ }
```

Re-run: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/shell/src/terminal.ts packages/shell/src/iframe.ts packages/shell/esbuild.config.mjs
git commit -m "feat(shell): xterm.js terminal wired to PTY WebSocket"
```

---

### Task 24: iframe + titlebar controls

**Files:**
- Modify: `packages/shell/src/iframe.ts`

- [ ] **Step 1: Implement**

```ts
export interface IframeOptions {
  iframe: HTMLIFrameElement;
  urlInput: HTMLInputElement;
  reloadBtn: HTMLElement;
  devtoolsBtn: HTMLElement;
  targetUrl: string;
}

export function initIframe(opts: IframeOptions): void {
  const { iframe, urlInput, reloadBtn, devtoolsBtn, targetUrl } = opts;

  urlInput.value = decodeURIComponent(new URLSearchParams(window.location.search).get('target') ?? 'http://localhost:3000');
  iframe.src = targetUrl;

  reloadBtn.addEventListener('click', () => reload(iframe));
  devtoolsBtn.addEventListener('click', () => {
    alert('Right-click the iframe area → Inspect Element for DevTools.');
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const url = urlInput.value.trim();
      // In app mode we only support same-origin-proxy navigation, but allow full URLs with a warning
      if (url.startsWith('/')) iframe.src = url;
      else iframe.src = '/app/';
    }
  });

  // Global keybindings
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
      e.preventDefault();
      reload(iframe, e.shiftKey);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
      e.preventDefault();
      urlInput.focus();
      urlInput.select();
    }
  });
}

function reload(iframe: HTMLIFrameElement, hard = false): void {
  if (hard) {
    iframe.src = iframe.src + (iframe.src.includes('?') ? '&' : '?') + '__vc_nocache=' + Date.now();
  } else {
    iframe.src = iframe.src;
  }
}
```

- [ ] **Step 2: Build & smoke-test**

```bash
npm run build -w @areti-gmbh/visual-companion-shell
# then start server and open http://localhost:7777/window/ in Chrome (regular mode for testing)
```

- [ ] **Step 3: Commit**

```bash
git add packages/shell/src/iframe.ts
git commit -m "feat(shell): iframe lifecycle + titlebar controls + keybindings"
```

---

## Phase 9 — MCP Server

### Task 25: MCP stdio server skeleton

**Files:**
- Create: `packages/server/src/mcp-entry.ts`
- Create: `packages/server/src/mcp-tools.ts`

- [ ] **Step 1: Implement `mcp-tools.ts` — HTTP client**

```ts
import { request } from 'undici';

export class DaemonClient {
  constructor(private readonly port: number) {}

  async call(endpoint: string, body: any): Promise<any> {
    const resp = await request(`http://localhost:${this.port}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (resp.statusCode >= 400) {
      const text = await resp.body.text();
      throw new Error(`Daemon error ${resp.statusCode}: ${text}`);
    }
    return await resp.body.json();
  }

  async ping(): Promise<boolean> {
    try {
      const resp = await request(`http://localhost:${this.port}/_companion/health`, { method: 'GET' });
      return resp.statusCode === 200;
    } catch { return false; }
  }
}
```

- [ ] **Step 2: Implement `mcp-entry.ts`**

```ts
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient } from './mcp-tools.js';

const port = parseInt(process.env.VISUAL_COMPANION_PORT ?? '0', 10);
const client = port > 0 ? new DaemonClient(port) : null;

const TOOLS = [
  { name: 'get_pointed_element', description: 'Get the most recently pointed element + full context', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_pointed_history', description: 'Get last N pointer events', inputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } },
  { name: 'get_console_logs', description: 'Get console logs', inputSchema: { type: 'object', properties: { since_ms: { type: 'number' }, level: { type: 'string' } } } },
  { name: 'get_network_requests', description: 'Get network requests', inputSchema: { type: 'object', properties: { since_ms: { type: 'number' }, filter: { type: 'object' } } } },
  { name: 'get_dom_snapshot', description: 'Get DOM snapshot', inputSchema: { type: 'object', properties: { selector: { type: 'string' } } } },
  { name: 'get_computed_styles', description: 'Get computed styles for selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  { name: 'get_source_location', description: 'Get source-map location for selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  { name: 'take_screenshot', description: 'Capture screenshot', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, full_page: { type: 'boolean' } } } },
  { name: 'get_recent_events', description: 'Get merged event stream', inputSchema: { type: 'object', properties: { since_ms: { type: 'number' }, types: { type: 'array', items: { type: 'string' } } }, required: ['since_ms'] } },
  { name: 'get_page_info', description: 'Current URL, title, viewport, user_agent, localStorage keys', inputSchema: { type: 'object', properties: {} } },
  { name: 'highlight_element', description: 'Pulse-highlight an element in the browser', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, duration_ms: { type: 'number' } }, required: ['selector'] } },
  { name: 'scroll_to', description: 'Scroll element into view', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  { name: 'navigate_to', description: 'Navigate iframe to URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'reload', description: 'Reload iframe', inputSchema: { type: 'object', properties: {} } },
  { name: 'evaluate_in_page', description: 'Run JS in iframe (requires user confirmation in terminal)', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
];

const server = new Server({ name: 'visual-companion-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!client) {
    return { content: [{ type: 'text', text: 'No visual companion active. Run /visual-companion first.' }], isError: true };
  }
  try {
    const result = await client.call(`/_companion/mcp/${req.params.name}`, req.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 3: Add npm script in `packages/server/package.json`**

```json
"scripts": {
  "build": "tsc -p tsconfig.json",
  "test": "vitest run",
  "start": "node dist/index.js",
  "mcp": "node dist/mcp-entry.js"
}
```

- [ ] **Step 4: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-server`
Expected: compiles without errors.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/mcp-entry.ts packages/server/src/mcp-tools.ts packages/server/package.json
git commit -m "feat(server): MCP stdio entry with 15 tool declarations"
```

---

### Task 26: Daemon MCP HTTP endpoints (query tools)

**Files:**
- Create: `packages/server/src/mcp-handlers.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Implement `mcp-handlers.ts`**

```ts
import { FastifyInstance } from 'fastify';
import { EventStore } from './event-store.js';
import { WebSocketGateway } from './websocket.js';

export interface McpHandlersOptions {
  store: EventStore;
  gateway: WebSocketGateway;
}

export function registerMcpHandlers(app: FastifyInstance, opts: McpHandlersOptions): void {
  const { store, gateway } = opts;

  // --- QUERY TOOLS ---

  app.post('/_companion/mcp/get_pointed_element', async () => {
    const evt = store.getLatestPointer();
    return evt ? evt.payload : null;
  });

  app.post('/_companion/mcp/get_pointed_history', async (req) => {
    const { count = 10 } = req.body as { count?: number };
    const pointers = store.query({ types: ['pointer'] }).slice(-count);
    return pointers.map((e) => e.payload);
  });

  app.post('/_companion/mcp/get_console_logs', async (req) => {
    const { since_ms, level } = req.body as { since_ms?: number; level?: string };
    let logs = store.query({ types: ['console'], sinceMs: since_ms });
    if (level) logs = logs.filter((e) => (e.payload as any).level === level);
    return logs;
  });

  app.post('/_companion/mcp/get_network_requests', async (req) => {
    const { since_ms, filter } = req.body as { since_ms?: number; filter?: any };
    let reqs = store.query({ types: ['network'], sinceMs: since_ms });
    if (filter) {
      reqs = reqs.filter((e) => {
        const p = e.payload as any;
        if (filter.method && p.method !== filter.method) return false;
        if (filter.url_contains && !p.url.includes(filter.url_contains)) return false;
        if (filter.status_range) {
          const [lo, hi] = filter.status_range;
          if (p.status < lo || p.status > hi) return false;
        }
        return true;
      });
    }
    return reqs;
  });

  app.post('/_companion/mcp/get_recent_events', async (req) => {
    const { since_ms, types } = req.body as { since_ms: number; types?: string[] };
    return store.query({ sinceMs: since_ms, types: types as any });
  });

  app.post('/_companion/mcp/get_dom_snapshot', async (req) => {
    const { selector } = req.body as { selector?: string };
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      const timeout = setTimeout(() => resolve({ error: 'timeout' }), 3000);
      (gateway as any).once?.(`response:${reqId}`, (data: any) => { clearTimeout(timeout); resolve(data); });
      gateway.broadcast({ type: 'evaluate' as any, requestId: reqId, kind: 'dom_snapshot', selector });
    });
  });

  app.post('/_companion/mcp/get_computed_styles', async (req) => {
    const { selector } = req.body as { selector: string };
    return proxyToBrowser(gateway, { kind: 'computed_styles', selector });
  });

  app.post('/_companion/mcp/get_source_location', async (req) => {
    const { selector } = req.body as { selector: string };
    return proxyToBrowser(gateway, { kind: 'source_location', selector });
  });

  app.post('/_companion/mcp/take_screenshot', async (req) => {
    const body = req.body as { selector?: string; full_page?: boolean };
    return proxyToBrowser(gateway, { kind: 'screenshot', ...body });
  });

  app.post('/_companion/mcp/get_page_info', async () => {
    return proxyToBrowser(gateway, { kind: 'page_info' });
  });

  // --- ACTION TOOLS ---

  app.post('/_companion/mcp/highlight_element', async (req) => {
    const { selector, duration_ms = 800 } = req.body as { selector: string; duration_ms?: number };
    gateway.broadcast({ type: 'highlight', selector, durationMs: duration_ms });
    return { ok: true };
  });

  app.post('/_companion/mcp/scroll_to', async (req) => {
    const { selector } = req.body as { selector: string };
    gateway.broadcast({ type: 'scroll_to', selector });
    return { ok: true };
  });

  app.post('/_companion/mcp/navigate_to', async (req) => {
    const { url } = req.body as { url: string };
    gateway.broadcast({ type: 'navigate', url });
    return { ok: true };
  });

  app.post('/_companion/mcp/reload', async () => {
    gateway.broadcast({ type: 'reload' });
    return { ok: true };
  });

  app.post('/_companion/mcp/evaluate_in_page', async (req) => {
    const { expression } = req.body as { expression: string };
    // write prompt to PTY — user confirms in terminal by typing y or n
    // See Task 27 for the confirmation flow wiring
    return proxyToBrowser(gateway, { kind: 'evaluate', expression });
  });
}

async function proxyToBrowser(gateway: WebSocketGateway, payload: any, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    const timeout = setTimeout(() => resolve({ error: 'timeout' }), timeoutMs);
    (gateway as any).once?.(`response:${requestId}`, (data: any) => { clearTimeout(timeout); resolve(data); });
    gateway.broadcast({ type: 'evaluate' as any, requestId, ...payload });
  });
}
```

- [ ] **Step 2: Extend WebSocketGateway with `once`/`emit` for request-response**

Modify `packages/server/src/websocket.ts` — make the gateway an `EventEmitter`-compatible with `once`/`emit` for `response:<requestId>` events:

```ts
import { EventEmitter } from 'node:events';
// ...
export function registerCompanionWebSocket(app: FastifyInstance, opts: WebSocketOptions): WebSocketGateway {
  const clients = new Set<WebSocket>();
  const emitter = new EventEmitter();

  app.get('/_companion/ws', { websocket: true } as any, (conn: any) => {
    const socket: WebSocket = conn.socket ?? conn;
    clients.add(socket);
    socket.on('message', (raw: Buffer) => {
      try {
        const incoming = JSON.parse(raw.toString());
        if (incoming.type === 'response' && incoming.requestId) {
          emitter.emit(`response:${incoming.requestId}`, incoming.data);
          return;
        }
        const event: CompanionEvent = {
          id: randomUUID(),
          timestamp: incoming.timestamp ?? Date.now(),
          type: incoming.type,
          url: incoming.url ?? '',
          payload: incoming.payload,
        };
        opts.store.append(event);
      } catch {}
    });
    socket.on('close', () => clients.delete(socket));
  });

  const gw: WebSocketGateway & { once: EventEmitter['once']; emit: EventEmitter['emit'] } = {
    broadcast(msg: ServerMessage) { for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(msg)); },
    connectionCount() { return clients.size; },
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };
  return gw;
}
```

- [ ] **Step 3: Wire handlers into `index.ts`**

Add in `main()`:
```ts
import { registerMcpHandlers } from './mcp-handlers.js';
registerMcpHandlers(app, { store, gateway });
```

- [ ] **Step 4: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-server`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/mcp-handlers.ts packages/server/src/websocket.ts packages/server/src/index.ts
git commit -m "feat(server): MCP tool HTTP handlers + request-response over WS"
```

---

### Task 27: Inject-side evaluate handler

**Files:**
- Create: `packages/inject/src/evaluate.ts`
- Modify: `packages/inject/src/index.ts`

- [ ] **Step 1: Implement `evaluate.ts`**

```ts
import type { Dispatcher } from './dispatcher';
import { filterComputedStyles } from './style-filter';
import { captureElementScreenshot } from './screenshot';
import { lookupSourceLocation } from './source-map';

export function handleEvaluate(dispatcher: Dispatcher, msg: any): void {
  const { requestId, kind } = msg;
  Promise.resolve().then(async () => {
    let data: any;
    try {
      switch (kind) {
        case 'dom_snapshot': {
          const root = msg.selector ? document.querySelector(msg.selector) : document.documentElement;
          data = { html: (root?.outerHTML || '').slice(0, 50_000) };
          break;
        }
        case 'computed_styles': {
          const el = document.querySelector(msg.selector);
          data = el ? filterComputedStyles(window.getComputedStyle(el)) : { error: 'not found' };
          break;
        }
        case 'source_location': {
          const el = document.querySelector(msg.selector);
          data = el ? await lookupSourceLocation(el) : null;
          break;
        }
        case 'screenshot': {
          const el = msg.selector ? document.querySelector(msg.selector) : document.body;
          data = el ? { png: await captureElementScreenshot(el) } : { error: 'not found' };
          break;
        }
        case 'page_info': {
          data = {
            url: window.location.href, title: document.title,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            userAgent: navigator.userAgent,
            localStorageKeys: Object.keys(localStorage ?? {}),
          };
          break;
        }
        case 'evaluate': {
          // User-confirmation happens server-side (mcp-handlers); inject just runs
          try { data = { result: eval(msg.expression) }; } catch (e) { data = { error: (e as Error).message }; }
          break;
        }
        default: data = { error: `unknown kind ${kind}` };
      }
    } catch (err) {
      data = { error: (err as Error).message };
    }
    dispatcher.send({ type: 'response' as any, url: '', timestamp: Date.now(), payload: { requestId, data } as any });
  });
}
```

- [ ] **Step 2: Update the dispatcher `send` to also handle `response` envelope**

The response should be sent as a direct WS message (not wrapped in `event: {type, payload}`). Change `Dispatcher.send` to accept a generic shape and allow bypassing event-wrapping.

Modify `packages/inject/src/dispatcher.ts`:
```ts
// Add sendRaw method:
sendRaw(message: any): void {
  const s = JSON.stringify(message);
  if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
  else this.queue.push(s);
}
```

Update `handleEvaluate` to use `sendRaw`:
```ts
dispatcher.sendRaw({ type: 'response', requestId, data });
```

- [ ] **Step 3: Wire `onServerMessage`**

In `packages/inject/src/index.ts`, update the dispatcher callback:

```ts
const dispatcher = new Dispatcher({
  port,
  onServerMessage: (msg) => {
    if (msg.type === 'highlight') overlay.pulseHighlight(msg.selector, msg.durationMs ?? 800);
    if (msg.type === 'scroll_to') document.querySelector(msg.selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (msg.type === 'navigate') window.location.href = msg.url;
    if (msg.type === 'reload') window.location.reload();
    if (msg.type === 'evaluate') handleEvaluate(dispatcher, msg);
  },
});
```

Import: `import { handleEvaluate } from './evaluate';`

- [ ] **Step 4: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-inject`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add packages/inject/src/evaluate.ts packages/inject/src/dispatcher.ts packages/inject/src/index.ts
git commit -m "feat(inject): evaluate handler for MCP query proxies"
```

---

### Task 28: evaluate_in_page terminal confirmation

**Files:**
- Modify: `packages/server/src/pty-bridge.ts` — expose PTY write function
- Modify: `packages/server/src/mcp-handlers.ts` — require confirmation before evaluate

- [ ] **Step 1: Refactor `pty-bridge.ts` to expose a write-to-PTY function**

```ts
export interface PtyBridgeControl {
  writeToTerminal(text: string): void;
  onTerminalInput(handler: (data: string) => void): () => void;
}

export function registerPtyBridge(app: FastifyInstance, opts: PtyBridgeOptions): PtyBridgeControl {
  let currentPty: IPty | null = null;
  const inputListeners = new Set<(d: string) => void>();

  app.get('/_companion/pty', { websocket: true } as any, (conn: any) => {
    const socket: WebSocket = conn.socket ?? conn;
    const pty = spawn(opts.shell ?? process.env.SHELL ?? '/bin/zsh', ['-lc', ['claude', ...(opts.claudeArgs ?? [])].join(' ')], {
      name: 'xterm-256color',
      cols: 120, rows: 30,
      cwd: opts.cwd,
      env: { ...process.env, VISUAL_COMPANION_PORT: String(opts.companionPort) },
    });
    currentPty = pty;

    pty.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'data', data }));
    });
    pty.onExit(({ exitCode }) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'exit', exitCode }));
      currentPty = null;
    });

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'data') {
          pty.write(msg.data);
          for (const h of inputListeners) h(msg.data);
        }
        if (msg.type === 'resize') pty.resize(msg.cols, msg.rows);
      } catch {}
    });
    socket.on('close', () => { pty.kill(); currentPty = null; });
  });

  return {
    writeToTerminal(text: string) {
      if (currentPty) currentPty.write(text);
    },
    onTerminalInput(handler) {
      inputListeners.add(handler);
      return () => inputListeners.delete(handler);
    },
  };
}
```

- [ ] **Step 2: Modify `mcp-handlers.ts` — require confirmation for `evaluate_in_page`**

Change the signature:
```ts
export interface McpHandlersOptions {
  store: EventStore;
  gateway: WebSocketGateway;
  pty: PtyBridgeControl;
}
```

Replace the `evaluate_in_page` handler:
```ts
app.post('/_companion/mcp/evaluate_in_page', async (req) => {
  const { expression } = req.body as { expression: string };
  const confirmed = await confirmInTerminal(opts.pty, expression);
  if (!confirmed) return { cancelled: true };
  return proxyToBrowser(gateway, { kind: 'evaluate', expression });
});
```

And implement `confirmInTerminal` (input arrives per-keystroke from xterm — buffer until Enter):

```ts
async function confirmInTerminal(pty: PtyBridgeControl, expression: string): Promise<boolean> {
  return new Promise((resolve) => {
    const prompt = `\r\n\x1b[33m[visual-companion]\x1b[0m Claude wants to evaluate:\r\n\x1b[90m${expression.slice(0, 400)}\x1b[0m\r\nAllow? [y/N] `;
    pty.writeToTerminal(prompt);
    let buffer = '';
    const timeout = setTimeout(() => { unsubscribe(); pty.writeToTerminal('\r\n[timeout — denied]\r\n'); resolve(false); }, 30_000);
    const unsubscribe = pty.onTerminalInput((data: string) => {
      // accumulate; check on Enter (CR or LF)
      for (const char of data) {
        if (char === '\r' || char === '\n') {
          const answer = buffer.trim().toLowerCase();
          clearTimeout(timeout);
          unsubscribe();
          pty.writeToTerminal('\r\n');
          resolve(answer === 'y' || answer === 'yes');
          return;
        }
        if (char === '\x7f' || char === '\b') {
          buffer = buffer.slice(0, -1);
        } else if (char >= ' ' && char <= '~') {
          buffer += char;
        }
      }
    });
  });
}
```

- [ ] **Step 3: Wire in `index.ts`**

```ts
import { registerPtyBridge } from './pty-bridge.js';
const pty = registerPtyBridge(app, { cwd: cfg.cwd, companionPort: serverPort });
registerMcpHandlers(app, { store, gateway, pty });
```

- [ ] **Step 4: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-server`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/
git commit -m "feat(server): evaluate_in_page requires terminal y/N confirmation"
```

---

## Phase 10 — Launch Script + Plugin Manifest

### Task 29: Launch script (bin/launch.js)

**Files:**
- Create: `bin/launch.js`

- [ ] **Step 1: Implement `launch.js`**

```js
#!/usr/bin/env node
/**
 * /visual-companion [url] entry point
 * 1. starts the companion server as detached child
 * 2. waits for "READY port=XXXX" on stdout
 * 3. launches Chrome in app-mode with isolated profile
 * 4. exits (server keeps running, monitored by its own parent-watch)
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const argv = process.argv.slice(2);
let url = argv.find((a) => !a.startsWith('--'));
const cwd = process.cwd();

// URL auto-detection
if (!url) url = autoDetectUrl(cwd);
if (!url) {
  console.error('visual-companion: no URL provided and auto-detection failed.');
  console.error('  usage: /visual-companion <url>');
  console.error('  hint: create .visual-companion.json with { "default_url": "http://localhost:3000" }');
  process.exit(1);
}

const pluginRoot = path.resolve(__dirname, '..');
const serverEntry = path.join(pluginRoot, 'packages/server/dist/index.js');
const shellDir = path.join(pluginRoot, 'packages/shell/dist');
const injectFile = path.join(pluginRoot, 'packages/inject/dist/inject.js');

for (const f of [serverEntry, shellDir, injectFile]) {
  if (!fs.existsSync(f)) {
    console.error('visual-companion: missing build artifact:', f);
    console.error('  run `npm run build` in the plugin dir first.');
    process.exit(1);
  }
}

const server = spawn(process.execPath, [serverEntry], {
  detached: true,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: {
    ...process.env,
    VISUAL_COMPANION_PORT: '0',
    VISUAL_COMPANION_TARGET_URL: url,
    VISUAL_COMPANION_CWD: cwd,
    VISUAL_COMPANION_SHELL_DIR: shellDir,
    VISUAL_COMPANION_INJECT_FILE: injectFile,
  },
});

let bufferedOut = '';
server.stdout.on('data', (chunk) => {
  bufferedOut += chunk.toString();
  const m = bufferedOut.match(/READY port=(\d+)/);
  if (m) {
    const port = m[1];
    launchChrome(port, server.pid, url);
    server.stdout.removeAllListeners('data');
    server.unref();
    // exit launcher, server keeps running
    setTimeout(() => process.exit(0), 200);
  }
});

server.on('exit', (code) => {
  if (code !== 0) {
    console.error('visual-companion server exited early, code=', code);
    process.exit(1);
  }
});

function launchChrome(port, serverPid, url) {
  const profileDir = `/tmp/visual-companion-${serverPid}`;
  const appUrl = `http://localhost:${port}/window/window.html?target=${encodeURIComponent('/app/')}`;
  const chrome = spawn('open', [
    '-na', 'Google Chrome',
    '--args',
    `--app=${appUrl}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], { detached: true, stdio: 'ignore' });
  chrome.unref();
  console.log(`visual-companion: opening ${url} on port ${port}`);
}

function autoDetectUrl(cwd) {
  const config = path.join(cwd, '.visual-companion.json');
  if (fs.existsSync(config)) {
    try {
      const j = JSON.parse(fs.readFileSync(config, 'utf8'));
      if (j.default_url) return j.default_url;
    } catch {}
  }
  const pkg = path.join(cwd, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      const dev = j?.scripts?.dev || '';
      const m = dev.match(/--port[= ](\d+)/) || dev.match(/-p[= ](\d+)/) || dev.match(/PORT=(\d+)/);
      if (m) return `http://localhost:${m[1]}`;
    } catch {}
  }
  return null;
}
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x bin/launch.js`

- [ ] **Step 3: Commit**

```bash
git add bin/launch.js
git commit -m "feat: launch script with URL auto-detect + Chrome app-mode"
```

---

### Task 30: Parent-watch shutdown in server

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Add watchdog — shutdown when clients have been gone for >60s post-launch**

Add at the top of `packages/server/src/index.ts`:

```ts
import { mkdirSync, rmSync } from 'node:fs';
```

In `main()`, after `const gateway = registerCompanionWebSocket(...)`:

```ts
const profileDir = `/tmp/visual-companion-${process.pid}`;
try { mkdirSync(profileDir, { recursive: true }); } catch {}

let hadConnectionOnce = false;
let gapStartMs: number | null = null;
const IDLE_GRACE_MS = 60_000;
const MAX_RUNTIME_MS = 8 * 3600 * 1000;
const startedAt = Date.now();

const watchdog = setInterval(async () => {
  if (Date.now() - startedAt > MAX_RUNTIME_MS) {
    console.log('visual-companion: 8h runtime limit reached, shutting down');
    return shutdown();
  }
  const connected = gateway.connectionCount() > 0;
  if (connected) {
    hadConnectionOnce = true;
    gapStartMs = null;
    return;
  }
  if (!hadConnectionOnce) return; // haven't seen anyone yet, keep waiting
  if (gapStartMs === null) gapStartMs = Date.now();
  if (Date.now() - gapStartMs > IDLE_GRACE_MS) {
    console.log('visual-companion: no clients for 60s, shutting down');
    return shutdown();
  }
}, 5000);

async function shutdown(): Promise<void> {
  clearInterval(watchdog);
  try { await app.close(); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

**Why this approach:** We can't reliably get Chrome's actual PID from `open -na`, and watching profile-dir existence doesn't work because Chrome keeps the dir alive during runtime. Instead, we rely on: (a) the browser disconnects its WebSocket when the window closes, (b) xterm.js disconnects its PTY WebSocket too. When both client counts stay at zero for 60s, the server self-terminates.

- [ ] **Step 2: Build**

Run: `npm run build -w @areti-gmbh/visual-companion-server`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(server): shutdown after 60s idle (no connected clients)"
```

---

### Task 31: Plugin manifest

**Files:**
- Create: `claude-plugin.json`

- [ ] **Step 1: Create manifest**

```json
{
  "name": "@areti-gmbh/visual-companion",
  "version": "0.1.0",
  "description": "Unified Chrome-App Window mit Live-Pointer für Web-App-Entwicklung",
  "author": "ARETI GmbH",
  "license": "UNLICENSED",
  "commands": [
    {
      "name": "visual-companion",
      "aliases": ["vc"],
      "description": "Öffnet unified window mit Browser + Claude für eine URL",
      "usage": "/visual-companion [url]",
      "handler": "bin/launch.js"
    }
  ],
  "mcpServers": {
    "visual-companion-mcp": {
      "command": "node",
      "args": ["packages/server/dist/mcp-entry.js"],
      "transport": "stdio"
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add claude-plugin.json
git commit -m "chore: add Claude-Code plugin manifest"
```

---

## Phase 11 — E2E Tests & Acceptance

### Task 32: ARES fixture e2e

**Files:**
- Create: `tests/e2e/ares-fixture.html`
- Create: `tests/e2e/ares-proxy.spec.ts`
- Create: `playwright.config.ts`

- [ ] **Step 1: Create `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: { headless: true, viewport: { width: 1280, height: 800 } },
  webServer: {
    command: 'npm run start -w @areti-gmbh/visual-companion-server',
    url: 'http://localhost:7788/_companion/health',
    reuseExistingServer: false,
    timeout: 10_000,
    env: {
      VISUAL_COMPANION_PORT: '7788',
      VISUAL_COMPANION_TARGET_URL: 'http://127.0.0.1:7789',
      VISUAL_COMPANION_CWD: process.cwd(),
      VISUAL_COMPANION_SHELL_DIR: `${process.cwd()}/packages/shell/dist`,
      VISUAL_COMPANION_INJECT_FILE: `${process.cwd()}/packages/inject/dist/inject.js`,
    },
  },
});
```

- [ ] **Step 2: Create fixture `ares-fixture.html`**

```html
<!DOCTYPE html>
<html>
<head><title>ARES Fixture</title></head>
<body>
  <button id="save-btn" class="btn btn-primary">Save</button>
  <div id="hero" class="hero-block">Hero content</div>
</body>
</html>
```

- [ ] **Step 3: Create spec `ares-proxy.spec.ts`**

```ts
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const FIXTURE_HTML = readFileSync(path.join(__dirname, 'ares-fixture.html'), 'utf8');

test.beforeAll(async () => {
  const fixtureServer = createServer((_req, res) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Type', 'text/html');
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>((resolve) => fixtureServer.listen(7789, '127.0.0.1', resolve));
  (global as any).__fixtureServer = fixtureServer;
});

test.afterAll(() => { (global as any).__fixtureServer?.close(); });

test('proxy strips X-Frame-Options and injects companion script', async ({ page }) => {
  const response = await page.goto('http://localhost:7788/app/');
  expect(response?.headers()['x-frame-options']).toBeUndefined();
  const content = await page.content();
  expect(content).toContain('/_companion/inject.js');
});

test('pointer Alt+Click captures element', async ({ page }) => {
  await page.goto('http://localhost:7788/app/');
  await page.waitForTimeout(500); // let inject script boot
  const button = page.locator('#save-btn');
  await button.dispatchEvent('click', { altKey: true, button: 0 });
  await page.waitForTimeout(300);
  const events = await (await fetch('http://localhost:7788/_companion/mcp/get_pointed_element', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  expect(events).not.toBeNull();
  expect(events.tagName).toBe('button');
});
```

- [ ] **Step 4: Build everything and run e2e**

```bash
npm run build
npx playwright install chromium
npm run e2e
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/ playwright.config.ts
git commit -m "test(e2e): ARES fixture proxy + pointer capture"
```

---

### Task 33: Full integration smoke (manual)

**Files:**
- Create: `docs/MANUAL-ACCEPTANCE.md`

- [ ] **Step 1: Document acceptance steps**

```markdown
# Visual Companion — Manual Acceptance Checklist

Run before tagging a release.

## Setup
- [ ] `npm install`
- [ ] `npm run build`
- [ ] `chmod +x bin/launch.js`
- [ ] Install plugin locally into `~/.claude/plugins/` (symlink or copy)

## Single-File HTML (ARES)
- [ ] In terminal: `cd ~/Desktop && python3 -m http.server 8000 &`
- [ ] In terminal: `claude` then `/visual-companion http://localhost:8000/ARES/ARES.html`
- [ ] Chrome App window opens
- [ ] ARES app loads in left pane
- [ ] Claude prompt appears in right pane
- [ ] Alt hover → elements highlighted with selector labels
- [ ] Alt+Click on a button → in terminal, ask „was habe ich gerade geklickt" → Claude responds with element details

## Next.js
- [ ] Start any Next.js project: `cd <proj> && pnpm dev`
- [ ] `/visual-companion` (auto-detect from package.json)
- [ ] Next.js app renders, HMR works
- [ ] console.log in app → visible to Claude via `get_console_logs`

## Reload Behavior
- [ ] Cmd+R in window → iframe reloads (not window)
- [ ] Titlebar URL input accepts new path, navigates iframe

## Shutdown
- [ ] Close the Chrome App window
- [ ] Companion server exits within 60s
- [ ] `/tmp/visual-companion-*` profile dir cleaned up

## Multi-Window
- [ ] Open second window: `/visual-companion http://localhost:3001`
- [ ] Both windows work independently with own claude sessions and MCP servers

## evaluate_in_page Confirmation
- [ ] Ask Claude to run a JS expression in the page
- [ ] Terminal shows confirmation prompt
- [ ] Type `n` → expression not executed
- [ ] Type `y` → executes, result returned to Claude
```

- [ ] **Step 2: Commit**

```bash
git add docs/MANUAL-ACCEPTANCE.md
git commit -m "docs: manual acceptance checklist"
```

---

### Task 34: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

```markdown
# @areti-gmbh/visual-companion

Unified Chrome-App-Window for Claude-Code development. Pair a live reverse-proxied view of your web-app with a Claude-Code session in a single window, and point at UI elements without screenshots.

## Install

```bash
claude plugin install @areti-gmbh/visual-companion
```

## Usage

```bash
# In any terminal with Claude Code running
> /visual-companion http://localhost:3000
# or just /vc if the Dev-Port is auto-detectable
```

## How It Works

- A Node daemon starts a reverse proxy + WebSocket gateway + MCP server
- Chrome launches in app-mode with an isolated profile, loading a split-view window
- Left pane: iframe serving your app through the proxy (X-Frame-Options stripped, companion script injected)
- Right pane: xterm.js terminal running a fresh `claude` session
- Alt+Click any element → Claude receives DOM + styles + screenshot + source-map + ancestors
- Console logs, network requests, errors all stream to a 5-minute ring buffer Claude can query

See `docs/superpowers/specs/2026-04-21-visual-companion-design.md` for full spec.

## Develop

```bash
npm install
npm run build
npm test
npm run e2e
```

## License

UNLICENSED — internal ARETI GmbH tool.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with quick-start"
```

---

## Self-Review Checklist

After executing all tasks, verify:

- [ ] `npm run typecheck` passes across all packages
- [ ] `npm test` — all unit tests green
- [ ] `npm run e2e` — Playwright tests green
- [ ] `npm run lint` clean
- [ ] Manual acceptance (`docs/MANUAL-ACCEPTANCE.md`) all boxes ticked
- [ ] Plugin installs via `claude plugin install` without errors (use local path for testing)
- [ ] Second-window concurrent operation works

---

**End of Plan.**
