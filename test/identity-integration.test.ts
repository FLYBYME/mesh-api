/**
 * mesh-api authenticating against a real mesh-identity.
 *
 * The seam this session keeps proving is worth testing: both sides have been verified against
 * something the other did not write — mesh-api's ticket cache against a validator that recognised
 * the string `alice-ticket`, and identity's contracts against no consumer at all. A contract with no
 * caller has never been wrong.
 *
 * **mesh-identity is a devDependency here, never a dependency.** mesh-api calls
 * `identity.ticket_validate` by contract key over the mesh; a hard dependency would couple the
 * listener to one implementation of identity and defeat the narrow broker interface. It is imported
 * here only so one process can host both modules.
 */

import { MeshApp, BrokerModule, RegistryModule, defineContract, z } from '@flybyme/mesh';
import type { IServiceBroker, IServiceContext, IServiceModule, ToolContract } from '@flybyme/mesh';
import { createIdentityModule, type IdentityModule } from '@flybyme/mesh-identity';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createApiModule, type ApiModule, type ExposeEntry } from '../src/index.js';

// ---------------------------------------------------------------------------- a site

const whoamiContract = defineContract({
    domain: 'notes',
    action: 'mine',
    description: 'Notes belonging to the caller.',
    inputSchema: z.object({}),
    outputSchema: z.object({ userId: z.string(), notes: z.array(z.string()) }),
    rest: { method: 'GET', path: '/notes' },
    visibility: 'public',
    print: String,
});

function notesModule(): IServiceModule {
    return {
        domain: 'notes',
        getContracts: () => [whoamiContract as unknown as ToolContract<z.ZodTypeAny, z.ZodTypeAny>],
        isCrud: () => false,
        getEventHandlers: () => new Map(),
        async beforeCrud(_d, _a, i) { return i; },
        async afterCrud(_d, _a, o) { return o; },
        async execute(_d: string, _a: string, _i: unknown, ctx: IServiceContext): Promise<unknown> {
            const userId = (ctx.meta as { user?: { id?: string } } | undefined)?.user?.id ?? 'anonymous';
            return { userId, notes: [`a note for ${userId}`] };
        },
    };
}

interface Site {
    readonly app: MeshApp;
    readonly api: ApiModule;
    readonly identity: IdentityModule;
    readonly url: string;
    call<T>(tool: string, params: unknown): Promise<T>;
    stop(): Promise<void>;
}

let sites: Site[] = [];

afterEach(async () => {
    for (const site of sites) await site.stop();
    sites = [];
});

async function boot(options: { revocationPollMs?: number } = {}): Promise<Site> {
    const app = new MeshApp({
        nodeID: `site-${String(Math.random()).slice(2, 8)}`,
        namespace: 'mesh-api-identity-test',
    });
    app.use(new RegistryModule());
    app.use(new BrokerModule());
    await app.start();

    const identity = createIdentityModule();
    await app.registerModule(identity);
    await app.registerModule(notesModule());

    const api = createApiModule({
        application: 'test.notes',
        expose: [{ contract: whoamiContract as unknown as ExposeEntry['contract'], auth: 'user' }],
        port: 0,
        host: '127.0.0.1',
        // The real contract, answered by the real module, over the real broker.
        validateTool: 'identity.ticket_validate',
        // Fast enough that a test does not wait; the *default* is thirty seconds and is a
        // correctness parameter rather than tuning.
        revocationPollMs: options.revocationPollMs ?? 50,
        authorize: () => ({ authorized: true }),
        onError: () => {},
    });
    await app.registerModule(api);

    const address = api.listener!.address() as AddressInfo;
    const call = <T,>(tool: string, params: unknown): Promise<T> =>
        (app as unknown as { call(t: string, p: unknown): Promise<T> }).call(tool, params);

    const site: Site = {
        app, api, identity,
        url: `http://127.0.0.1:${String(address.port)}`,
        call,
        async stop() {
            await api.onStop?.(undefined as unknown as IServiceBroker);
            await app.stop();
        },
    };

    sites.push(site);
    return site;
}

