import type { PointerEventPayload } from './types';

/** Rectangle the user actually drew, in document coordinates (viewport
 *  coords + scroll at pick time). Only present for region picks — the
 *  overlay renders this rectangle instead of the anchor element's
 *  bounding box so the visible frame matches what the user drew. */
export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BufferedSelection {
  id: string;
  label: string;
  kind: 'element' | 'region';
  url: string;
  pathname: string;
  selector: string;
  textPreview: string;
  regionRect?: RegionRect;
  payload: PointerEventPayload;
  addedAt: number;
}

export interface SelectionSummary {
  id: string;
  label: string;
  kind: 'element' | 'region';
  url: string;
  pathname: string;
  selector: string;
  textPreview: string;
  regionRect?: RegionRect;
}

/**
 * Multi-select buffer. Every Alt+Shift pick the user makes in the iframe
 * accumulates here. The buffer is the source of truth for:
 *   - the sticky `[markiert: ...]` prefix injected into claude's prompt
 *   - the `get_pointed_elements` MCP tool
 *   - the chips rendered in the shell panel above the terminal
 *   - restoring overlays after an iframe navigation (per-selection URL
 *     + selector lets us re-show frames on the correct page)
 *
 * IDs are monotonically increasing within a daemon lifetime — never
 * reused even after remove/clear. That makes them safe primary keys
 * for every downstream (WS messages, DOM overlay tracking, MCP).
 */
export class SelectionBuffer {
  private items: BufferedSelection[] = [];
  private counter = 0;

  add(selection: Omit<BufferedSelection, 'id' | 'label' | 'addedAt'>): BufferedSelection {
    this.counter += 1;
    const entry: BufferedSelection = {
      ...selection,
      id: `sel-${this.counter}`,
      label: `#${this.counter}`,
      addedAt: Date.now(),
    };
    this.items.push(entry);
    return entry;
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    return this.items.length !== before;
  }

  clear(): void {
    this.items = [];
    // Counter deliberately NOT reset — freshly-picked elements after
    // a clear continue numbering to avoid confusing claude with
    // "#1" that maps to a different selection than the earlier "#1".
  }

  rename(id: string, label: string): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item) return false;
    item.label = label;
    return true;
  }

  list(): BufferedSelection[] {
    return this.items.slice();
  }

  summaries(): SelectionSummary[] {
    return this.items.map((i) => ({
      id: i.id,
      label: i.label,
      kind: i.kind,
      url: i.url,
      pathname: i.pathname,
      selector: i.selector,
      textPreview: i.textPreview,
      ...(i.regionRect ? { regionRect: i.regionRect } : {}),
    }));
  }

  size(): number {
    return this.items.length;
  }

  /**
   * Format the sticky prefix claude sees before every prompt. Single
   * and multi-element prefixes use different MCP-tool hints because
   * `get_pointed_element` (singular) returns only the latest and
   * would hide the other picks; `get_pointed_elements` (plural)
   * returns the whole buffer.
   */
  buildPrefix(): string | null {
    if (this.items.length === 0) return null;
    const parts = this.items.map((i) => {
      const text = i.textPreview ? ` · "${i.textPreview}"` : '';
      return `${i.label}=${i.selector}·${i.pathname}${text}`;
    });
    const tool = this.items.length === 1 ? 'get_pointed_element' : 'get_pointed_elements';
    return `[markiert: ${parts.join(' ; ')} — bitte zuerst MCP ${tool} aufrufen] `;
  }
}
