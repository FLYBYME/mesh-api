/**
 * SSE, over real HTTP.
 *
 * The delivery *decision* is tested exhaustively and in isolation in `delivery.test.ts`. What is
 * tested here is that the decision is actually the one the stream obeys — two browsers connected at
 * once, in different organizations, watching the same event fire.
 *
 * That combination is the one that matters: the leak in `archive/pre-rewrite` was not a wrong
 * decision, it was a correct-looking decision applied to a payload nobody had checked, in a loop over
 * every connection.
 */

import express, { Router } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
    createTicketCache, mountEvents,
    type Caller, type EventExposeEntry, type EventSource, type Subscriber,
} from '../src/index.js';

// ---------------------------------------------------------------------------- a mesh, in a Map

function fakeMesh(): EventSource & { emit: (event: string, payload: unknown) => void; listeners: number } {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    return {
        on(event, handler) {
            const set = handlers.get(event) ?? new Set();
            set.add(handler);
            handlers.set(event, set);
        },
        off(event, handler) {
            handlers.get(event)?.delete(handler);
        },
        emit(event, payload) {
            for (const handler of handlers.get(event) ?? []) handler(payload);
        },
        get listeners() {
            return [...handlers.values()].reduce((n, set) => n + set.size, 0);
        },
    };
}

const alice: Caller = { userId: 'u-alice', roles: [] };
const bob: Caller = { userId: 'u-bob', roles: [] };

const memberships: Record<string, string> = { 'u-alice': 'org-a', 'u-bob': 'org-b' };

const events: readonly EventExposeEntry[] = [
    { event: 'credential.created', permission: 'credential.read', scope: { field: 'organizationId' } },
    { event: 'mesh.started', auth: 'public', scope: 'global' },
];

interface Harness {
    readonly url: string;
    readonly mesh: ReturnType<typeof fakeMesh>;
    readonly unscopable: { event: string; payload: unknown }[];
    readonly connections: () => number;
    close(): Promise<void>;
}

let harnesses: Harness[] = [];

afterEach(async () => {
    for (const h of harnesses) await h.close();
    harnesses = [];
});

