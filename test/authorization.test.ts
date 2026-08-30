import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import {
    MeshApp,
    RegistryModule,
    BrokerModule,
    defineContract,
    defaultPrint,
    MeshError,
    z,
} from '@flybyme/mesh';
import {
    createWebServer,
    MemorySessionStore,
    WebServiceModule,
    matchPermission,
    extractRequestedScope,
    validateExposeEntry,
    type ExposeEntry,
} from '../src/index.js';

// --- Fixture Contracts ---

const dnsRecordCreateContract = defineContract({
    domain: 'dns',
    action: 'record_create',
    description: 'Create a new DNS record in an organization zone',
    inputSchema: z.object({
        orgId: z.string().optional(),
        name: z.string(),
        value: z.string(),
    }),
    outputSchema: z.object({
        created: z.boolean(),
        effectiveTenantId: z.string(),
        bodyOrgIdReceived: z.string().optional(),
        name: z.string(),
        value: z.string(),
    }),
    rest: { method: 'POST', path: '/dns/records' },
    print: defaultPrint,
    destructive: true,
});

const dnsRecordListContract = defineContract({
    domain: 'dns',
    action: 'record_list',
    description: 'List DNS records for an organization zone',
    inputSchema: z.object({
        orgId: z.string().optional(),
    }),
    outputSchema: z.object({
        records: z.array(z.string()),
        effectiveTenantId: z.string(),
    }),
    rest: { method: 'GET', path: '/dns/records' },
    print: defaultPrint,
});

const plansListContract = defineContract({
    domain: 'plans',
    action: 'list',
    description: 'Public pricing plans list',
    inputSchema: z.object({}),
    outputSchema: z.object({
        plans: z.array(z.string()),
    }),
    rest: { method: 'GET', path: '/plans' },
    print: defaultPrint,
});

const whoamiContract = defineContract({
    domain: 'account',
    action: 'whoami',
    description: 'Get current authenticated user',
    inputSchema: z.object({}),
    outputSchema: z.object({
        userId: z.string(),
        tenantId: z.string(),
    }),
    rest: { method: 'GET', path: '/account/whoami' },
    print: defaultPrint,
});

// --- Test State & Data Stores ---

const knownOrganizations = new Set<string>(['org_A', 'org_B', 'org_C']);

// Mapping: `${userId}:${orgId}` -> Set of granted permission glob patterns
const permissionsTable = new Map<string, Set<string>>([
    // Alice has wildcard dns.* in org_A, but no permissions in org_B
    ['user_alice:org_A', new Set(['dns.*'])],
    // Bob has only dns.read in org_A
    ['user_bob:org_A', new Set(['dns.read'])],
    // Dave (operator) has dns.write and dns.read in both org_A and org_B
    ['user_dave:org_A', new Set(['dns.*'])],
    ['user_dave:org_B', new Set(['dns.write', 'dns.read'])],
    // Eve in org_C has dns.write only in org_C
    ['user_eve:org_C', new Set(['dns.write', 'dns.read'])],
]);

class MultiTenantDnsService extends WebServiceModule {
    public readonly domain = 'dns';

