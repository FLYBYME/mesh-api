import type { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { ExposureBroker } from './broker.js';
import type { EventExposeEntry, AuthLevel } from './types.js';
import type { AuthorizeHook, AuthorizeInput } from '../auth/types.js';
import { extractRequestedScope, ADMIN_ROLE } from '../auth/gate.js';


export interface ValidatedEventEntry {
    readonly event: string;
    readonly auth?: AuthLevel;
    readonly permission?: string;
    readonly scope?: string;
    readonly schema?: z.ZodTypeAny;
}

/**
 * validateEventExposeEntry: enforces at startup that every exposed event declares
 * an explicit coarse gate (`auth`) or fine-grained gate (`permission`).
 *
 * An entry with neither is refused at startup so an author cannot accidentally leave an
 * event stream unguarded. An entry with both is refused as contradictory.
 */
export function validateEventExposeEntry(entry: EventExposeEntry): ValidatedEventEntry {
    const rawEvent = entry.event;
    let eventName = '';
    let schema: z.ZodTypeAny | undefined = entry.schema;

    if (typeof rawEvent === 'string') {
        eventName = rawEvent.trim();
    } else if (typeof rawEvent === 'object' && rawEvent !== null && 'name' in rawEvent) {
        eventName = rawEvent.name;
        if (!schema && 'schema' in rawEvent && rawEvent.schema) {
            schema = rawEvent.schema;
        }
    } else {
        throw new Error('Invalid event entry: event must be a string or EventDefinition');
    }

    if (!eventName) {
        throw new Error('Invalid event entry: event name cannot be empty');
    }

    const hasAuth = 'auth' in entry && typeof entry.auth === 'string' && entry.auth.length > 0;
    const hasPermission = 'permission' in entry && typeof entry.permission === 'string' && entry.permission.length > 0;

    if (!hasAuth && !hasPermission) {
        throw new Error(
            `Unguarded event: entry for '${eventName}' must declare either 'auth' or 'permission'. An unguarded event is unrepresentable.`
        );
    }
    if (hasAuth && hasPermission) {
        throw new Error(
            `Invalid expose entry for event '${eventName}': cannot declare both 'auth' and 'permission'.`
        );
    }

    return {
        event: eventName,
        auth: entry.auth,
        permission: entry.permission,
        scope: entry.scope,
        schema,
    };
}

/**
 * extractEventScope: extracts the tenancy or organization scope identifier from an event payload
 * or mesh packet metadata.
 *
 * Checks top-level tenancy fields, nested record entities (e.g. payload.card, payload.item),
 * and broker packet metadata.
 */
export function extractEventScope(payload: unknown, packet?: unknown): string | undefined {
    if (typeof payload === 'object' && payload !== null) {
        const rec = payload as Record<string, unknown>;
        const candidate =
            rec['orgId'] ??
            rec['tenantId'] ??
            rec['tenant_id'] ??
            rec['organizationId'] ??
            rec['scope'];
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }

        // Check nested entities (e.g. payload.card, payload.item, payload.record)
        for (const val of Object.values(rec)) {
            if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                const inner = val as Record<string, unknown>;
                const innerCand =
                    inner['orgId'] ??
                    inner['tenantId'] ??
                    inner['tenant_id'] ??
                    inner['organizationId'] ??
                    inner['scope'];
                if (typeof innerCand === 'string' && innerCand.trim().length > 0) {
                    return innerCand.trim();
                }
            }
        }
    }

    if (typeof packet === 'object' && packet !== null) {
        const pkt = packet as Record<string, unknown>;
        const meta = pkt['meta'];
        if (typeof meta === 'object' && meta !== null) {
            const metaRec = meta as Record<string, unknown>;
            const user = metaRec['user'];
            if (typeof user === 'object' && user !== null) {
                const userTenant = (user as Record<string, unknown>)['tenant_id'];
                if (typeof userTenant === 'string' && userTenant.trim().length > 0) {
                    return userTenant.trim();
                }
            }
            const cand =
                metaRec['tenant_id'] ??
                metaRec['orgId'] ??
                metaRec['tenantId'] ??
                metaRec['scope'];
            if (typeof cand === 'string' && cand.trim().length > 0) {
                return cand.trim();
            }
        }
    }

    return undefined;
}

export interface BufferedEvent {
    readonly id: string;
    readonly topic: string;
    readonly data: unknown;
    readonly scope?: string;
    readonly timestamp: number;
}

export interface MountEventsOptions {
    readonly broker: ExposureBroker;
    readonly events: readonly EventExposeEntry[];
    readonly authorize?: AuthorizeHook;
    readonly heartbeatIntervalMs?: number;
    readonly bufferSize?: number;
}

