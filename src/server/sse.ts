/**
 * SSE: mesh events, out to a browser, scoped.
 *
 * mesh-web roadmap C3.4. Server-sent events rather than WebSockets for this direction because the
 * traffic is one-way — the mesh emits, the browser listens — and SSE reconnects on its own, passes
 * through proxies as ordinary HTTP, and needs no framing. WebSockets are the answer when the browser
 * needs to send too (C3.5), not a better version of this.
 *
 * The interesting part is not the protocol. It is spec/network.md §5.1: an event is emitted once to
 * the whole mesh and arrives at an instance holding connections for many users in many
 * organizations, and this file must decide, per subscriber, whether it is theirs. That decision
 * lives in `delivery.ts` as a pure function, and everything here is plumbing around it.
 */

import type { Request, Response, Router } from 'express';

import { describeEvent, type EventExposeEntry, type DescribedEvent } from '../exposure/events.js';
import { executeGate, SCOPE_HEADER, type AuthorizeHook, type Caller } from '../auth/gate.js';
import type { TicketCache } from '../auth/tickets.js';
import { decideDelivery, type Subscriber } from './delivery.js';
import type { ToolContract, z } from '@flybyme/mesh';

/** What this layer needs from a broker: to listen, and to stop listening. */
export interface EventSource {
    on(event: string, handler: (payload: unknown, packet?: unknown) => void): void;
    off(event: string, handler: (payload: unknown, packet?: unknown) => void): void;
}

export interface MountEventsOptions {
    readonly source: EventSource;
    readonly events: readonly EventExposeEntry[];
    readonly tickets: TicketCache;
    readonly authorize?: AuthorizeHook;
    readonly path?: string;
    readonly exposure?: string;
    /** How often to write a keepalive. Proxies drop an idle connection; this stops them. */
    readonly heartbeatMs?: number;
    /**
     * Told about every event that could not be delivered because its declared scope was unreadable.
     *
     * This is not a debug hook. An `unscopable` event means a contract and a payload disagree, and
     * the old implementation's response to that disagreement was to broadcast. Now it is silence —
     * which is safe, and invisible unless somebody is watching. So somebody watches.
     */
    readonly onUnscopable?: (event: string, payload: unknown) => void;
    readonly onSubscribe?: (event: string, subscriber: Subscriber) => void;
}

interface Connection {
    readonly res: Response;
    readonly subscriber: Subscriber;
    readonly ticket: string | undefined;
    readonly events: ReadonlySet<string>;
}

export const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * A synthetic contract, so an event stream can go through the same gate as a call.
 *
 * The gate wants a contract to name in its refusals. Rather than a second gate implementation for
 * events — which would be a second place for the rules to drift — an exposed event borrows the one
 * that already exists.
 */
const asContract = (name: string): ToolContract<z.ZodTypeAny, z.ZodTypeAny> => ({
    domain: 'events',
    action: name,
    description: `subscription to ${name}`,
} as unknown as ToolContract<z.ZodTypeAny, z.ZodTypeAny>);