    constructor() {
        super();

        this.mountTool(dnsRecordCreateContract, async (input, ctx) => {
            const user = ctx.meta?.user;
            if (!user) {
                throw new MeshError({ code: 'UNAUTHENTICATED', status: 401, message: 'Missing user session context' });
            }
            return {
                created: true,
                effectiveTenantId: user.tenant_id,
                bodyOrgIdReceived: input.orgId,
                name: input.name,
                value: input.value,
            };
        });

        this.mountTool(dnsRecordListContract, async (_input, ctx) => {
            const user = ctx.meta?.user;
            if (!user) {
                throw new MeshError({ code: 'UNAUTHENTICATED', status: 401, message: 'Missing user session context' });
            }
            return {
                records: [`zone1.${user.tenant_id}`, `zone2.${user.tenant_id}`],
                effectiveTenantId: user.tenant_id,
            };
        });

        this.mountTool(plansListContract, async () => {
            return {
                plans: ['starter', 'pro', 'enterprise'],
            };
        });

        this.mountTool(whoamiContract, async (_input, ctx) => {
            const user = ctx.meta?.user;
            if (!user) {
                throw new MeshError({ code: 'UNAUTHENTICATED', status: 401, message: 'Missing user session context' });
            }
            return {
                userId: user.id,
                tenantId: user.tenant_id,
            };
        });

        this.mountWeb({
            expose: [
                { contract: dnsRecordCreateContract, permission: 'dns.write' },
                { contract: dnsRecordListContract, permission: 'dns.read' },
                { contract: plansListContract, auth: 'public' },
                { contract: whoamiContract, auth: 'user' },
            ],
            authorize: async (input) => {
                // 1. Genuinely unauthenticated / public endpoints
                if (input.auth === 'public') {
                    return true;
                }

                // 2. Non-public endpoints require an authenticated user
                if (!input.user || !input.principal) {
                    return {
                        authorized: false,
                        status: 401,
                        code: 'UNAUTHENTICATED',
                        message: 'Authentication required: missing token or session',
                    };
                }

                // If coarse auth: 'user', authenticated status is sufficient
                if (input.auth === 'user') {
                    return true;
                }

                // 3. Resolve target organization scope (from request param/body or caller default)
                const targetOrgId = input.requestedScope ?? input.userScope;
                if (!targetOrgId) {
                    return {
                        authorized: false,
                        status: 400,
                        code: 'BAD_REQUEST',
                        message: 'Organization ID is required when caller has no default organization context',
                    };
                }

                // Check scope existence
                if (!knownOrganizations.has(targetOrgId)) {
                    return {
                        authorized: false,
                        status: 404,
                        code: 'NOT_FOUND',
                        message: `Organization '${targetOrgId}' not found`,
                    };
                }

                // 4. Cross-org boundary check: if request targets another org, refuse unless operator
                if (input.userScope && targetOrgId !== input.userScope) {
                    const isOperator = Boolean(
                        input.user.roles?.includes('operator') || input.user.roles?.includes('admin')
                    );
                    if (!isOperator) {
                        return {
                            authorized: false,
                            status: 403,
                            code: 'FORBIDDEN',
                            message: `Caller is scoped to org '${input.userScope}' and cannot access org '${targetOrgId}'`,
                        };
                    }
                }

                // 5. Resolve effective permissions within the target organization
                if (input.permission) {
                    const grantedPerms = permissionsTable.get(`${input.principal}:${targetOrgId}`) ?? new Set<string>();
                    const hasPermission = Array.from(grantedPerms).some(pattern =>
                        matchPermission(pattern, input.permission!)
                    );

                    if (!hasPermission) {
                        return {
                            authorized: false,
                            status: 403,
                            code: 'FORBIDDEN',
                            message: `Forbidden: Insufficient permissions in organization '${targetOrgId}'. Required: '${input.permission}'`,
                        };
                    }
                }

                return {
                    authorized: true,
                    resolvedScope: targetOrgId,
                };
            },
        });
    }
}

