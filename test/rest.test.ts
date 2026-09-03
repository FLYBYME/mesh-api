/**
 * REST, end to end through a real express app.
 *
 * Real HTTP with supertest rather than calling the handler directly, because most of what can go
 * wrong here is between the pieces: a header read from the wrong place, a body merged in the wrong
 * order, a status set after the response was sent. Calling the handler with a hand-made request
 * object would test my idea of express rather than express.
 */

import express, { Router } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MeshError } from '@flybyme/mesh';

import {
    createTicketCache, mountRest, EXPOSURE_HEADER, SCOPE_HEADER,
    type ApiBroker, type AuthorizeHook, type Caller, type ExposeEntry,
} from '../src/index.js';
import type { ToolContract } from '@flybyme/mesh';

// ---------------------------------------------------------------------------- contracts

const contract = (over: {
    domain: string;
    action: string;
    method?: string;
    path?: string;
    input?: z.ZodTypeAny;
}): ToolContract => ({
    domain: over.domain,
    action: over.action,
    description: `${over.domain}.${over.action}`,
    inputSchema: over.input ?? z.object({ id: z.string() }),
    outputSchema: z.object({}).passthrough(),
    rest: { method: (over.method ?? 'GET') as 'GET', path: over.path ?? `/${over.domain}/${over.action}` },
    visibility: 'public',
    print: String,
}) as unknown as ToolContract;

const whoami = contract({ domain: 'identity', action: 'whoami', path: '/identity/whoami', input: z.object({}) });
const resolveCredential = contract({
    domain: 'credential',
    action: 'resolve',
    path: '/credential/resolve',
    input: z.object({ id: z.string(), limit: z.number().optional(), verbose: z.boolean().optional() }),
});
const createCredential = contract({
    domain: 'credential',
    action: 'create',
    method: 'POST',
    path: '/credential',
    input: z.object({ name: z.string() }),
});
const getMember = contract({
    domain: 'identity',
    action: 'member',
    path: '/identity/member/:id',
    input: z.object({ id: z.string() }),
});

// ---------------------------------------------------------------------------- the app

const alice: Caller = { userId: 'u-alice', roles: [] };

interface Harness {
    readonly app: express.Express;
    readonly calls: { tool: string; params: unknown; meta: unknown }[];
    readonly validated: string[];
}

function harness(options: {
    expose: readonly ExposeEntry[];
    authorize?: AuthorizeHook;
    result?: unknown;
    fail?: unknown;
    tickets?: Record<string, Caller>;
    exposure?: string;
} ): Harness {
    const calls: { tool: string; params: unknown; meta: unknown }[] = [];
    const validated: string[] = [];

    const broker: ApiBroker = {
        async call(tool, params, o) {
            calls.push({ tool, params, meta: o?.meta });
            if (options.fail !== undefined) throw options.fail;
            return options.result ?? { ok: true };
        },
    };

    const known = options.tickets ?? { 'good-ticket': alice };
    const tickets = createTicketCache({
        validate: async (ticket) => {
            validated.push(ticket);
            const caller = known[ticket];
            return caller === undefined ? { valid: false } : { valid: true, caller };
        },
    });

    const router = Router();
    mountRest(router, {
        broker,
        tickets,
        expose: options.expose,
        ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
        ...(options.exposure === undefined ? {} : { exposure: options.exposure }),
        onError: () => {},
    });

    const app = express();
    app.use(express.json());
    app.use('/api', router);

    return { app, calls, validated };
}

const asAlice = { Authorization: 'Bearer good-ticket' };

// ---------------------------------------------------------------------------- routing

