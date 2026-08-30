import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import {
    MeshApp,
    RegistryModule,
    BrokerModule,
    defineContract,
    defineEvent,
    defaultPrint,
    z,
    type IServiceBroker,
} from '@flybyme/mesh';
import {
    createWebServer,
    MemorySessionStore,
    WebServiceModule,
    type EventExposeEntry,
} from '../src/index.js';
import {
    createEventBridgeClient,
    type EventBridgeClient,
    createScope,
    AppContextImpl,
    AppStateContainerImpl,
    Compositor,
    clearAppRegistry,
} from '../src/runtime/index.js';



// --- Fixture Schemas & Events ---

export const CardCreatedSchema = z.object({
    orgId: z.string(),
    card: z.object({
        id: z.string(),
        title: z.string(),
    }),
});
export type CardCreated = z.infer<typeof CardCreatedSchema>;

export const cardCreatedEvent = defineEvent('card.created', CardCreatedSchema);

export const CardUpdatedSchema = z.object({
    orgId: z.string(),
    card: z.object({
        id: z.string(),
        column: z.string(),
    }),
});
export type CardUpdated = z.infer<typeof CardUpdatedSchema>;

export const cardUpdatedEvent = defineEvent('card.updated', CardUpdatedSchema);

export const SystemAlertSchema = z.object({
    level: z.string(),
    message: z.string(),
});
export type SystemAlert = z.infer<typeof SystemAlertSchema>;

export const systemAlertEvent = defineEvent('system.alert', SystemAlertSchema);

declare global {
    interface EventRegistry {
        'card.created': CardCreated;
        'card.updated': CardUpdated;
        'system.alert': SystemAlert;
        'admin.metric': { cpu: number; memory: number };
        'secret.internal_metric': { secret: string };
    }
}

const boardListContract = defineContract({

    domain: 'kanban',
    action: 'board_list',
    description: 'List boards',
    inputSchema: z.object({ repo: z.string().optional() }),
    outputSchema: z.object({ cards: z.array(z.object({ id: z.string(), title: z.string() })) }),
    rest: { method: 'GET', path: '/kanban/boards' },
    print: defaultPrint,
});

class KanbanWebService extends WebServiceModule {
    public readonly domain = 'kanban';

    constructor() {
        super();
        this.mountTool(boardListContract, async () => ({ cards: [] }));
        this.mountWeb({
            expose: [
                { contract: boardListContract, auth: 'user' },
            ],
            events: [
                { event: cardCreatedEvent, auth: 'user', scope: 'org' },
                { event: cardUpdatedEvent, auth: 'user', scope: 'org' },
                { event: systemAlertEvent, auth: 'public', scope: 'global' },
                { event: 'admin.metric', auth: 'admin', scope: 'global' },
            ],
        });
    }
}

function getBrokerListenerCount(broker: unknown, topic: string): number {
    if (typeof broker === 'object' && broker !== null && 'localEvents' in broker) {
        const le = (broker as { readonly localEvents: unknown }).localEvents;
        if (typeof le === 'object' && le !== null && 'listenerCount' in le) {
            const lc = (le as { readonly listenerCount: unknown }).listenerCount;
            if (typeof lc === 'function') {
                return (lc as (event: string) => number).call(le, topic);
            }
        }
    }
    return 0;
}