describe('Multi-Tenant Per-Organization Authorization', () => {
    let app: MeshApp;
    let server: Server;
    let baseUrl: string;
    let sessionStore: MemorySessionStore;
    let service: MultiTenantDnsService;

    beforeAll(async () => {
        app = new MeshApp({ nodeID: 'auth-test-node', namespace: 'test' });
        app.use(new RegistryModule({ preferLocal: true }));
        app.use(new BrokerModule());
        await app.start();

        service = new MultiTenantDnsService();
        await app.registerModule(service);

        sessionStore = new MemorySessionStore();

        const web = express();
        const { router } = createWebServer({
            app,
            modules: [service],
            sessionStore,
            cookie: { secure: false },
            authenticate: async (credentials) => {
                const username = credentials['username'];
                if (username === 'alice') {
                    return { id: 'user_alice', tenant_id: 'org_A', roles: ['member'] };
                }
                if (username === 'bob') {
                    return { id: 'user_bob', tenant_id: 'org_A', roles: ['member'] };
                }
                if (username === 'dave_operator') {
                    return { id: 'user_dave', tenant_id: 'org_A', roles: ['operator'] };
                }
                if (username === 'eve') {
                    return { id: 'user_eve', tenant_id: 'org_C', roles: ['member'] };
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

    async function loginAs(username: string): Promise<{ cookie: string; csrfToken: string; user: { id: string; tenant_id: string } }> {
        const res = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password: 'any' }),
        });
        expect(res.status).toBe(200);
        const setCookie = res.headers.get('set-cookie');
        expect(setCookie).toBeTruthy();
        const cookie = setCookie ? (setCookie.split(';')[0] ?? '') : '';
        const body = (await res.json()) as { csrfToken: string; user: { id: string; tenant_id: string } };
        return { cookie, csrfToken: body.csrfToken, user: body.user };
    }

    it('matchPermission evaluates wildcard and exact patterns correctly', () => {
        expect(matchPermission('*', 'dns.write')).toBe(true);
        expect(matchPermission('*.*', 'dns.write')).toBe(true);
        expect(matchPermission('dns.*', 'dns.write')).toBe(true);
        expect(matchPermission('dns.*', 'dns.read')).toBe(true);
        expect(matchPermission('dns.record_*', 'dns.record_create')).toBe(true);
        expect(matchPermission('dns.record_*', 'dns.record_delete')).toBe(true);
        expect(matchPermission('dns.write', 'dns.write')).toBe(true);

        expect(matchPermission('dns.read', 'dns.write')).toBe(false);
        expect(matchPermission('storage.*', 'dns.write')).toBe(false);
        expect(matchPermission('dns.record_*', 'dns.zone_create')).toBe(false);
        expect(matchPermission('', 'dns.write')).toBe(false);
    });

    it('extractRequestedScope extracts orgId / tenantId / scope from params, query, or body', () => {
        expect(extractRequestedScope({}, { orgId: 'org_1' })).toBe('org_1');
        expect(extractRequestedScope({}, undefined, { tenantId: 'org_2' })).toBe('org_2');
        expect(extractRequestedScope({}, undefined, undefined, { scope: 'org_3' })).toBe('org_3');
        expect(extractRequestedScope({ organizationId: 'org_4' })).toBe('org_4');
        expect(extractRequestedScope({})).toBeUndefined();
    });

    it('1. a caller scoped to org A requesting org B is refused, and an operator doing the same is allowed', async () => {
        // Alice is a regular member in org_A. She attempts to create a DNS record in org_B.
        const alice = await loginAs('alice');
        const aliceRes = await fetch(`${baseUrl}/api/dns/records`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: alice.cookie,
                'x-csrf-token': alice.csrfToken,
            },
            body: JSON.stringify({
                orgId: 'org_B',
                name: 'test.example.com',
                value: '1.2.3.4',
            }),
        });

        expect(aliceRes.status).toBe(403);
        const aliceErr = (await aliceRes.json()) as { error: { code: string; message: string } };
        expect(aliceErr.error.code).toBe('FORBIDDEN');
        expect(aliceErr.error.message).toContain("Caller is scoped to org 'org_A' and cannot access org 'org_B'");

        // Dave is an operator in org_A with permissions in org_B. He creates a DNS record in org_B.
        const dave = await loginAs('dave_operator');
        const daveRes = await fetch(`${baseUrl}/api/dns/records`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: dave.cookie,
                'x-csrf-token': dave.csrfToken,
            },
            body: JSON.stringify({
                orgId: 'org_B',
                name: 'dave.example.com',
                value: '5.6.7.8',
            }),
        });

        expect(daveRes.status).toBe(200);
        const daveData = (await daveRes.json()) as { created: boolean; effectiveTenantId: string; name: string };
        expect(daveData.created).toBe(true);
        expect(daveData.effectiveTenantId).toBe('org_B');
        expect(daveData.name).toBe('dave.example.com');
    });

    it('2. a principal without the required permission in that org is refused, and same principal with it is allowed (per-org resolution)', async () => {
        // Bob is in org_A and has only 'dns.read'.
        const bob = await loginAs('bob');

        // Bob list records -> has 'dns.read' in org_A -> 200 OK
        const bobListRes = await fetch(`${baseUrl}/api/dns/records`, {
            headers: { Cookie: bob.cookie },
        });
        expect(bobListRes.status).toBe(200);
        const bobListData = (await bobListRes.json()) as { records: string[]; effectiveTenantId: string };
        expect(bobListData.effectiveTenantId).toBe('org_A');
        expect(bobListData.records).toEqual(['zone1.org_A', 'zone2.org_A']);

        // Bob create record -> requires 'dns.write' in org_A -> 403 FORBIDDEN
        const bobCreateRes = await fetch(`${baseUrl}/api/dns/records`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: bob.cookie,
                'x-csrf-token': bob.csrfToken,
            },
            body: JSON.stringify({
                name: 'bob.example.com',
                value: '9.9.9.9',
            }),
        });
        expect(bobCreateRes.status).toBe(403);
        const bobCreateErr = (await bobCreateRes.json()) as { error: { code: string; message: string } };
        expect(bobCreateErr.error.code).toBe('FORBIDDEN');
        expect(bobCreateErr.error.message).toContain("Insufficient permissions in organization 'org_A'. Required: 'dns.write'");

        // Alice is in org_A and has 'dns.*' (which includes 'dns.write') in org_A -> 200 OK
        const alice = await loginAs('alice');
        const aliceCreateRes = await fetch(`${baseUrl}/api/dns/records`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: alice.cookie,
                'x-csrf-token': alice.csrfToken,
            },
            body: JSON.stringify({
                name: 'alice.example.com',
                value: '1.1.1.1',
            }),
        });
        expect(aliceCreateRes.status).toBe(200);
        const aliceCreateData = (await aliceCreateRes.json()) as { created: boolean; effectiveTenantId: string };
        expect(aliceCreateData.created).toBe(true);
        expect(aliceCreateData.effectiveTenantId).toBe('org_A');
    });

    it('3. resolved org reaches the handler via meta, and a caller-supplied orgId in the body cannot override it', async () => {
        // Alice is scoped to org_A. She passes no orgId in body -> defaults to org_A.
        const alice = await loginAs('alice');
        const defaultRes = await fetch(`${baseUrl}/api/dns/records`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: alice.cookie,
                'x-csrf-token': alice.csrfToken,
            },
            body: JSON.stringify({
                name: 'safe.example.com',
                value: '2.2.2.2',
            }),
        });
        expect(defaultRes.status).toBe(200);
        const defaultData = (await defaultRes.json()) as { effectiveTenantId: string; bodyOrgIdReceived?: string };
        expect(defaultData.effectiveTenantId).toBe('org_A');

        // Alice explicitly sends orgId: 'org_A' in the body -> resolvedScope is org_A and handler receives org_A
        const explicitRes = await fetch(`${baseUrl}/api/dns/records`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: alice.cookie,
                'x-csrf-token': alice.csrfToken,
            },
            body: JSON.stringify({
                orgId: 'org_A',
                name: 'explicit.example.com',
                value: '3.3.3.3',
            }),
        });
        expect(explicitRes.status).toBe(200);
        const explicitData = (await explicitRes.json()) as { effectiveTenantId: string; bodyOrgIdReceived?: string };
        expect(explicitData.effectiveTenantId).toBe('org_A');
        expect(explicitData.bodyOrgIdReceived).toBe('org_A');

        // Alice attempts to forge orgId: 'org_C' (Eve's org) in the body -> Gate checks caller scope vs requestedScope
        // and refuses before broker.call can ever run.
        const attackRes = await fetch(`${baseUrl}/api/dns/records`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: alice.cookie,
                'x-csrf-token': alice.csrfToken,
            },
            body: JSON.stringify({
                orgId: 'org_C',
                name: 'hijacked.example.com',
                value: '6.6.6.6',
            }),
        });
        expect(attackRes.status).toBe(403);
        const attackErr = (await attackRes.json()) as { error: { code: string; message: string } };
        expect(attackErr.error.code).toBe('FORBIDDEN');
        expect(attackErr.error.message).toContain("Caller is scoped to org 'org_A' and cannot access org 'org_C'");
    });

    it('4. a public endpoint and coarse auth: user endpoint function correctly', async () => {
        // Public endpoint requires no auth
        const plansRes = await fetch(`${baseUrl}/api/plans`);
        expect(plansRes.status).toBe(200);
        const plansData = (await plansRes.json()) as { plans: string[] };
        expect(plansData.plans).toEqual(['starter', 'pro', 'enterprise']);

        // Coarse user endpoint: unauthenticated -> 401
        const unauthedWhoami = await fetch(`${baseUrl}/api/account/whoami`);
        expect(unauthedWhoami.status).toBe(401);

        // Coarse user endpoint: authenticated -> 200
        const alice = await loginAs('alice');
        const authedWhoami = await fetch(`${baseUrl}/api/account/whoami`, {
            headers: { Cookie: alice.cookie },
        });
        expect(authedWhoami.status).toBe(200);
        const whoamiData = (await authedWhoami.json()) as { userId: string; tenantId: string };
        expect(whoamiData.userId).toBe('user_alice');
        expect(whoamiData.tenantId).toBe('org_A');
    });

    it('5. denied / no-such-scope / unauthenticated produce distinct, correct statuses', async () => {
        // 5a. Unauthenticated -> 401 UNAUTHENTICATED
        const unauthedRes = await fetch(`${baseUrl}/api/dns/records`);
        expect(unauthedRes.status).toBe(401);
        const unauthedErr = (await unauthedRes.json()) as { error: { code: string; message: string } };
        expect(unauthedErr.error.code).toBe('UNAUTHENTICATED');

        // 5b. Non-existent scope (org) -> 404 NOT_FOUND
        const dave = await loginAs('dave_operator');
        const notFoundOrgRes = await fetch(`${baseUrl}/api/dns/records?orgId=org_nonexistent`, {
            headers: { Cookie: dave.cookie },
        });
        expect(notFoundOrgRes.status).toBe(404);
        const notFoundOrgErr = (await notFoundOrgRes.json()) as { error: { code: string; message: string } };
        expect(notFoundOrgErr.error.code).toBe('NOT_FOUND');
        expect(notFoundOrgErr.error.message).toContain("Organization 'org_nonexistent' not found");

        // 5c. Denied cross-tenant access -> 403 FORBIDDEN
        const alice = await loginAs('alice');
        const forbiddenRes = await fetch(`${baseUrl}/api/dns/records?orgId=org_B`, {
            headers: { Cookie: alice.cookie },
        });
        expect(forbiddenRes.status).toBe(403);
        const forbiddenErr = (await forbiddenRes.json()) as { error: { code: string; message: string } };
        expect(forbiddenErr.error.code).toBe('FORBIDDEN');
    });

    it('6. type-level enforcement and runtime validation prevent unguarded expose entries', () => {
        const dummyContract = defineContract({
            domain: 'dummy',
            action: 'unguarded',
            description: 'Dummy',
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            rest: { method: 'GET', path: '/dummy/unguarded' },
            print: defaultPrint,
        });

        // 6a. Neither auth nor permission throws descriptive error
        expect(() => {
            validateExposeEntry({ contract: dummyContract });
        }).toThrow(/Unguarded contract: entry for 'dummy\.unguarded' must declare either 'auth' or 'permission'/);

        // 6b. Both auth and permission throws descriptive error
        expect(() => {
            validateExposeEntry({
                contract: dummyContract,
                auth: 'public',
                permission: 'dns.write',
            });
        }).toThrow(/Invalid expose entry for 'dummy\.unguarded': cannot declare both 'auth' and 'permission'/);
    });

    it('7. a service declaring a permission entry but supplying NO authorize hook safely refuses', async () => {
        const noHookContract = defineContract({
            domain: 'nohook',
            action: 'secret_action',
            description: 'Action requiring permission with no hook',
            inputSchema: z.object({}),
            outputSchema: z.object({ ok: z.boolean() }),
            rest: { method: 'GET', path: '/nohook/action' },
            print: defaultPrint,
        });

        class NoHookService extends WebServiceModule {
            public readonly domain = 'nohook';
            constructor() {
                super();
                this.mountTool(noHookContract, async () => ({ ok: true }));
                this.mountWeb({
                    expose: [
                        { contract: noHookContract, permission: 'nohook.run' },
                    ],
                });
            }
        }

        const noHookApp = new MeshApp({ nodeID: 'nohook-node', namespace: 'test' });
        noHookApp.use(new RegistryModule({ preferLocal: true }));
        noHookApp.use(new BrokerModule());
        await noHookApp.start();

        const noHookService = new NoHookService();
        await noHookApp.registerModule(noHookService);

        const noHookStore = new MemorySessionStore();
        const noHookExpress = express();
        const { router: noHookRouter } = createWebServer({
            app: noHookApp,
            modules: [noHookService],
            sessionStore: noHookStore,
            cookie: { secure: false },
        });
        noHookExpress.use(noHookRouter);

        let noHookServer: Server;
        let noHookBaseUrl = '';
        await new Promise<void>((resolve) => {
            noHookServer = noHookExpress.listen(0, () => {
                const addr = noHookServer.address();
                if (typeof addr === 'object' && addr !== null) {
                    noHookBaseUrl = `http://127.0.0.1:${addr.port}`;
                }
                resolve();
            });
        });

        try {
            // Unauthenticated -> 401
            const unauthedRes = await fetch(`${noHookBaseUrl}/api/nohook/action`);
            expect(unauthedRes.status).toBe(401);

            // Authenticated -> 403 (because no authorize hook is configured to evaluate permissions)
            const session = await noHookStore.create({ id: 'user_test', tenant_id: 'org_test' }, 60000);
            const authedRes = await fetch(`${noHookBaseUrl}/api/nohook/action`, {
                headers: { Cookie: `mesh_sid=${session.id}` },
            });
            expect(authedRes.status).toBe(403);
            const errBody = (await authedRes.json()) as { error: { message: string } };
            expect(errBody.error.message).toContain("No authorization hook configured to evaluate required permission 'nohook.run'");
        } finally {
            await new Promise<void>((resolve) => noHookServer.close(() => resolve()));
            await noHookApp.stop();
        }
    });

    it('8. MCP exposure evaluates authorize hook and injects resolvedScope into meta', async () => {
        const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { buildMcpServer } = await import('../src/index.js');

        const mcpServer = buildMcpServer(
            app.getProvider('broker'),
            [
                { contract: dnsRecordCreateContract, permission: 'dns.write' },
            ],
            { name: 'test-dns-mcp', version: '1.0.0' },
            {
                session: {
                    id: 'sess_alice',
                    user: { id: 'user_alice', tenant_id: 'org_A', roles: ['member'] },
                    csrfToken: 'csrf_1',
                    createdAt: Date.now(),
                    expiresAt: Date.now() + 60000,
                },
                authorize: async (input) => {
                    if (!input.user) return { authorized: false, status: 401, message: 'Unauthenticated' };
                    if (input.requestedScope && input.requestedScope !== input.userScope) {
                        return { authorized: false, status: 403, message: 'Cross-org forbidden' };
                    }
                    return {
                        authorized: true,
                        resolvedScope: input.requestedScope ?? input.userScope,
                    };
                },
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);

        const client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
        await client.connect(clientTransport);

        // Authorized call
        const res = await client.callTool({
            name: 'dns.record_create',
            arguments: { name: 'mcp.example.com', value: '1.2.3.4' },
        });
        expect(res.isError).toBeFalsy();

        // Cross-org unauthorized call
        const crossRes = await client.callTool({
            name: 'dns.record_create',
            arguments: { orgId: 'org_B', name: 'cross.example.com', value: '1.2.3.4' },
        });
        expect(crossRes.isError).toBe(true);

        await client.close();
        await mcpServer.close();
    });

    it('9. OpenAPI document correctly documents permission entries with security and 401/403 responses', async () => {
        const { buildOpenApiDocument } = await import('../src/index.js');

        const doc = buildOpenApiDocument(
            [
                { contract: dnsRecordCreateContract, permission: 'dns.write' },
                { contract: plansListContract, auth: 'public' },
                { contract: whoamiContract, auth: 'user' },
            ],
            { title: 'DNS API', version: '1.0.0' }
        );

        // Public endpoint
        expect(doc.paths['/plans']?.['get']?.security).toEqual([]);

        // Permission endpoint
        const dnsPost = doc.paths['/dns/records']?.['post'];
        expect(dnsPost?.security).toEqual([{ sessionAuth: [] }]);
        expect(dnsPost?.responses['401']).toBeDefined();
        expect(dnsPost?.responses['403']).toBeDefined();
    });
});