describe('routes come from the contract', () => {
    it('serves a GET at the contract-declared path', async () => {
        const h = harness({ expose: [{ contract: whoami, auth: 'public' }] });

        const response = await request(h.app).get('/api/identity/whoami');

        expect(response.status).toBe(200);
        expect(h.calls[0]!.tool).toBe('identity.whoami');
    });

    it('404s a path no contract declared', async () => {
        const h = harness({ expose: [{ contract: whoami, auth: 'public' }] });
        expect((await request(h.app).get('/api/identity/nope')).status).toBe(404);
    });

    it('refuses to mount two contracts on one route', () => {
        const clash = contract({ domain: 'other', action: 'thing', path: '/identity/whoami' });

        // At mount time, not at request time: a misconfigured API must fail to start.
        expect(() => harness({
            expose: [{ contract: whoami, auth: 'public' }, { contract: clash, auth: 'public' }],
        })).toThrow(/Route collision/);
    });

    it('refuses to mount an ungated entry', () => {
        const ungated = { contract: whoami } as unknown as ExposeEntry;
        expect(() => harness({ expose: [ungated] })).toThrow(/no gate/);
    });

    it('returns 201 for a create', async () => {
        const h = harness({ expose: [{ contract: createCredential, auth: 'user' }] });
        const response = await request(h.app).post('/api/credential').set(asAlice).send({ name: 'prod' });
        expect(response.status).toBe(201);
    });
});

// ---------------------------------------------------------------------------- auth

