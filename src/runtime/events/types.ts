/**
 * Lifecycle states of the SSE EventBridgeClient.
 */
export type EventBridgeState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

/**
 * Options configuring client-side SSE connection and reconnection parameters.
 */
export interface EventBridgeClientOptions {
    readonly baseUrl?: string;
    readonly fetch?: typeof fetch;
    readonly headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
    readonly initialDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly backoffFactor?: number;
    readonly jitterFactor?: number;
    readonly randomFn?: () => number;
    readonly onReconnectAttempt?: (attempt: number, delayMs: number) => void;
    readonly onStateChange?: (state: EventBridgeState) => void;
}

/**
 * EventBridgeClient: client-side interface for subscribing to live mesh events over SSE.
 */
export interface EventBridgeClient<TEvents = Record<string, unknown>> {
    readonly status: EventBridgeState;
    readonly isDisposed: boolean;
    on<K extends keyof TEvents>(topic: K, handler: (payload: TEvents[K]) => void): () => void;
    on<T = unknown>(topic: string, handler: (payload: T) => void): () => void;
    close(): void;
    dispose(): void;
}
