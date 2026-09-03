/**
 * The `api` ServiceModule, against a real mesh.
 *
 * mesh-web roadmap C3.1b. Every other test in this repository runs against something I wrote: the
 * broker was a `Map`, identity was a string comparison, and the event bus was
 * `Map<string, Set<handler>>`. A fake never disagrees with you about a contract's shape, never
 * validates an input you got wrong, and never returns a document whose fields are not the ones you
 * imagined.
 *
 * So this file boots an actual `MeshApp`, registers an actual `IServiceModule` beside the api
 * module, and drives real HTTP through the real broker. What it is checking is not "does express
 * work" — it is whether the seams I designed against fakes survive contact with the thing they were
 * designed for.
 */

import { MeshApp, BrokerModule, RegistryModule, defineContract, z } from '@flybyme/mesh';
import type { IServiceBroker, IServiceContext, IServiceModule, ToolContract } from '@flybyme/mesh';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createApiModule, type ApiModule, type ExposeEntry } from '../src/index.js';

// ---------------------------------------------------------------------------- a real domain module

const whoamiContract = defineContract({
    domain: 'identity',
    action: 'whoami',
    description: 'Who is calling, and in which organization.',
    inputSchema: z.object({}),
    outputSchema: z.object({ userId: z.string(), organization: z.string().nullable() }),
    rest: { method: 'GET', path: '/identity/whoami' },
    visibility: 'public',
    print: String,
});

const listCredentialsContract = defineContract({
    domain: 'credential',
    action: 'list',
    description: 'Credentials in the calling organization.',
    inputSchema: z.object({ limit: z.number().optional() }),
    outputSchema: z.object({ items: z.array(z.object({ id: z.string(), organizationId: z.string() })) }),
    rest: { method: 'GET', path: '/credential' },
    visibility: 'public',
    print: String,
});

const validateTicketContract = defineContract({
    domain: 'identity',
    action: 'ticket_validate',
    description: 'Is this ticket valid, and whose is it.',
    inputSchema: z.object({ ticket: z.string() }),
    outputSchema: z.object({ valid: z.boolean(), userId: z.string().optional(), roles: z.array(z.string()).optional() }),
    rest: { method: 'POST', path: '/internal/ticket/validate' },
    print: String,
});

const tickets: Record<string, { userId: string; roles: string[] }> = {
    'alice-ticket': { userId: 'u-alice', roles: [] },
};

const memberships: Record<string, string> = { 'u-alice': 'org-a', 'u-bob': 'org-b' };

const credentials = [
    { id: 'c1', organizationId: 'org-a' },
    { id: 'c2', organizationId: 'org-b' },
];

/** A domain module, duck-typed exactly as the api module is. */
function domainModule(): IServiceModule {
    const contracts = [whoamiContract, listCredentialsContract, validateTicketContract] as unknown as
        ToolContract<z.ZodTypeAny, z.ZodTypeAny>[];

    return {
        domain: 'identity',
        getContracts: () => contracts,
        isCrud: () => false,
        getEventHandlers: () => new Map(),
        async beforeCrud(_d, _a, input) { return input; },
        async afterCrud(_d, _a, output) { return output; },

        async execute(domain: string, action: string, input: unknown, ctx: IServiceContext): Promise<unknown> {
            const key = `${domain}.${action}`;
            // The scope the API resolved, arriving the way any handler would read it.
            const scope = (ctx.meta as { user?: { tenant_id?: string } } | undefined)?.user?.tenant_id;
            const userId = (ctx.meta as { user?: { id?: string } } | undefined)?.user?.id;

            if (key === 'identity.ticket_validate') {
                const ticket = (input as { ticket: string }).ticket;
                const found = tickets[ticket];
                return found === undefined ? { valid: false } : { valid: true, ...found };
            }

            if (key === 'identity.whoami') {
                return { userId: userId ?? 'anonymous', organization: scope ?? null };
            }

            if (key === 'credential.list') {
                // Confined to the caller's scope, which is what beforeCrud does for real CRUD.
                return { items: credentials.filter((c) => c.organizationId === scope) };
            }

            throw new Error(`no such action ${key}`);
        },
    };
}

// ---------------------------------------------------------------------------- boot

const expose: readonly ExposeEntry[] = [
    { contract: whoamiContract as unknown as ExposeEntry['contract'], auth: 'user' },
    { contract: listCredentialsContract as unknown as ExposeEntry['contract'], permission: 'credential.read' },
];

interface Node {
    readonly app: MeshApp;
    readonly module: ApiModule;
    readonly url: string;
    stop(): Promise<void>;
}

let nodes: Node[] = [];

afterEach(async () => {
    for (const node of nodes) await node.stop();
    nodes = [];
});