async function serve(over: { events?: readonly EventExposeEntry[] } = {}): Promise<Harness> {
    const mesh = fakeMesh();
    const unscopable: { event: string; payload: unknown }[] = [];

    const tickets = createTicketCache({
        validate: async (ticket) => {
            const caller = ticket === 'alice' ? alice : ticket === 'bob' ? bob : undefined;
            return caller === undefined ? { valid: false } : { valid: true, caller };
        },
    });

    const router = Router();
    const mounted = mountEvents(router, {
        source: mesh,
        events: over.events ?? events,
        tickets,
        heartbeatMs: 50,
        authorize: ({ caller }) => {
            if (caller === undefined) return { authorized: true };
            const scope = memberships[caller.userId];
            return scope === undefined
                ? { authorized: false, status: 403, code: 'NO_ORGANIZATION', message: 'no organization' }
                : { authorized: true, resolvedScope: scope };
        },
        onUnscopable: (event, payload) => unscopable.push({ event, payload }),
    });

    const app = express().use('/api', router);
    const server: Server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    const harness: Harness = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`,
        mesh,
        unscopable,
        connections: mounted.connections,
        close: () => new Promise((resolve) => {
            mounted.close();
            server.close(() => resolve());
        }),
    };

    harnesses.push(harness);
    return harness;
}

/** A browser holding an SSE connection, collecting what it is sent. */
async function subscribe(url: string, ticket: string, query = ''): Promise<{
    readonly received: { event: string; data: unknown }[];
    readonly status: number;
    close(): void;
}> {
    const controller = new AbortController();
    const response = await fetch(`${url}${query}`, {
        headers: { authorization: `Bearer ${ticket}` },
        signal: controller.signal,
    });

    const received: { event: string; data: unknown }[] = [];

    if (response.ok && response.body !== null) {
        void (async () => {
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });

                    let split: number;
                    while ((split = buffer.indexOf('\n\n')) !== -1) {
                        const frame = buffer.slice(0, split);
                        buffer = buffer.slice(split + 2);
                        const event = /^event: (.+)$/m.exec(frame)?.[1];
                        const data = /^data: (.+)$/m.exec(frame)?.[1];
                        if (event !== undefined && data !== undefined) {
                            received.push({ event, data: JSON.parse(data) });
                        }
                    }
                }
            } catch {
                // Aborted by close(). Expected.
            }
        })();
    }

    return { received, status: response.status, close: () => controller.abort() };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

// ---------------------------------------------------------------------------- the tests

describe('two browsers, two organizations, one event', () => {
    it('delivers only to the organization the event belongs to', async () => {
        const h = await serve();
        const a = await subscribe(h.url, 'alice', '?events=credential.created');
        const b = await subscribe(h.url, 'bob', '?events=credential.created');
        await settle();

        h.mesh.emit('credential.created', { id: 'c1', organizationId: 'org-a', name: 'prod' });
        await settle();

        expect(a.received.map((m) => m.event)).toEqual(['credential.created']);
        // The whole point. bob is connected, subscribed, and authorized for this event — and it is
        // not his organization's, so he does not get it.
        expect(b.received).toEqual([]);

        a.close();
        b.close();
    });

    it('delivers a global event to both', async () => {
        const h = await serve();
        const a = await subscribe(h.url, 'alice', '?events=mesh.started');
        const b = await subscribe(h.url, 'bob', '?events=mesh.started');
        await settle();

        h.mesh.emit('mesh.started', { nodeID: 'n1' });
        await settle();

        expect(a.received).toHaveLength(1);
        expect(b.received).toHaveLength(1);

        a.close();
        b.close();
    });

    it('delivers an unscopable event to nobody, and says so', async () => {
        const h = await serve();
        const a = await subscribe(h.url, 'alice', '?events=credential.created');
        const b = await subscribe(h.url, 'bob', '?events=credential.created');
        await settle();

        // Declared `organizationId`; the payload says `org`. In archive/pre-rewrite this went to
        // every connected browser in every organization.
        h.mesh.emit('credential.created', { id: 'c1', org: 'org-a', name: 'prod' });
        await settle();

        expect(a.received).toEqual([]);
        expect(b.received).toEqual([]);

        // Silence is safe and invisible, so it is reported. A contract and a payload disagreeing is
        // a bug someone has to be told about.
        expect(h.unscopable).toEqual([
            { event: 'credential.created', payload: { id: 'c1', org: 'org-a', name: 'prod' } },
        ]);

        a.close();
        b.close();
    });
});

describe('subscribing', () => {
    it('refuses an unknown ticket at the gate', async () => {
        const h = await serve();
        const forged = await subscribe(h.url, 'forged', '?events=credential.created');
        expect(forged.status).toBe(401);
    });

    it('404s an event that is not exposed', async () => {
        const h = await serve();
        // Rather than subscribing to nothing: a browser waiting for an event that will never arrive
        // looks exactly like a quiet system.
        const missing = await subscribe(h.url, 'alice', '?events=credential.created,secret.thing');
        expect(missing.status).toBe(404);
    });

    it('refuses the whole subscription if any one event is refused', async () => {
        const h = await serve({
            events: [
                { event: 'mesh.started', auth: 'public', scope: 'global' },
                { event: 'ops.audit', auth: 'admin', scope: 'global' },
            ],
        });

        // Partial success would leave the browser believing it is subscribed to `ops.audit`.
        const partial = await subscribe(h.url, 'alice', '?events=mesh.started,ops.audit');
        expect(partial.status).toBe(403);
    });

    it('holds one mesh listener however many browsers connect', async () => {
        const h = await serve();
        expect(h.mesh.listeners).toBe(2); // one per exposed event

        const a = await subscribe(h.url, 'alice');
        const b = await subscribe(h.url, 'bob');
        await settle();

        expect(h.connections()).toBe(2);
        expect(h.mesh.listeners).toBe(2);

        a.close();
        b.close();
    });

    it('forgets a connection that goes away', async () => {
        const h = await serve();
        const a = await subscribe(h.url, 'alice', '?events=mesh.started');
        await settle();
        expect(h.connections()).toBe(1);

        a.close();
        await settle();

        expect(h.connections()).toBe(0);
    });
});

describe('a subscription does not outlive its authorization', () => {
    it('closes a stream whose ticket was revoked', async () => {
        const mesh = fakeMesh();
        let aliceValid = true;

        const tickets = createTicketCache({
            validate: async (ticket) =>
                ticket === 'alice' && aliceValid ? { valid: true, caller: alice } : { valid: false },
            ttlMs: 10,
        });

        const router = Router();
        const mounted = mountEvents(router, {
            source: mesh,
            events,
            tickets,
            heartbeatMs: 30,
            authorize: ({ caller }) => ({ authorized: true, resolvedScope: caller ? memberships[caller.userId] : undefined }),
        });

        const app = express().use('/api', router);
        const server: Server = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/events`;

        const a = await subscribe(url, 'alice', '?events=mesh.started');
        await settle();
        expect(mounted.connections()).toBe(1);

        // Revoked upstream. A subscription outlives the request that opened it, so authorization is
        // re-checked rather than assumed for the life of the connection.
        aliceValid = false;
        tickets.revoke('alice');
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(a.received.at(-1)?.event).toBe('subscription.revoked');
        expect(mounted.connections()).toBe(0);

        a.close();
        mounted.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
});