describe('the ticket decides who is calling', () => {
    it('lets an anonymous caller reach a public contract', async () => {
        const h = harness({ expose: [{ contract: whoami, auth: 'public' }] });

        expect((await request(h.app).get('/api/identity/whoami')).status).toBe(200);
        // No ticket, so identity is never asked.
        expect(h.validated).toEqual([]);
        expect(h.calls[0]!.meta).toEqual({});
    });

    it('401s an anonymous caller on a user contract', async () => {
        const h = harness({ expose: [{ contract: whoami, auth: 'user' }] });

        const response = await request(h.app).get('/api/identity/whoami');
        expect(response.status).toBe(401);
        expect(response.body).toMatchObject({ error: 'UNAUTHENTICATED' });
        // Refused before the mesh was touched.
        expect(h.calls).toHaveLength(0);
    });

    it('401s an unknown ticket, and does not treat it as anonymous-but-fine', async () => {
        const h = harness({ expose: [{ contract: whoami, auth: 'user' }] });

        const response = await request(h.app).get('/api/identity/whoami').set({ Authorization: 'Bearer forged' });
        expect(response.status).toBe(401);
        expect(h.validated).toEqual(['forged']);
    });

    it('validates a ticket once across many requests', async () => {
        const h = harness({ expose: [{ contract: whoami, auth: 'user' }] });

        for (let i = 0; i < 5; i++) {
            expect((await request(h.app).get('/api/identity/whoami').set(asAlice)).status).toBe(200);
        }

        // One mesh call per (ticket, instance), which is the entire point of the cache.
        expect(h.validated).toEqual(['good-ticket']);
    });

    it('passes the caller to the mesh, and never a scope the request asked for', async () => {
        const h = harness({
            expose: [{ contract: whoami, auth: 'user' }],
            authorize: () => ({ authorized: true, resolvedScope: 'org-real' }),
        });

        await request(h.app).get('/api/identity/whoami')
            .set(asAlice)
            .set(SCOPE_HEADER, 'org-someone-elses');

        // tenant_id is what the hook resolved from memberships. The header was a request.
        expect(h.calls[0]!.meta).toEqual({ user: { id: 'u-alice', tenant_id: 'org-real' } });
    });

    it('ignores an organization named in the body', async () => {
        const h = harness({
            expose: [{ contract: createCredential, auth: 'user' }],
            authorize: () => ({ authorized: true, resolvedScope: 'org-real' }),
        });

        await request(h.app).post('/api/credential').set(asAlice)
            .send({ name: 'prod', organizationId: 'org-someone-elses', tenant_id: 'org-someone-elses' });

        expect(h.calls[0]!.meta).toEqual({ user: { id: 'u-alice', tenant_id: 'org-real' } });
    });

    it('lets the hook refuse, and says nothing more than it chose to', async () => {
        const h = harness({
            expose: [{ contract: whoami, auth: 'user' }],
            authorize: () => ({ authorized: false, status: 404, code: 'NOT_FOUND', message: 'No such organization' }),
        });

        const response = await request(h.app).get('/api/identity/whoami').set(asAlice);
        expect(response.status).toBe(404);
        expect(h.calls).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------- input

describe('input', () => {
    it('coerces a query string toward what the contract declared', async () => {
        const h = harness({ expose: [{ contract: resolveCredential, auth: 'public' }] });

        await request(h.app).get('/api/credential/resolve?id=c1&limit=10&verbose=true');

        // HTTP has one type. `limit: z.number()` would otherwise reject `?limit=10` on a
        // technicality that has nothing to do with the caller being wrong.
        expect(h.calls[0]!.params).toEqual({ id: 'c1', limit: 10, verbose: true });
    });

    it('400s a bad input and names the field', async () => {
        const h = harness({ expose: [{ contract: resolveCredential, auth: 'public' }] });

        const response = await request(h.app).get('/api/credential/resolve');
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('INVALID_INPUT');
        expect(response.body.message).toMatch(/id/);
        expect(h.calls).toHaveLength(0);
    });

    it('lets the path win over a body claiming a different id', async () => {
        const h = harness({ expose: [{ contract: getMember, auth: 'public' }] });

        await request(h.app).get('/api/identity/member/m1').send({ id: 'm-someone-elses' });

        // The URL is what the router and the gate agreed on. A body overriding it is a caller
        // acting on one record through another's address.
        expect(h.calls[0]!.params).toEqual({ id: 'm1' });
    });

    it('validates only after the gate, so a refused caller learns nothing about the shape', async () => {
        const h = harness({ expose: [{ contract: resolveCredential, auth: 'user' }] });

        // Missing `id` *and* unauthenticated: the answer is 401, not a 400 describing the input.
        const response = await request(h.app).get('/api/credential/resolve');
        expect(response.status).toBe(401);
    });
});

// ---------------------------------------------------------------------------- failures

describe('failures', () => {
    it('keeps a MeshError status and code', async () => {
        const h = harness({
            expose: [{ contract: whoami, auth: 'public' }],
            fail: new MeshError({ code: 'NOT_FOUND', status: 404, message: 'No such user' }),
        });

        const response = await request(h.app).get('/api/identity/whoami');
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'NOT_FOUND', message: 'No such user' });
    });

    it('never leaks the detail of an unexpected failure', async () => {
        const h = harness({
            expose: [{ contract: whoami, auth: 'public' }],
            fail: new Error('MongoServerError: connection to mongodb://user:hunter2@10.0.0.4 failed'),
        });

        const response = await request(h.app).get('/api/identity/whoami');
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
        expect(JSON.stringify(response.body)).not.toMatch(/hunter2|mongodb/);
    });

    it('hands the real error to onError instead', async () => {
        const onError = vi.fn();
        const boom = new Error('the real detail');
        const broker: ApiBroker = { call: async () => { throw boom; } };

        const router = Router();
        mountRest(router, {
            broker,
            tickets: createTicketCache({ validate: async () => ({ valid: false }) }),
            expose: [{ contract: whoami, auth: 'public' }],
            onError,
        });

        const app = express().use(express.json()).use('/api', router);
        await request(app).get('/api/identity/whoami');

        expect(onError).toHaveBeenCalledWith(boom, { key: 'identity.whoami' });
    });
});

// ---------------------------------------------------------------------------- the exposure header

describe('a stale client is caught', () => {
    it('reports the exposure hash on every response, including failures', async () => {
        const h = harness({
            expose: [{ contract: whoami, auth: 'user' }],
            exposure: 'sha256:abc123',
        });

        // The other half of the check the generated browser client already performs: it carries the
        // hash it was built from and refuses to speak to an API serving a different one.
        const ok = await request(h.app).get('/api/identity/whoami').set(asAlice);
        expect(ok.headers[EXPOSURE_HEADER]).toBe('sha256:abc123');

        const refused = await request(h.app).get('/api/identity/whoami');
        expect(refused.status).toBe(401);
        expect(refused.headers[EXPOSURE_HEADER]).toBe('sha256:abc123');
    });
});
