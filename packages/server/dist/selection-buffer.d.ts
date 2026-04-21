import type { PointerEventPayload } from './types';
export interface BufferedSelection {
    id: string;
    label: string;
    kind: 'element' | 'region';
    url: string;
    pathname: string;
    selector: string;
    textPreview: string;
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
export declare class SelectionBuffer {
    private items;
    private counter;
    add(selection: Omit<BufferedSelection, 'id' | 'label' | 'addedAt'>): BufferedSelection;
    remove(id: string): boolean;
    clear(): void;
    rename(id: string, label: string): boolean;
    list(): BufferedSelection[];
    summaries(): SelectionSummary[];
    size(): number;
    /**
     * Format the sticky prefix claude sees before every prompt. Single
     * and multi-element prefixes use different MCP-tool hints because
     * `get_pointed_element` (singular) returns only the latest and
     * would hide the other picks; `get_pointed_elements` (plural)
     * returns the whole buffer.
     */
    buildPrefix(): string | null;
}
