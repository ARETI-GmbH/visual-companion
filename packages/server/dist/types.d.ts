export type EventType = 'pointer' | 'console' | 'network' | 'mutation' | 'navigation' | 'error' | 'clear-selection' | 'remove-selection' | 'rename-selection' | 'send-selections';
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
    boundingBox: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    textContent: string;
    computedStyles: {
        layout: Record<string, string>;
        typography: Record<string, string>;
        colors: Record<string, string>;
        spacing: Record<string, string>;
    };
    screenshotDataUrl: string | null;
    sourceLocation: {
        file: string;
        line: number;
        column: number;
    } | null;
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
export type CompanionEvent = (BaseEvent & {
    type: 'pointer';
    payload: PointerEventPayload;
}) | (BaseEvent & {
    type: 'console';
    payload: ConsoleEventPayload;
}) | (BaseEvent & {
    type: 'network';
    payload: NetworkEventPayload;
}) | (BaseEvent & {
    type: 'mutation';
    payload: {
        adds: number;
        removes: number;
        attributeChanges: number;
    };
}) | (BaseEvent & {
    type: 'navigation';
    payload: {
        newUrl: string;
        referrer: string;
    };
}) | (BaseEvent & {
    type: 'error';
    payload: {
        message: string;
        stack: string | null;
    };
}) | (BaseEvent & {
    type: 'clear-selection';
    payload: unknown;
}) | (BaseEvent & {
    type: 'remove-selection';
    payload: {
        id: string;
    };
}) | (BaseEvent & {
    type: 'rename-selection';
    payload: {
        id: string;
        label: string;
    };
}) | (BaseEvent & {
    type: 'send-selections';
    payload: unknown;
});