async function boot(over: { expose?: readonly ExposeEntry[] } = {}): Promise<Node> {
    const app = new MeshApp({ nodeID: `api-test-${String(Math.random()).slice(2, 8)}`, namespace: 'mesh-api-test' });
    app.use(new RegistryModule());
    app.use(new BrokerModule());

    await app.start();

    // After start, not before: registerModule queues into pendingModules before start and that
    // flush is unawaited, so an early registration may not be ready when the first call lands.
    await app.registerModule(domainModule());

    const module = createApiModule({
        application: 'test.site',
        expose: over.expose ?? expose,
        port: 0,
        host: '127.0.0.1',
        validateTool: 'identity.ticket_validate',
        authorize: ({ caller, requestedScope, permission }) => {
            if (caller === undefined) return { authorized: true };
            const scope = memberships[caller.userId];
            if (scope === undefined) {
                return { authorized: false, status: 403, code: 'NO_ORGANIZATION', message: 'no organization' };
            }
            if (requestedScope !== undefined && requestedScope !== scope) {
                return { authorized: false, status: 404, code: 'NOT_FOUND', message: 'No such organization' };
            }
            if (permission === 'credential.read' && scope !== 'org-a') {
                return { authorized: false, status: 403, code: 'FORBIDDEN', message: `no ${permission}` };
            }
            return { authorized: true, resolvedScope: scope };
        },
        onError: () => {},
    });

    await app.registerModule(module);

    const address = module.listener!.address() as AddressInfo;
    const node: Node = {
        app,
        module,
        url: `http://127.0.0.1:${address.port}`,
        async stop() {
            await module.onStop?.(undefined as unknown as IServiceBroker);
            await app.stop();
        },
    };

    nodes.push(node);
    return node;
}

const get = (url: string, ticket?: string, scope?: string): Promise<Response> =>
    fetch(url, {
        headers: {
            ...(ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }),
            ...(scope === undefined ? {} : { 'x-organization': scope }),
        },
    });

// ---------------------------------------------------------------------------- the tests

describe('the api module registers with a real mesh', () => {
    it('starts, binds a port, and reports itself over the mesh', async () => {
        const node = await boot();

        // Called through the real broker, over the real registry — not through express.
        const status = await (node.app as unknown as {
            call(t: string, p: unknown): Promise<{ application: string; calls: number; exposure: string; listening: number }>;
        }).call('api.status', {});

        expect(status.application).toBe('test.site');
        expect(status.calls).toBe(2);
        expect(status.exposure).toMatch(/^sha256:/);
        expect(status.listening).toBeGreaterThan(0);
    });

    it('lists its routes and their gates over the mesh', async () => {
        const node = await boot();

        const routes = await (node.app as unknown as {
            call(t: string, p: unknown): Promise<{ routes: { key: string; gate: string }[] }>;
        }).call('api.routes', {});

        expect(routes.routes.map((r) => `${r.key} ${r.gate}`).sort()).toEqual([
            'credential.list permission:credential.read',
            'identity.whoami auth:user',
        ]);
    });

    it('fails to start rather than serving a surface nobody intended', async () => {
        const app = new MeshApp({ nodeID: 'api-test-bad', namespace: 'mesh-api-test' });
        app.use(new RegistryModule());
        app.use(new BrokerModule());
        await app.start();

        const ungated = { contract: whoamiContract } as unknown as ExposeEntry;
        const module = createApiModule({ application: 'bad', expose: [ungated], port: 0, host: '127.0.0.1' });

        // Thrown from onStart, so the mesh sees a module that failed rather than a node quietly
        // listening on an ungated contract.
        await expect(module.onStart!(undefined as unknown as IServiceBroker)).rejects.toThrow(/no gate/);
        await app.stop();
    });
});

describe('a real request, through the real broker', () => {
    it('validates a ticket by calling identity over the mesh', async () => {
        const node = await boot();

        const anonymous = await get(`${node.url}/api/identity/whoami`);
        expect(anonymous.status).toBe(401);

        const authenticated = await get(`${node.url}/api/identity/whoami`, 'alice-ticket');
        expect(authenticated.status).toBe(200);
        expect(await authenticated.json()).toEqual({ userId: 'u-alice', organization: 'org-a' });
    });

    it('caches the ticket, so identity is called once for many requests', async () => {
        const node = await boot();

        for (let i = 0; i < 4; i++) {
            expect((await get(`${node.url}/api/identity/whoami`, 'alice-ticket')).status).toBe(200);
        }

        const status = await (node.app as unknown as {
            call(t: string, p: unknown): Promise<{ tickets: number }>;
        }).call('api.status', {});

        expect(status.tickets).toBe(1);
    });

    it('refuses a ticket identity does not know', async () => {
        const node = await boot();
        expect((await get(`${node.url}/api/identity/whoami`, 'forged')).status).toBe(401);
    });

    it('carries the resolved scope into the handler, and it confines the result', async () => {
        const node = await boot();

        const response = await get(`${node.url}/api/credential`, 'alice-ticket');
        expect(response.status).toBe(200);

        // The handler read `ctx.meta.user.tenant_id` and filtered on it. org-b's credential is not
        // here, and nothing in the request could have asked for it.
        expect(await response.json()).toEqual({ items: [{ id: 'c1', organizationId: 'org-a' }] });
    });

    it('refuses a scope the caller is not in, without saying whether it exists', async () => {
        const node = await boot();
        const response = await get(`${node.url}/api/credential`, 'alice-ticket', 'org-b');
        expect(response.status).toBe(404);
    });

    it('validates input against the real contract schema', async () => {
        const node = await boot();

        // `limit` is declared as a number; the query string carries "abc". Coerced toward the
        // contract, still not a number, and rejected at the boundary with a message naming it —
        // rather than reaching the broker and coming back as a 500.
        const response = await fetch(`${node.url}/api/credential?limit=abc`, {
            headers: { authorization: 'Bearer alice-ticket' },
        });

        expect(response.status).toBe(400);
        expect((await response.json() as { message: string }).message).toMatch(/limit/);
    });
});