const signUp = async (site: Site, email = 'alice@example.com'): Promise<string> => {
    await site.call('identity.register', { email, password: 'a-long-enough-password', displayName: 'Alice' });
    const { token } = await site.call<{ token: string }>('identity.ticket_issue', {
        email, password: 'a-long-enough-password',
    });
    return token;
};

const get = (site: Site, ticket?: string): Promise<Response> =>
    fetch(`${site.url}/api/notes`, {
        headers: ticket === undefined ? {} : { authorization: `Bearer ${ticket}` },
    });

// ---------------------------------------------------------------------------- the tests

describe('a real sign-in, end to end', () => {
    it('refuses without a ticket and admits with one identity issued', async () => {
        const site = await boot();

        expect((await get(site)).status).toBe(401);

        const ticket = await signUp(site);
        const response = await get(site, ticket);

        expect(response.status).toBe(200);
        // The userId came from identity, through the ticket cache, into `meta.user.id`, and the
        // handler read it. Nothing in this path is a fixture.
        expect((await response.json() as { userId: string }).userId).toMatch(/^u-/);
    }, 30_000);

    it('refuses a ticket identity never issued', async () => {
        const site = await boot();
        expect((await get(site, 'not-a-real-ticket')).status).toBe(401);
    }, 30_000);

    it('validates once and serves the rest from cache', async () => {
        const site = await boot();
        const ticket = await signUp(site);

        for (let i = 0; i < 4; i++) expect((await get(site, ticket)).status).toBe(200);

        const status = await site.call<{ tickets: number }>('api.status', {});
        expect(status.tickets).toBe(1);
    }, 30_000);
});

describe('revocation reaches the API', () => {
    it('stops working after the poller catches up', async () => {
        const site = await boot({ revocationPollMs: 30 });
        const ticket = await signUp(site);

        expect((await get(site, ticket)).status).toBe(200);

        // Revoked at identity. The API is holding a valid cache entry and — because mesh delivers
        // events at-most-once (auth §3.1) — may never be told. The poll is what closes it.
        await site.call('identity.ticket_revoke', { token: ticket, reason: 'signed out' });

        // Wait for a poll, not for a TTL: the TTL here is two minutes and the point is that
        // revocation does not wait for it.
        for (let i = 0; i < 60; i++) {
            if ((await get(site, ticket)).status === 401) break;
            await new Promise((r) => setTimeout(r, 25));
        }

        expect((await get(site, ticket)).status).toBe(401);
    }, 30_000);

    it('drops every ticket a principal holds', async () => {
        const site = await boot({ revocationPollMs: 30 });

        const first = await signUp(site);
        const { token: second } = await site.call<{ token: string }>('identity.ticket_issue', {
            email: 'alice@example.com', password: 'a-long-enough-password',
        });

        expect((await get(site, first)).status).toBe(200);
        expect((await get(site, second)).status).toBe(200);

        const userId = (await site.call<{ userId?: string }>('identity.ticket_validate', { ticket: first })).userId!;
        await site.call('identity.ticket_revoke', { userId, reason: 'suspended' });

        for (let i = 0; i < 60; i++) {
            if ((await get(site, second)).status === 401) break;
            await new Promise((r) => setTimeout(r, 25));
        }

        // One revocation row, both tickets gone.
        expect((await get(site, first)).status).toBe(401);
        expect((await get(site, second)).status).toBe(401);
    }, 30_000);

    it('refuses a suspended principal even before any revocation is polled', async () => {
        const site = await boot({ revocationPollMs: 100_000 });   // effectively no polling
        const ticket = await signUp(site);
        const userId = (await site.call<{ userId?: string }>('identity.ticket_validate', { ticket })).userId!;

        // Suspension is checked at validation, so a *new* instance or an expired cache entry sees it
        // immediately — which is the layer that does not depend on the poll at all.
        await site.identity.store.updateUser(userId, { suspendedAt: Date.now(), suspendedReason: 'abuse' });

        expect((await site.call<{ valid: boolean }>('identity.ticket_validate', { ticket })).valid).toBe(false);
    }, 30_000);
});
