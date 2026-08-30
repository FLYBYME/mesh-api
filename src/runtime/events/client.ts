import type {
    EventBridgeClient,
    EventBridgeClientOptions,
    EventBridgeState,
} from './types.js';

type TopicHandler = (payload: unknown) => void;

/**
 * createEventBridgeClient: creates an SSE event bridge client with automatic reconnection,
 * exponential backoff, jitter, and Last-Event-ID support.
 */
export function createEventBridgeClient<TEvents = Record<string, unknown>>(
    options: EventBridgeClientOptions = {}
): EventBridgeClient<TEvents> {
    const baseUrl = options.baseUrl ?? '/api';
    const customFetch = options.fetch ?? globalThis.fetch;
    const initialDelayMs = options.initialDelayMs ?? 1000;
    const maxDelayMs = options.maxDelayMs ?? 30000;
    const backoffFactor = options.backoffFactor ?? 2;
    const jitterFactor = options.jitterFactor ?? 0.25;
    const randomFn = options.randomFn ?? Math.random;

    let status: EventBridgeState = 'idle';
    let isDisposed = false;
    let reconnectAttempt = 0;
    let lastEventId: string | undefined = undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    let connectScheduled = false;
    let abortController: AbortController | null = null;

    const topicHandlers = new Map<string, Set<TopicHandler>>();
    let connectedTopicsKey = '';

    const setStatus = (next: EventBridgeState): void => {
        if (status !== next) {
            status = next;
            options.onStateChange?.(next);
        }
    };

    const getActiveTopics = (): string[] => {
        const list: string[] = [];
        for (const [topic, handlers] of topicHandlers.entries()) {
            if (handlers.size > 0) {
                list.push(topic);
            }
        }
        return list.sort();
    };

    const scheduleReconnect = (): void => {
        if (isDisposed || status === 'closed') {
            return;
        }
        const topics = getActiveTopics();
        if (topics.length === 0) {
            setStatus('idle');
            return;
        }

        setStatus('reconnecting');
        const baseDelay = initialDelayMs * Math.pow(backoffFactor, reconnectAttempt);
        const cappedDelay = Math.min(maxDelayMs, baseDelay);
        const rand = randomFn();
        const jitterMultiplier = 1 + jitterFactor * (rand * 2 - 1);
        const delayMs = Math.max(0, Math.round(cappedDelay * jitterMultiplier));

        options.onReconnectAttempt?.(reconnectAttempt, delayMs);
        reconnectAttempt++;

        if (reconnectTimer !== undefined) {
            clearTimeout(reconnectTimer);
        }
        reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            void connect();
        }, delayMs);
    };

    const connect = async (): Promise<void> => {
        if (isDisposed || status === 'closed') {
            return;
        }

        const topics = getActiveTopics();
        if (topics.length === 0) {
            setStatus('idle');
            return;
        }

        const currentKey = topics.join(',');
        connectedTopicsKey = currentKey;

        if (abortController !== null) {
            abortController.abort();
            abortController = null;
        }

        const controller = new AbortController();
        abortController = controller;
        setStatus('connecting');

        const resolvedHeaders: Record<string, string> = {
            Accept: 'text/event-stream',
            ...(options.headers
                ? typeof options.headers === 'function'
                    ? await options.headers()
                    : options.headers
                : {}),
        };

        if (lastEventId !== undefined) {
            resolvedHeaders['Last-Event-ID'] = lastEventId;
        }

        const url = `${baseUrl}/events?topics=${encodeURIComponent(currentKey)}`;

        try {
            const res = await customFetch(url, {
                method: 'GET',
                headers: resolvedHeaders,
                credentials: 'include',
                signal: controller.signal,
            });

            if (!res.ok) {
                if (res.status === 401 || res.status === 403) {
                    setStatus('closed');
                    return;
                }
                scheduleReconnect();
                return;
            }

            setStatus('connected');
            reconnectAttempt = 0;

            const reader = res.body?.getReader();
            if (!reader) {
                return;
            }

            const decoder = new TextDecoder('utf-8');
            let streamBuffer = '';
            let currentEventName = 'message';
            const currentDataLines: string[] = [];
            let currentId: string | undefined = undefined;

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                streamBuffer += decoder.decode(value, { stream: true });
                const lines = streamBuffer.split(/\r\n|\r|\n/);
                streamBuffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (line === '') {
                        if (currentDataLines.length > 0) {
                            const rawData = currentDataLines.join('\n');
                            let parsed: unknown = rawData;
                            try {
                                parsed = JSON.parse(rawData);
                            } catch {
                                // Fallback to raw string if non-JSON
                            }

                            const handlers = topicHandlers.get(currentEventName);
                            if (handlers !== undefined) {
                                for (const handler of Array.from(handlers)) {
                                    try {
                                        handler(parsed);
                                    } catch {
                                        // Ignore handler errors so remaining listeners execute
                                    }
                                }
                            }
                        }

                        if (currentId !== undefined) {
                            lastEventId = currentId;
                        }

                        currentEventName = 'message';
                        currentDataLines.length = 0;
                        currentId = undefined;
                    } else if (line.startsWith(':')) {
                        // Heartbeat / comment line
                    } else if (line.startsWith('event:')) {
                        currentEventName = line.slice(line.startsWith('event: ') ? 7 : 6).trim();
                    } else if (line.startsWith('data:')) {
                        currentDataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
                    } else if (line.startsWith('id:')) {
                        currentId = line.slice(line.startsWith('id: ') ? 4 : 3).trim();
                    }
                }
            }

            if (!controller.signal.aborted) {
                scheduleReconnect();
            }
        } catch {
            if (!controller.signal.aborted && !isDisposed) {
                scheduleReconnect();
            }
        }
    };


    const triggerConnect = (): void => {
        if (connectScheduled || isDisposed || status === 'closed') {
            return;
        }
        connectScheduled = true;
        queueMicrotask(() => {
            connectScheduled = false;
            const currentKey = getActiveTopics().join(',');
            if (status === 'connected' && currentKey === connectedTopicsKey) {
                return;
            }
            void connect();
        });
    };

    const client: EventBridgeClient<TEvents> = {
        get status(): EventBridgeState {
            return status;
        },
        get isDisposed(): boolean {
            return isDisposed;
        },
        on<K extends keyof TEvents>(
            topic: K | string,
            handler: (payload: TEvents[K]) => void
        ): () => void {
            if (isDisposed) {
                throw new Error('[EventBridgeClient] Cannot subscribe: client is disposed');
            }

            const topicStr = String(topic);
            let handlers = topicHandlers.get(topicStr);
            if (handlers === undefined) {
                handlers = new Set<TopicHandler>();
                topicHandlers.set(topicStr, handlers);
            }
            handlers.add(handler as TopicHandler);

            triggerConnect();

            return () => {
                const set = topicHandlers.get(topicStr);
                if (set !== undefined) {
                    set.delete(handler as TopicHandler);
                    if (set.size === 0) {
                        topicHandlers.delete(topicStr);
                    }
                }
            };
        },
        close(): void {
            isDisposed = true;
            setStatus('closed');
            if (reconnectTimer !== undefined) {
                clearTimeout(reconnectTimer);
                reconnectTimer = undefined;
            }
            if (abortController !== null) {
                abortController.abort();
                abortController = null;
            }
            topicHandlers.clear();
        },
        dispose(): void {
            this.close();
        },
    };

    return client;
}