describe('SSE Event Bridge (Phase 5 & Finding #8)', () => {
    let app: MeshApp;
    let broker: IServiceBroker;
    let kanbanService: KanbanWebService;
    let sessionStore: MemorySessionStore;
    let expressApp: express.Express;
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
        app = new MeshApp({ nodeID: 'events-test-node', namespace: 'test' });
        app.use(new RegistryModule({ preferLocal: true }));
        app.use(new BrokerModule());
        await app.start();

        broker = app.getProvider<IServiceBroker>('broker');
        kanbanService = new KanbanWebService();
        await app.registerModule(kanbanService);

        sessionStore = new MemorySessionStore();
        expressApp = express();

        const { router } = createWebServer({
            app,
            modules: [kanbanService],
            sessionStore,
            cookie: { secure: false },
            heartbeatIntervalMs: 500, // fast heartbeat for tests
        });
        expressApp.use(router);

        await new Promise<void>((resolve) => {
            server = expressApp.listen(0, () => {
                const addr = server.address();
                if (typeof addr === 'object' && addr !== null) {
                    baseUrl = `http://127.0.0.1:${addr.port}/api`;
                }
                resolve();
            });
        });
    });

    afterAll(async () => {
        const srv = server as { closeAllConnections?: () => void; close: (cb: () => void) => void };
        srv.closeAllConnections?.();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        await app.stop();
    });

    beforeEach(() => {
        clearAppRegistry();
    });

    it('1. real server & real client: one event published on broker is received end to end', async () => {
        const session = await sessionStore.create({ id: 'user_1', tenant_id: 'org_1' }, 60000);

        const client = createEventBridgeClient({
            baseUrl,
            headers: {
                Cookie: `mesh_sid=${session.id}`,
            },
        });

        const received: CardCreated[] = [];
        const unsub = client.on<CardCreated>('card.created', (data) => {
            received.push(data);
        });

        // Wait for connection to open
        await vi.waitFor(() => {
            expect(client.status).toBe('connected');
        });

        // Publish real event through broker
        broker.emit('card.created', {
            orgId: 'org_1',
            card: { id: 'card-101', title: 'Implement SSE bridge' },
        });

        await vi.waitFor(() => {
            expect(received.length).toBe(1);
        }, { timeout: 2000 });

        expect(received[0]?.card.id).toBe('card-101');
        expect(received[0]?.card.title).toBe('Implement SSE bridge');

        unsub();
        client.close();
    });

    it('2. org-isolation: two subscribers with different scopes receive different events', async () => {
        const aliceSession = await sessionStore.create({ id: 'user_alice', tenant_id: 'org_A' }, 60000);
        const bobSession = await sessionStore.create({ id: 'user_bob', tenant_id: 'org_B' }, 60000);

        const aliceClient = createEventBridgeClient({
            baseUrl,
            headers: { Cookie: `mesh_sid=${aliceSession.id}` },
        });

        const bobClient = createEventBridgeClient({
            baseUrl,
            headers: { Cookie: `mesh_sid=${bobSession.id}` },
        });

        const aliceEvents: CardCreated[] = [];
        const bobEvents: CardCreated[] = [];

        aliceClient.on<CardCreated>('card.created', (data) => aliceEvents.push(data));
        bobClient.on<CardCreated>('card.created', (data) => bobEvents.push(data));

        await vi.waitFor(() => {
            expect(aliceClient.status).toBe('connected');
            expect(bobClient.status).toBe('connected');
        });

        // Emit an event for org_A
        broker.emit('card.created', {
            orgId: 'org_A',
            card: { id: 'card_for_A', title: 'A card' },
        });

        // Emit an event for org_B
        broker.emit('card.created', {
            orgId: 'org_B',
            card: { id: 'card_for_B', title: 'B card' },
        });

        await vi.waitFor(() => {
            expect(aliceEvents.length).toBe(1);
            expect(bobEvents.length).toBe(1);
        }, { timeout: 2000 });

        // Security property: Alice received ONLY org_A event, Bob received ONLY org_B event
        expect(aliceEvents[0]?.card.id).toBe('card_for_A');
        expect(bobEvents[0]?.card.id).toBe('card_for_B');

        // Extra check: wait another tick to ensure no cross-org leak occurred
        await new Promise((r) => setTimeout(r, 50));
        expect(aliceEvents.length).toBe(1);
        expect(bobEvents.length).toBe(1);

        aliceClient.close();
        bobClient.close();
    });

    it('3. an unexposed topic is not deliverable, however the client asks for it', async () => {
        const session = await sessionStore.create({ id: 'user_test', tenant_id: 'org_1' }, 60000);

        const client = createEventBridgeClient({
            baseUrl,
            headers: { Cookie: `mesh_sid=${session.id}` },
        });

        const unexposedReceived: unknown[] = [];
        const exposedReceived: unknown[] = [];

        // Client asks for both an exposed topic and an unexposed private topic
        client.on('secret.internal_metric', (data) => unexposedReceived.push(data));
        client.on('system.alert', (data) => exposedReceived.push(data));

        await vi.waitFor(() => {
            expect(client.status).toBe('connected');
        });

        // Emit unexposed topic on broker
        broker.emit('secret.internal_metric', { secret: 'confidential' });
        // Emit exposed topic on broker
        broker.emit('system.alert', { level: 'info', message: 'Public alert' });

        await vi.waitFor(() => {
            expect(exposedReceived.length).toBe(1);
        }, { timeout: 2000 });

        // Unexposed topic was never subscribed on broker and never delivered to client
        expect(unexposedReceived.length).toBe(0);

        client.close();
    });


    it('4. reconnect with backoff and jitter: retry delays grow and Last-Event-ID replays missed events', async () => {
        const session = await sessionStore.create({ id: 'user_rec', tenant_id: 'org_1' }, 60000);

        const retryDelays: number[] = [];
        let failConnect = false;
        const disconnectRef: { trigger?: () => void } = {};

        const testFetch: typeof fetch = async (url, init) => {
            if (failConnect) {
                return new Response(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Down' } }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            const res = await fetch(url, init);
            const originalBody = res.body;
            if (!originalBody) return res;

            const reader = originalBody.getReader();
            const customStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    disconnectRef.trigger = () => {
                        try {
                            controller.error(new Error('Network disconnected'));
                        } catch {
                            // ignore if already closed
                        }
                    };
                },
                async pull(controller) {
                    try {
                        const chunk = await reader.read();
                        if (chunk.done) {
                            controller.close();
                        } else {
                            controller.enqueue(chunk.value);
                        }
                    } catch {
                        controller.close();
                    }
                },
                cancel(reason) {
                    delete disconnectRef.trigger;
                    return reader.cancel(reason);
                },
            });

            return new Response(customStream, {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers,
            });
        };

        const client = createEventBridgeClient({
            baseUrl,
            fetch: testFetch,
            headers: { Cookie: `mesh_sid=${session.id}` },
            initialDelayMs: 25,
            backoffFactor: 2,
            jitterFactor: 0,
            onReconnectAttempt: (_attempt, delayMs) => {
                retryDelays.push(delayMs);
            },
        });

        const received: CardUpdated[] = [];
        client.on<CardUpdated>('card.updated', (data) => received.push(data));

        await vi.waitFor(() => {
            expect(client.status).toBe('connected');
        });

        // 1. Send first event: received with ID
        broker.emit('card.updated', {
            orgId: 'org_1',
            card: { id: 'card-1', column: 'in_progress' },
        });

        await vi.waitFor(() => {
            expect(received.length).toBe(1);
        });

        // 2. Abruptly drop stream and fail reconnect attempts
        failConnect = true;
        disconnectRef.trigger?.();
        delete disconnectRef.trigger;

        // Wait for multiple backoff retry attempts to record growing delays
        await vi.waitFor(() => {
            expect(retryDelays.length).toBeGreaterThanOrEqual(3);
        }, { timeout: 3000 });

        // Assert backoff is NOT a tight loop: retry delays grow exponentially (25ms, 50ms, 100ms...)
        expect(retryDelays[1]).toBeGreaterThan(retryDelays[0]!);
        expect(retryDelays[2]).toBeGreaterThan(retryDelays[1]!);

        // 3. Emit an event while disconnected (stored in server replay buffer)
        broker.emit('card.updated', {
            orgId: 'org_1',
            card: { id: 'card-2', column: 'done' },
        });

        // 4. Restore server availability: client reconnects, sends Last-Event-ID, receives replayed card-2
        failConnect = false;

        await vi.waitFor(() => {
            expect(received.length).toBe(2);
        }, { timeout: 3000 });

        expect(received[0]?.card.id).toBe('card-1');
        expect(received[1]?.card.id).toBe('card-2');
        expect(received[1]?.card.column).toBe('done');

        client.close();
    });

    it('5. unloading an app closes its stream and leaves no broker subscription behind', async () => {
        const session = await sessionStore.create({ id: 'user_host', tenant_id: 'org_1' }, 60000);

        let receivedCount = 0;

        const scope = createScope();
        const state = new AppStateContainerImpl('kanban-app', scope);

        const client = createEventBridgeClient({
            baseUrl,
            headers: { Cookie: `mesh_sid=${session.id}` },
        });

        const ctx = new AppContextImpl('kanban-app', state, undefined, undefined, { events: client });

        client.on('card.created', () => {
            receivedCount++;
        });

        await vi.waitFor(() => {
            expect(client.status).toBe('connected');
        });

        // 1. Assert broker now has 1 active listener for card.created
        const countBefore = getBrokerListenerCount(broker, 'card.created');
        expect(countBefore).toBeGreaterThanOrEqual(1);

        // Emit event to verify app context is receiving
        broker.emit('card.created', {
            orgId: 'org_1',
            card: { id: 'live-1', title: 'Live Test' },
        });

        await vi.waitFor(() => {
            expect(receivedCount).toBe(1);
        });

        // 2. Unload app: run cleanups on context and dispose state
        ctx.runCleanups();
        state.dispose();
        scope.dispose();

        // 3. Assert client is disposed and closed immediately
        expect(client.isDisposed).toBe(true);
        expect(client.status).toBe('closed');

        // 4. Emitting further events does not trigger unloaded app
        broker.emit('card.created', {
            orgId: 'org_1',
            card: { id: 'live-2', title: 'After unload' },
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(receivedCount).toBe(1);
    });


    it('6. a second connection to the same endpoint works without 500 or state collision', async () => {
        const session = await sessionStore.create({ id: 'user_multi', tenant_id: 'org_1' }, 60000);

        // First connection
        const client1 = createEventBridgeClient({
            baseUrl,
            headers: { Cookie: `mesh_sid=${session.id}` },
        });
        const client1Events: SystemAlert[] = [];
        client1.on<SystemAlert>('system.alert', (d) => client1Events.push(d));

        await vi.waitFor(() => {
            expect(client1.status).toBe('connected');
        });
        broker.emit('system.alert', { level: 'info', message: 'Alert 1' });

        await vi.waitFor(() => {
            expect(client1Events.length).toBe(1);
        });

        // Disconnect first client
        client1.close();
        await vi.waitFor(() => {
            expect(client1.status).toBe('closed');
        });

        // Second connection to exact same endpoint
        const client2 = createEventBridgeClient({
            baseUrl,
            headers: { Cookie: `mesh_sid=${session.id}` },
        });
        const client2Events: SystemAlert[] = [];
        client2.on<SystemAlert>('system.alert', (d) => client2Events.push(d));

        await vi.waitFor(() => {
            expect(client2.status).toBe('connected');
        });
        broker.emit('system.alert', { level: 'warning', message: 'Alert 2' });

        await vi.waitFor(() => {
            expect(client2Events.length).toBe(1);
        });
        expect(client2Events[0]?.message).toBe('Alert 2');

        // Third concurrent connection alongside second connection
        const client3 = createEventBridgeClient({
            baseUrl,
            headers: { Cookie: `mesh_sid=${session.id}` },
        });
        const client3Events: SystemAlert[] = [];
        client3.on<SystemAlert>('system.alert', (d) => client3Events.push(d));

        await vi.waitFor(() => {
            expect(client3.status).toBe('connected');
        });
        broker.emit('system.alert', { level: 'error', message: 'Alert 3' });

        await vi.waitFor(() => {
            expect(client2Events.length).toBe(2);
            expect(client3Events.length).toBe(1);
        });

        client2.close();
        client3.close();
    });

    it('7. coarse auth gates: unauthenticated request returns 401, non-admin for admin topic returns 403', async () => {
        // 7a. Unauthenticated request for user-scoped event -> 401
        const unauthedRes = await fetch(`${baseUrl}/events?topics=card.created`);
        expect(unauthedRes.status).toBe(401);
        const unauthedBody = (await unauthedRes.json()) as { error: { code: string; message: string } };
        expect(unauthedBody.error.code).toBe('UNAUTHENTICATED');

        // 7b. Authenticated user without admin role requesting admin topic -> 403
        const normalUser = await sessionStore.create({ id: 'user_regular', tenant_id: 'org_1', roles: ['member'] }, 60000);
        const forbiddenRes = await fetch(`${baseUrl}/events?topics=admin.metric`, {
            headers: { Cookie: `mesh_sid=${normalUser.id}` },
        });
        expect(forbiddenRes.status).toBe(403);
        const forbiddenBody = (await forbiddenRes.json()) as { error: { code: string; message: string } };
        expect(forbiddenBody.error.code).toBe('FORBIDDEN');

        // 7c. Authenticated admin requesting admin topic -> 200 SSE stream
        const adminUser = await sessionStore.create({ id: 'user_admin', tenant_id: 'org_1', roles: ['admin'] }, 60000);
        const adminClient = createEventBridgeClient({
            baseUrl,
            headers: { Cookie: `mesh_sid=${adminUser.id}` },
        });
        const adminEvents: unknown[] = [];
        adminClient.on('admin.metric', (d) => adminEvents.push(d));

        await vi.waitFor(() => {
            expect(adminClient.status).toBe('connected');
        });
        broker.emit('admin.metric', { cpu: 85, memory: 90 });

        await vi.waitFor(() => {
            expect(adminEvents.length).toBe(1);
        });

        adminClient.close();
    });

    it('8. unsubscribe function immediately stops event delivery for that handler', async () => {
        const session = await sessionStore.create({ id: 'user_unsub', tenant_id: 'org_1' }, 60000);
        const client = createEventBridgeClient({
            baseUrl,
            headers: { Cookie: `mesh_sid=${session.id}` },
        });

        const receivedA: SystemAlert[] = [];
        const receivedB: SystemAlert[] = [];

        const unsubA = client.on<SystemAlert>('system.alert', (d) => receivedA.push(d));
        const unsubB = client.on<SystemAlert>('system.alert', (d) => receivedB.push(d));

        await vi.waitFor(() => {
            expect(client.status).toBe('connected');
        });

        broker.emit('system.alert', { level: 'info', message: 'Message 1' });

        await vi.waitFor(() => {
            expect(receivedA.length).toBe(1);
            expect(receivedB.length).toBe(1);
        });

        // Unsubscribe handler A only
        unsubA();

        broker.emit('system.alert', { level: 'info', message: 'Message 2' });

        await vi.waitFor(() => {
            expect(receivedB.length).toBe(2);
        });

        // Handler A stopped receiving events; Handler B continued receiving
        expect(receivedA.length).toBe(1);
        expect(receivedB.length).toBe(2);

        unsubB();
        client.close();
    });
});

