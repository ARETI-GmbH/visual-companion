import type { Dispatcher } from './dispatcher';

/**
 * Mutation counting was a performance disaster on animation-heavy apps:
 * subtree+attributes observed every style/class swap React Spring or
 * Framer Motion does per frame, producing thousands of records/sec
 * that we aggregated into a number no MCP tool ever queried. We were
 * burning CPU for observability data nobody consumed.
 *
 * Kept as a no-op with the same signature so index.ts doesn't need to
 * branch. If we ever need real DOM-change detection for a debugging
 * tool, re-enable with `{ childList: true }` only (no subtree, no
 * attributes) and gate it on a per-tool opt-in message from the server.
 */
export function attachMutationObserver(_dispatcher: Dispatcher): void {
  // Intentionally empty.
}
