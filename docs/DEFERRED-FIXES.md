# Deferred Fixes

Issues flagged during phase reviews that are not blocking MVP but should be addressed before broad rollout.

## Proxy (Phase 3)

### Critical — fix before real-app usage

- **C1 — Request body method guard** (`packages/server/src/proxy.ts:32`): Pass `body: ['GET','HEAD'].includes(req.method) ? undefined : req.raw` to avoid sending empty bodies with `Content-Length: 0` on GETs, which some upstreams reject.
- **C2 — Location header rewrite on 3xx redirects**: When upstream returns `Location: http://localhost:3000/foo`, rewrite to `Location: /app/foo` so the browser stays within the proxy. Otherwise the iframe navigates to upstream origin directly and loses injection/header-stripping.
- **C3 — Set-Cookie domain/path rewriting**: Upstream cookies with `Path=/api` need rewrite to `Path=/app/api`. Drop `Secure` attribute in dev (plain HTTP proxy). Handle multi-cookie arrays correctly (Fastify `reply.header` with array value, not stringified).

### Important — fix before any non-trivial framework app

- **I1 — content-encoding stripping on HTML injection**: When injecting a `<script>` into a text/html response, drop `content-encoding` (e.g. `gzip`) before sending. Undici `body.text()` decodes transparently, but forwarding the header makes the browser double-decode the plain string and fail.
- **I2 — transfer-encoding header**: Add `'transfer-encoding'` to `STRIPPED_RESPONSE_HEADERS`.
- **I3 — Hop-by-hop header filtering**: Strip `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `upgrade` in both directions.
- **I6 — WS tunnel connect timeout**: `upstreamSocket.setTimeout(10_000)` + destroy on timeout to avoid indefinite hangs when upstream is down.

### Minor — polish

- **M1 — Query param array handling**: Use `searchParams.append` for array-valued params.
- **M5 — Test coverage for CSP report-only, gzip, redirect branches**.
- **M7 — stripFrameAncestors empty-result guard**: already implemented (`if (filtered)`) — add a test to pin behavior.

## Plan doc corrections

- **Task 7** should not claim tests are "already passing from Task 6" — the test file is created in Task 6 but the injection tests need Task 6's implementation too. Merge Task 6+7 in the next plan revision.
- **Task 8** should describe the WS tunnel as a raw `net.connect()` replay of the HTTP/1.1 upgrade, not the `ws`-client + `_socket`-pipe approach (which is broken — never sends 101 back to outer client).
- **Base tsconfig declaration conflict**: Either flip `declaration: true` in `tsconfig.base.json` or keep per-package override (currently in `packages/server/tsconfig.json`).
