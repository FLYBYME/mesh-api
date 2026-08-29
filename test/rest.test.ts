import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import {
    MeshApp,
    RegistryModule,
    BrokerModule,
    defineContract,
    defaultPrint,
    z,
} from '@flybyme/mesh';
import {
    createWebServer,
    MemorySessionStore,
    WebServiceModule,
    mountRest,
} from '../src/index.js';
import { FixtureService } from './fixtures/fixtureService.js';

interface LoginResponseBody {
    csrfToken: string;
    user: { id: string; tenant_id: string; roles?: string[] };
}

interface ErrorResponseBody {
    error: {
        code: string;
        message: string;
    };
}

describe('REST Exposure & Authentication', () => {
    let app: MeshApp;
    let server: Server;
    let baseUrl: string;
    let sessionStore: MemorySessionStore;
    let fixtureService: FixtureService;

    beforeAll(async () => {
        app = new MeshApp({ nodeID: 'test-node', namespace: 'test' });
        app.use(new RegistryModule({ preferLocal: true }));
        app.use(new BrokerModule());
        await app.start();

        fixtureService = new FixtureService();
        await app.registerModule(fixtureService);

        sessionStore = new MemorySessionStore();

        const web = express();
        const { router } = createWebServer({
            app,
            modules: [fixtureService],
            sessionStore,
            cookie: { secure: false },
            authenticate: async (credentials) => {
                const username = credentials['username'];
                const password = credentials['password'];
                if (username === 'alice' && password === 'secret') {
                    return { id: 'user_alice', tenant_id: 'org_1', roles: ['user'] };
                }
                if (username === 'admin' && password === 'adminsecret') {
                    return { id: 'user_admin', tenant_id: 'org_1', roles: ['admin'] };
                }
                return null;
            },
        });

        web.use(router);

        await new Promise<void>((resolve) => {
            server = web.listen(0, () => {
                const addr = server.address();
                if (typeof addr === 'object' && addr !== null) {
                    baseUrl = `http://127.0.0.1:${addr.port}`;
                }
                resolve();
            });
        });
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        });
        await app.stop();
    });

    async function loginAs(username: string, password = 'secret'): Promise<{ cookie: string; csrfToken: string; user: { id: string } }> {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        expect(res.status).toBe(200);
        const setCookie = res.headers.get('set-cookie');
        expect(setCookie).toBeTruthy();
        const cookie = setCookie ? (setCookie.split(';')[0] ?? '') : '';
        const body: LoginResponseBody = await res.json();
        return { cookie, csrfToken: body.csrfToken, user: body.user };
    }

    it('an exposed contract is reachable and returns the contract\'s own output shape unchanged', async () => {
        const res = await fetch(`${baseUrl}/api/items`);
        expect(res.status).toBe(200);
        const data: { items: string[] } = await res.json();
        expect(data).toEqual({ items: ['item1', 'item2'] });
    });

    it('a registered but NOT exposed contract is 404 (Exposure policy guarantee)', async () => {
        // The 404 alone proves nothing -- a route that was never defined 404s too, so this test
        // would still pass if `internal.secret` had simply been deleted from the fixture. Assert
        // both halves: the contract IS live on the broker, and it is STILL unreachable over HTTP.
        // That gap between the two is the exposure policy, and it is the single property this
        // whole package exists to guarantee. The registry is the exposure layer's own input,
        // so asserting against it checks the same source the layer reads.
        const registered = app.registry.getTools().map(c => `${c.domain}.${c.action}`);
        expect(registered).toContain('fixture.internal_secret');

        const res = await fetch(`${baseUrl}/api/internal/secret`);
        expect(res.status).toBe(404);
    });

    it('auth: "user" with no session -> 401; with a session -> 200', async () => {
        // Without session -> 401
        const resNoAuth = await fetch(`${baseUrl}/api/profile`);
        expect(resNoAuth.status).toBe(401);
        const bodyNoAuth: ErrorResponseBody = await resNoAuth.json();
        expect(bodyNoAuth.error.code).toBe('UNAUTHENTICATED');

        // With session -> 200
        const { cookie } = await loginAs('alice', 'secret');
        const resAuth = await fetch(`${baseUrl}/api/profile`, {
            headers: { Cookie: cookie },
        });
        expect(resAuth.status).toBe(200);
        const bodyAuth: { userId: string; tenantId: string } = await resAuth.json();
        expect(bodyAuth.userId).toBe('user_alice');
        expect(bodyAuth.tenantId).toBe('org_1');
    });

    it('auth: "admin" with a non-admin session -> 403; with admin session -> 200', async () => {
        // Non-admin session (alice has role 'user') -> 403
        const alice = await loginAs('alice', 'secret');
        const resForbidden = await fetch(`${baseUrl}/api/admin/purge`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: alice.cookie,
                'x-csrf-token': alice.csrfToken,
            },
            body: JSON.stringify({ reason: 'cleanup' }),
        });
        expect(resForbidden.status).toBe(403);
        const bodyForbidden: ErrorResponseBody = await resForbidden.json();
        expect(bodyForbidden.error.code).toBe('FORBIDDEN');

        // Admin session -> 200
        const admin = await loginAs('admin', 'adminsecret');
        const resAllowed = await fetch(`${baseUrl}/api/admin/purge`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: admin.cookie,
                'x-csrf-token': admin.csrfToken,
            },
            body: JSON.stringify({ reason: 'cleanup' }),
        });
        expect(resAllowed.status).toBe(200);
        const bodyAllowed: { purged: boolean; reason: string } = await resAllowed.json();
        expect(bodyAllowed.purged).toBe(true);
        expect(bodyAllowed.reason).toBe('cleanup');
    });

    it('a state-changing route with no/incorrect CSRF token -> 403; correct -> 200', async () => {
        const alice = await loginAs('alice', 'secret');

        // Missing CSRF token
        const resNoCsrf = await fetch(`${baseUrl}/api/echo`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: alice.cookie,
            },
            body: JSON.stringify({ message: 'test' }),
        });
        expect(resNoCsrf.status).toBe(403);
        const bodyNoCsrf: ErrorResponseBody = await resNoCsrf.json();
        expect(bodyNoCsrf.error.code).toBe('FORBIDDEN');
        expect(bodyNoCsrf.error.message).toContain('CSRF');

        // Incorrect CSRF token
        const resBadCsrf = await fetch(`${baseUrl}/api/echo`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: alice.cookie,
                'x-csrf-token': 'invalid-token-12345',
            },
            body: JSON.stringify({ message: 'test' }),
        });
        expect(resBadCsrf.status).toBe(403);

        // Correct CSRF token
        const resGoodCsrf = await fetch(`${baseUrl}/api/echo`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: alice.cookie,
                'x-csrf-token': alice.csrfToken,
            },
            body: JSON.stringify({ message: 'test' }),
        });
        expect(resGoodCsrf.status).toBe(200);
        const bodyGood: { reply: string; receivedUser?: string } = await resGoodCsrf.json();
        expect(bodyGood.reply).toBe('test');
        expect(bodyGood.receivedUser).toBe('user_alice');
    });

    it('invalid input -> 400, and the body names the offending field', async () => {
        const alice = await loginAs('alice', 'secret');
        const res = await fetch(`${baseUrl}/api/echo`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: alice.cookie,
                'x-csrf-token': alice.csrfToken,
            },
            body: JSON.stringify({ notMessage: 123 }),
        });
        expect(res.status).toBe(400);
        const body: ErrorResponseBody = await res.json();
        expect(body.error.code).toBe('BAD_REQUEST');
        expect(body.error.message).toContain('message');
    });

    it('a GET with ?limit=10 reaching a z.number() field as the number 10', async () => {
        const res = await fetch(`${baseUrl}/api/items?limit=10`);
        expect(res.status).toBe(200);
        const body: { items: string[]; limitReceived?: number } = await res.json();
        expect(body.limitReceived).toBe(10);
        expect(typeof body.limitReceived).toBe('number');
    });

    it('a handler throwing MeshError({ status: 404 }) -> 404 with that code', async () => {
        const res = await fetch(`${baseUrl}/api/not-found-item`);
        expect(res.status).toBe(404);
        const body: ErrorResponseBody = await res.json();
        expect(body.error.code).toBe('NOT_FOUND');
        expect(body.error.message).toBe('Resource not found');
    });

    it('a handler throwing a plain Error -> 500 whose body does NOT contain the thrown message', async () => {
        const res = await fetch(`${baseUrl}/api/server-error`);
        expect(res.status).toBe(500);
        const body: ErrorResponseBody = await res.json();
        expect(body.error.code).toBe('INTERNAL_ERROR');
        expect(body.error.message).toBe('Internal server error');
        expect(JSON.stringify(body)).not.toContain('Secret database password leaked');
    });

    it('login -> session cookie -> authenticated call -> logout -> same call now 401', async () => {
        // 1. Login
        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice', password: 'secret' }),
        });
        expect(loginRes.status).toBe(200);
        const setCookie = loginRes.headers.get('set-cookie');
        expect(setCookie).toBeTruthy();
        const cookie = setCookie ? (setCookie.split(';')[0] ?? '') : '';

        // 2. Authenticated call
        const authedRes = await fetch(`${baseUrl}/api/profile`, {
            headers: { Cookie: cookie },
        });
        expect(authedRes.status).toBe(200);

        // 3. Logout
        const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
            method: 'POST',
            headers: { Cookie: cookie },
        });
        expect(logoutRes.status).toBe(200);

        // 4. Same call is now 401
        const postLogoutRes = await fetch(`${baseUrl}/api/profile`, {
            headers: { Cookie: cookie },
        });
        expect(postLogoutRes.status).toBe(401);
    });

    it('failed login returns 401 with identical message for wrong password and nonexistent user', async () => {
        const badPasswordRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice', password: 'wrong' }),
        });
        expect(badPasswordRes.status).toBe(401);
        const badPasswordBody: ErrorResponseBody = await badPasswordRes.json();
        expect(badPasswordBody.error.message).toBe('Invalid credentials');

        const noUserRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'nobody', password: 'secret' }),
        });
        expect(noUserRes.status).toBe(401);
        const noUserBody: ErrorResponseBody = await noUserRes.json();
        expect(noUserBody.error.message).toBe('Invalid credentials');
    });

    it('GET /api/session returns { user: null } when unauthenticated and session user when authenticated', async () => {
        // Unauthenticated
        const unauthedRes = await fetch(`${baseUrl}/api/session`);
        expect(unauthedRes.status).toBe(200);
        const unauthedBody: { user: unknown } = await unauthedRes.json();
        expect(unauthedBody.user).toBeNull();

        // Authenticated
        const alice = await loginAs('alice', 'secret');
        const authedRes = await fetch(`${baseUrl}/api/session`, {
            headers: { Cookie: alice.cookie },
        });
        expect(authedRes.status).toBe(200);
        const authedBody: LoginResponseBody = await authedRes.json();
        expect(authedBody.user.id).toBe('user_alice');
        expect(authedBody.csrfToken).toBe(alice.csrfToken);
    });

    it('propagates correlation-id on responses', async () => {
        const customId = 'my-trace-id-12345';
        const res = await fetch(`${baseUrl}/api/items`, {
            headers: { 'x-correlation-id': customId },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('x-correlation-id')).toBe(customId);

        const autoRes = await fetch(`${baseUrl}/api/items`);
        expect(autoRes.status).toBe(200);
        const generatedId = autoRes.headers.get('x-correlation-id');
        expect(generatedId).toBeTruthy();
        expect(typeof generatedId).toBe('string');
    });

    it('throws when mountWeb is called more than once on a service', () => {
        class DoubleMountService extends WebServiceModule {
            public readonly domain = 'doublemounttest';
            constructor() {
                super();
                this.mountWeb({ expose: [] });
                this.mountWeb({ expose: [] });
            }
        }
        expect(() => new DoubleMountService()).toThrow(/mountWeb\(\) called more than once/);
    });

    it('throws when two modules expose the same tool key in createWebServer', () => {
        const contractA = defineContract({
            domain: 'dupdomain',
            action: 'dupaction',
            description: 'Duplicate tool',
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            rest: { method: 'GET', path: '/dup1' },
            print: defaultPrint,
        });

        class ModA extends WebServiceModule {
            public readonly domain = 'moda';
            constructor() {
                super();
                this.mountWeb({ expose: [{ contract: contractA, auth: 'public' }] });
            }
        }

        class ModB extends WebServiceModule {
            public readonly domain = 'modb';
            constructor() {
                super();
                this.mountWeb({ expose: [{ contract: contractA, auth: 'public' }] });
            }
        }

        expect(() => {
            createWebServer({
                app,
                modules: [new ModA(), new ModB()],
            });
        }).toThrow(/Duplicate exposed tool: contract 'dupdomain.dupaction'/);
    });

    it('throws when two exposed contracts declare the same method and path', () => {
        const contract1 = defineContract({
            domain: 'collisionone',
            action: 'act1',
            description: 'Collision 1',
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            rest: { method: 'GET', path: '/colliding-path' },
            print: defaultPrint,
        });

        const contract2 = defineContract({
            domain: 'collisiontwo',
            action: 'act2',
            description: 'Collision 2',
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            rest: { method: 'GET', path: '/colliding-path' },
            print: defaultPrint,
        });

        const testRouter = express.Router();

        expect(() => {
            mountRest(testRouter, {
                broker: app.getProvider('broker'),
                expose: [
                    { contract: contract1, auth: 'public' },
                    { contract: contract2, auth: 'public' },
                ],
            });
        }).toThrow(/Route collision: GET \/colliding-path is declared by both 'collisionone.act1' and 'collisiontwo.act2'/);
    });
});