export function mountEvents(router: Router, options: MountEventsOptions): {
    readonly close: () => void;
    readonly connections: () => number;
} {
    const described = new Map<string, DescribedEvent>();
    for (const entry of options.events) {
        const event = describeEvent(entry);
        if (described.has(event.name)) {
            throw new Error(`Event ${event.name} is exposed twice — two gates, and ordering would pick one.`);
        }
        described.set(event.name, event);
    }

    const connections = new Set<Connection>();
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    let sequence = 0;

    /** One mesh listener per exposed event, however many browsers are connected. */
    const listeners = new Map<string, (payload: unknown) => void>();

    for (const [name, event] of described) {
        const listener = (payload: unknown): void => {
            sequence += 1;
            const id = `e${sequence}`;
            let unscopable = false;

            for (const connection of connections) {
                if (!connection.events.has(name)) continue;

                const decision = decideDelivery(event, payload, connection.subscriber);
                if (!decision.deliver) {
                    if (decision.reason === 'unscopable') unscopable = true;
                    continue;
                }

                write(connection.res, { event: name, id, data: payload });
            }

            // Reported once per event rather than once per subscriber: it is a fact about the
            // payload, not about who missed it.
            if (unscopable) options.onUnscopable?.(name, payload);
        };

        listeners.set(name, listener);
        options.source.on(name, listener);
    }

    router.get(options.path ?? '/events', (req, res) => {
        void open(req, res);
    });

    async function open(req: Request, res: Response): Promise<void> {
        if (options.exposure !== undefined) res.setHeader('x-exposure', options.exposure);

        const requested = requestedEvents(req, described);
        if (requested.length === 0) {
            res.status(400).json({
                error: 'NO_EVENTS',
                message: `Name at least one exposed event: ?events=${[...described.keys()].join(',')}`,
            });
            return;
        }

        const unknown = requested.filter((name) => !described.has(name));
        if (unknown.length > 0) {
            // 404 rather than silently subscribing to nothing: a browser listening to an event name
            // that will never arrive looks identical to a quiet system.
            res.status(404).json({ error: 'NOT_FOUND', message: `Not exposed: ${unknown.join(', ')}` });
            return;
        }

        const ticket = bearer(req);
        const caller: Caller | undefined = await options.tickets.resolve(ticket);

        // Every requested event is gated separately, and the *whole* subscription is refused if any
        // one of them is. Partial success would leave a browser believing it is subscribed to a
        // stream it will never receive.
        let scope: string | undefined;
        for (const name of requested) {
            const event = described.get(name)!;
            const outcome = await executeGate({
                gate: event.gate,
                contract: asContract(name),
                caller,
                requestedScope: header(req, SCOPE_HEADER),
                input: {},
                ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
            });

            if (!outcome.ok) {
                res.status(outcome.status).json({ error: outcome.code, message: outcome.message });
                return;
            }
            scope = outcome.scope ?? scope;
        }

        const subscriber: Subscriber = {
            userId: caller?.userId ?? 'anonymous',
            scope,
            // An operator is one the coarse gate admitted to an admin-gated stream — a decision in
            // the exposure list, not a role checked here.
            operator: caller !== undefined
                && requested.every((n) => {
                    const g = described.get(n)!.gate;
                    return g.kind === 'auth' && g.level === 'admin';
                })
                && caller.roles.includes('admin'),
        };

        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            // Nginx buffers text/event-stream by default, which turns a live stream into a stream
            // that arrives in one lump when the connection closes.
            'x-accel-buffering': 'no',
        });
        res.write(': open\n\n');

        const connection: Connection = { res, subscriber, ticket, events: new Set(requested) };
        connections.add(connection);
        options.onSubscribe?.(requested.join(','), subscriber);

        const heartbeat = setInterval(() => {
            try {
                res.write(': keepalive\n\n');
            } catch {
                // A write to a dead socket is not an error worth propagating; `close` will fire.
            }
        }, heartbeatMs);

        // A subscription outlives the request that opened it, so authorization cannot be assumed for
        // the life of the connection (spec/network.md §5.1). The ticket cache learns about
        // revocation by event; re-resolving on the heartbeat is how that reaches a stream that is
        // already open.
        const recheck = ticket === undefined ? undefined : setInterval(() => {
            void options.tickets.resolve(ticket).then((still) => {
                if (still === undefined) {
                    write(res, { event: 'subscription.revoked', id: 'revoked', data: { reason: 'ticket no longer valid' } });
                    res.end();
                }
            });
        }, heartbeatMs);

        const cleanup = (): void => {
            clearInterval(heartbeat);
            if (recheck !== undefined) clearInterval(recheck);
            connections.delete(connection);
        };

        req.on('close', cleanup);
        res.on('close', cleanup);
    }

    return {
        close(): void {
            for (const [name, listener] of listeners) options.source.off(name, listener);
            for (const connection of connections) connection.res.end();
            connections.clear();
        },
        connections: () => connections.size,
    };
}

function write(res: Response, message: { event: string; id: string; data: unknown }): void {
    try {
        res.write(`event: ${message.event}\nid: ${message.id}\ndata: ${JSON.stringify(message.data)}\n\n`);
    } catch {
        // The socket went away between the delivery decision and the write. Nothing to do: the
        // close handler removes the connection.
    }
}

function requestedEvents(req: Request, described: ReadonlyMap<string, DescribedEvent>): string[] {
    const raw = req.query['events'];
    const value = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : '';
    const named = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
    // No `?events=` at all means every exposed event — each still gated individually below.
    return named.length > 0 ? named : [...described.keys()];
}

function bearer(req: Request): string | undefined {
    const value = header(req, 'authorization');
    const match = value === undefined ? null : /^Bearer\s+(.+)$/i.exec(value);
    return match?.[1]?.trim();
}

function header(req: Request, name: string): string | undefined {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value === undefined || value.trim() === '' ? undefined : value.trim();
}