/**
 * mountEvents: mounts the SSE event bridge under `GET /events`.
 *
 * Implements:
 * 1. Explicit topic exposure -- unlisted topics are silently absent from the delivered stream,
 *    preventing topic enumeration and probing.
 * 2. Scope enforcement at fan-out -- a subscriber scoped to org A never receives an event about org B.
 * 3. Correct SSE framing with heartbeat comments to keep idle connections open.
 * 4. Last-Event-ID replay buffer for reconnecting clients.
 * 5. Clean teardown -- disconnecting clients detach all broker listeners.
 */
export function mountEvents(router: Router, options: MountEventsOptions): void {
    const exposedMap = new Map<string, ValidatedEventEntry>();

    for (const entry of options.events) {
        const validated = validateEventExposeEntry(entry);
        const existing = exposedMap.get(validated.event);
        if (existing !== undefined) {
            throw new Error(`Duplicate exposed event: '${validated.event}' is declared multiple times with conflicting configurations.`);
        }
        exposedMap.set(validated.event, validated);
    }

    const bufferCapacity = options.bufferSize ?? 100;
    const eventBuffer: BufferedEvent[] = [];
    let sequenceCounter = 0;

    const addToBuffer = (evt: BufferedEvent): void => {
        eventBuffer.push(evt);
        if (eventBuffer.length > bufferCapacity) {
            eventBuffer.shift();
        }
    };

    interface SubscriberSession {
        readonly res: Response;
        readonly effectiveScope?: string;
        readonly isOperator: boolean;
    }

    const topicSubscribers = new Map<string, Set<SubscriberSession>>();
    const topicUnsubscribers = new Map<string, () => void>();

    const ensureTopicSubscription = (topic: string, entry: ValidatedEventEntry): void => {
        if (topicUnsubscribers.has(topic)) return;
        if (!options.broker.on) return;

        const isScoped = entry.scope === 'org' || entry.scope === 'tenant' || (entry.scope !== undefined && entry.scope !== 'global');

        const listener = (payload: unknown, packet?: unknown): void => {
            const eventScope = extractEventScope(payload, packet);
            sequenceCounter++;
            const eventId = `evt_${sequenceCounter}`;
            addToBuffer({
                id: eventId,
                topic,
                data: payload,
                scope: eventScope,
                timestamp: Date.now(),
            });

            const subscribers = topicSubscribers.get(topic);
            if (!subscribers || subscribers.size === 0) return;

            const jsonStr = JSON.stringify(payload);
            const msg = `event: ${topic}\ndata: ${jsonStr}\nid: ${eventId}\n\n`;

            for (const sub of Array.from(subscribers)) {
                if (isScoped && eventScope !== undefined && !sub.isOperator && eventScope !== sub.effectiveScope) {
                    continue;
                }
                try {
                    sub.res.write(msg);
                } catch {
                    // Ignore write error on dropped connection
                }
            }
        };

        const unsub = options.broker.on(topic, listener);
        if (typeof unsub === 'function') {
            topicUnsubscribers.set(topic, unsub);
        } else if (options.broker.off) {
            topicUnsubscribers.set(topic, () => {
                options.broker.off!(topic, listener);
            });
        }
    };

    for (const [topic, entry] of exposedMap.entries()) {
        ensureTopicSubscription(topic, entry);
    }

    router.get('/events', async (req: Request, res: Response): Promise<void> => {
        // 1. Extract requested topics
        let requestedTopics: string[] = [];
        const rawTopics = req.query['topics'];
        if (typeof rawTopics === 'string') {
            requestedTopics = rawTopics.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
        } else if (Array.isArray(rawTopics)) {
            requestedTopics = rawTopics
                .flatMap((t) => (typeof t === 'string' ? t.split(',') : []))
                .map((t) => t.trim())
                .filter((t) => t.length > 0);
        }

        if (requestedTopics.length === 0) {
            res.status(400).json({
                error: {
                    code: 'BAD_REQUEST',
                    message: 'Query parameter "topics" is required and cannot be empty.',
                },
            });
            return;
        }

        // 2. Filter requested topics against exposed events allowlist
        const activeEntries = new Map<string, ValidatedEventEntry>();

        for (const topic of requestedTopics) {
            const entry = exposedMap.get(topic);
            if (entry !== undefined) {
                activeEntries.set(topic, entry);
            }
        }

        // 3. Authorization & Tenancy Gating
        const session = req.session;
        const queryParams = (req.query ?? {}) as Record<string, unknown>;
        const requestedScope = extractRequestedScope(queryParams, req.params);
        const userScope = session?.user.tenant_id;
        const effectiveScope = userScope ?? requestedScope;
        const isOperator = session?.user.roles?.includes(ADMIN_ROLE) ?? false;

        for (const [topic, entry] of activeEntries.entries()) {
            if (options.authorize) {
                const authInput: AuthorizeInput = {
                    user: session?.user,
                    principal: session?.user.id,
                    userScope,
                    requestedScope,
                    permission: entry.permission,
                    auth: entry.auth,
                    contract: {
                        domain: topic.split('.')[0] ?? 'events',
                        action: topic.split('.')[1] ?? topic,
                        description: `Event stream for topic ${topic}`,
                        inputSchema: entry.schema ?? z.object({}),
                        outputSchema: entry.schema ?? z.object({}),
                        rest: { method: 'GET', path: '/events' },
                        print: () => topic,
                    },
                    input: queryParams,
                };

                const authResult = await options.authorize(authInput);
                if (typeof authResult === 'boolean') {
                    if (!authResult) {
                        const status = session ? 403 : 401;
                        const code = session ? 'FORBIDDEN' : 'UNAUTHENTICATED';
                        res.status(status).json({
                            error: { code, message: 'Access to event topic refused by authorization hook' },
                        });
                        return;
                    }
                } else if (!authResult.authorized) {
                    const status = authResult.status ?? (session ? 403 : 401);
                    const code = authResult.code ?? (status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN');
                    res.status(status).json({
                        error: { code, message: authResult.message },
                    });
                    return;
                }
            } else if (entry.auth === 'user') {
                if (!session) {
                    res.status(401).json({
                        error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
                    });
                    return;
                }
            } else if (entry.auth === 'admin') {
                if (!session) {
                    res.status(401).json({
                        error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
                    });
                    return;
                }
                if (!session.user.roles?.includes('admin')) {
                    res.status(403).json({
                        error: { code: 'FORBIDDEN', message: 'Insufficient privileges' },
                    });
                    return;
                }
            } else if (entry.permission) {
                if (!session) {
                    res.status(401).json({
                        error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
                    });
                    return;
                }
                res.status(403).json({
                    error: {
                        code: 'FORBIDDEN',
                        message: `Forbidden: No authorization hook configured to evaluate required permission '${entry.permission}'`,
                    },
                });
                return;
            }
        }

        // Cross-org scope verification when targeting foreign tenant
        if (userScope && requestedScope && requestedScope !== userScope && !isOperator) {
            res.status(403).json({
                error: {
                    code: 'FORBIDDEN',
                    message: `Caller is scoped to org '${userScope}' and cannot access org '${requestedScope}'`,
                },
            });
            return;
        }

        // 4. Set SSE Headers
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();

        // 5. Replay from buffer
        const rawLastId = req.headers['last-event-id'] ?? req.query['lastEventId'] ?? req.query['last_event_id'];
        const lastEventId = typeof rawLastId === 'string' && rawLastId.trim().length > 0 ? rawLastId.trim() : undefined;

        if (lastEventId) {
            const lastIndex = eventBuffer.findIndex((e) => e.id === lastEventId);
            if (lastIndex !== -1) {
                for (const evt of eventBuffer.slice(lastIndex + 1)) {
                    const entry = activeEntries.get(evt.topic);
                    if (entry !== undefined) {
                        const isScoped = entry.scope === 'org' || entry.scope === 'tenant' || (entry.scope !== undefined && entry.scope !== 'global');
                        if (isScoped && evt.scope !== undefined && !isOperator && evt.scope !== effectiveScope) {
                            continue;
                        }
                        res.write(`event: ${evt.topic}\ndata: ${JSON.stringify(evt.data)}\nid: ${evt.id}\n\n`);
                    }
                }
            }
        }

        // 6. Heartbeat interval
        const heartbeatMs = options.heartbeatIntervalMs ?? 15000;
        const heartbeatTimer = setInterval(() => {
            try {
                res.write(': keepalive\n\n');
            } catch {
                // Ignore
            }
        }, heartbeatMs);

        // 7. Register subscriber session
        const subscriberSession: SubscriberSession = {
            res,
            effectiveScope,
            isOperator,
        };

        for (const topic of activeEntries.keys()) {
            let set = topicSubscribers.get(topic);
            if (set === undefined) {
                set = new Set();
                topicSubscribers.set(topic, set);
            }
            set.add(subscriberSession);
        }

        // 8. Teardown on connection close
        let isClosed = false;
        const cleanup = (): void => {
            if (isClosed) return;
            isClosed = true;
            clearInterval(heartbeatTimer);

            for (const topic of activeEntries.keys()) {
                const set = topicSubscribers.get(topic);
                if (set !== undefined) {
                    set.delete(subscriberSession);
                }
            }

            try {
                res.end();
            } catch {
                // Ignore
            }
        };

        req.on('close', cleanup);
        req.on('end', cleanup);
        res.on('close', cleanup);
        res.on('finish', cleanup);
        req.on('error', cleanup);
        res.on('error', cleanup);
        req.socket?.on('close', cleanup);
        req.socket?.on('end', cleanup);
    });
}


