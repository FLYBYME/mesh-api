import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    MeshApp,
    RegistryModule,
    BrokerModule,
    ServiceModule,
    defineContract,
    defaultPrint,
    MeshError,
    type IServiceBroker,
    z,
} from '@flybyme/mesh';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../src/exposure/mcp.js';
import type { ExposeEntry } from '../src/exposure/types.js';
import type { SessionRecord } from '../src/auth/types.js';

/**
 * The MCP SDK types `callTool`'s result loosely -- `content` comes back as `unknown`. Narrow it
 * once here, with real checks, rather than casting at each of the seven call sites: a cast would
 * pass the type-checker and then throw at runtime the first time the shape changed.
 */
function firstText(result: unknown): string {
    if (typeof result !== 'object' || result === null || !('content' in result)) {
        // The SDK's return type is a union -- the other branch carries `toolResult` and no
        // `content` at all, so this is a real case rather than defensive padding.
        throw new Error('MCP result carried no content blocks');
    }
    const { content } = result;
    if (!Array.isArray(content) || content.length === 0) {
        throw new Error('MCP result carried no content blocks');
    }
    const block: unknown = content[0];
    if (typeof block !== 'object' || block === null || !('text' in block)) {
        throw new Error('MCP result first content block is not a text block');
    }
    const { text } = block;
    if (typeof text !== 'string') {
        throw new Error('MCP text block carried a non-string text field');
    }
    return text;
}


// --- Fixture Contracts ---

const publicAddContract = defineContract({
    domain: 'calc',
    action: 'add',
    description: 'Add two numbers together',
    inputSchema: z.object({
        a: z.number().describe('First operand'),
        b: z.number().describe('Second operand'),
    }),
    outputSchema: z.object({
        result: z.number(),
    }),
    rest: { method: 'POST', path: '/calc/add' },
    print: (out) => `Result: ${out.result}`,
});

const userProfileContract = defineContract({
    domain: 'user',
    action: 'get_profile',
    description: 'Get profile for the authenticated caller',
    inputSchema: z.object({}),
    outputSchema: z.object({
        userId: z.string(),
        tenantId: z.string(),
    }),
    rest: { method: 'GET', path: '/user/profile' },
    print: defaultPrint,
});

const adminPurgeContract = defineContract({
    domain: 'admin',
    action: 'purge_logs',
    description: 'Purge system logs (destructive admin operation)',
    inputSchema: z.object({
        days: z.number(),
    }),
    outputSchema: z.object({
        purged: z.boolean(),
        count: z.number(),
    }),
    rest: { method: 'POST', path: '/admin/purge' },
    print: defaultPrint,
    destructive: true,
});

const internalUnexposedContract = defineContract({
    domain: 'secret',
    action: 'vault',
    description: 'Internal secret vault contract not exposed externally',
    inputSchema: z.object({
        passcode: z.string(),
    }),
    outputSchema: z.object({
        secretData: z.string(),
    }),
    rest: { method: 'POST', path: '/secret/vault' },
    print: defaultPrint,
});

// --- Fixture Service ---

class TestCalculationService extends ServiceModule {
    public readonly domain = 'calc';

    constructor() {
        super();
        this.mountTool(publicAddContract, async (input) => {
            return { result: input.a + input.b };
        });
    }
}

class TestUserService extends ServiceModule {
    public readonly domain = 'user';

    constructor() {
        super();
        this.mountTool(userProfileContract, async (_input, ctx) => {
            const user = ctx.meta?.user;
            if (!user) {
                throw new MeshError({ code: 'UNAUTHENTICATED', status: 401, message: 'User context missing' });
            }
            return {
                userId: user.id,
                tenantId: user.tenant_id,
            };
        });
    }
}

class TestAdminService extends ServiceModule {
    public readonly domain = 'admin';

    constructor() {
        super();
        this.mountTool(adminPurgeContract, async (input) => {
            return {
                purged: true,
                count: input.days * 10,
            };
        });
    }
}

class TestSecretService extends ServiceModule {
    public readonly domain = 'secret';

    constructor() {
        super();
        this.mountTool(internalUnexposedContract, async (input) => {
            return { secretData: `top-secret-${input.passcode}` };
        });
    }
}

describe('MCP Exposure (buildMcpServer)', () => {
    let app: MeshApp;
    let broker: IServiceBroker;

    const userSession: SessionRecord = {
        id: 'sess_alice',
        user: { id: 'alice_123', tenant_id: 'tenant_abc', roles: ['user'] },
        csrfToken: 'csrf_alice',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
    };

    const adminSession: SessionRecord = {
        id: 'sess_admin',
        user: { id: 'admin_root', tenant_id: 'tenant_abc', roles: ['admin', 'user'] },
        csrfToken: 'csrf_admin',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
    };

    beforeAll(async () => {
        app = new MeshApp({ nodeID: 'mcp-test-node', namespace: 'test' });
        app.use(new RegistryModule({ preferLocal: true }));
        app.use(new BrokerModule());
        await app.start();

        await app.registerModule(new TestCalculationService());
        await app.registerModule(new TestUserService());
        await app.registerModule(new TestAdminService());
        await app.registerModule(new TestSecretService());

        broker = app.getProvider<IServiceBroker>('broker');
    });

    afterAll(async () => {
        await app.stop();
    });

    it('exposes only declared contracts as MCP tools; unexposed contracts are absent', async () => {
        const exposed: ExposeEntry[] = [
            { contract: publicAddContract, auth: 'public' },
            { contract: userProfileContract, auth: 'user' },
            { contract: adminPurgeContract, auth: 'admin' },
            // internalUnexposedContract is registered on the broker but deliberately NOT exposed
        ];

        const mcpServer = buildMcpServer(broker, exposed, {
            name: 'test-mesh-mcp',
            version: '1.0.0',
            description: 'Mesh MCP Test Server',
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);

        const client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
        await client.connect(clientTransport);

        const toolsResult = await client.listTools();
        const toolNames = toolsResult.tools.map((t) => t.name);

        expect(toolNames).toContain('calc.add');
        expect(toolNames).toContain('user.get_profile');
        expect(toolNames).toContain('admin.purge_logs');
        expect(toolNames).not.toContain('secret.vault');

        // Check descriptions and annotations
        const addTool = toolsResult.tools.find((t) => t.name === 'calc.add');
        expect(addTool?.description).toBe('Add two numbers together');

        const purgeTool = toolsResult.tools.find((t) => t.name === 'admin.purge_logs');
        expect(purgeTool?.annotations?.destructiveHint).toBe(true);
        expect(purgeTool?.annotations?.readOnlyHint).toBe(false);

        await client.close();
        await mcpServer.close();
    });

    it('calls round-trip through a real broker and formats output via contract print helper', async () => {
        const exposed: ExposeEntry[] = [
            { contract: publicAddContract, auth: 'public' },
        ];

        const mcpServer = buildMcpServer(broker, exposed, {
            name: 'calc-mcp',
            version: '1.0.0',
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);

        const client = new Client({ name: 'test-client', version: '1.0.0' });
        await client.connect(clientTransport);

        const callResult = await client.callTool({
            name: 'calc.add',
            arguments: { a: 15, b: 27 },
        });

        expect(callResult.isError).toBeFalsy();
        expect(callResult.content).toEqual([
            {
                type: 'text',
                text: 'Result: 42',
            },
        ]);

        await client.close();
        await mcpServer.close();
    });

    it('enforces checkAuth: unauthenticated caller cannot execute auth: user tools', async () => {
        const exposed: ExposeEntry[] = [
            { contract: userProfileContract, auth: 'user' },
        ];

        // No session provided
        const mcpServer = buildMcpServer(broker, exposed, {
            name: 'user-mcp',
            version: '1.0.0',
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);

        const client = new Client({ name: 'test-client', version: '1.0.0' });
        await client.connect(clientTransport);

        const result = await client.callTool({
            name: 'user.get_profile',
            arguments: {},
        });

        expect(result.isError).toBe(true);
        expect(firstText(result)).toMatch(/Authentication required/i);

        await client.close();
        await mcpServer.close();
    });

    it('executes auth: user tools successfully when a valid user session is provided', async () => {
        const exposed: ExposeEntry[] = [
            { contract: userProfileContract, auth: 'user' },
        ];

        const mcpServer = buildMcpServer(
            broker,
            exposed,
            { name: 'user-mcp', version: '1.0.0' },
            { session: userSession }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);

        const client = new Client({ name: 'test-client', version: '1.0.0' });
        await client.connect(clientTransport);

        const result = await client.callTool({
            name: 'user.get_profile',
            arguments: {},
        });

        expect(result.isError).toBeFalsy();
        expect(result.content).toHaveLength(1);
        const parsed = JSON.parse(firstText(result));
        expect(parsed).toEqual({
            userId: 'alice_123',
            tenantId: 'tenant_abc',
        });

        await client.close();
        await mcpServer.close();
    });

    it('enforces checkAuth for auth: admin tools: non-admin session is rejected with FORBIDDEN', async () => {
        const exposed: ExposeEntry[] = [
            { contract: adminPurgeContract, auth: 'admin' },
        ];

        const mcpServer = buildMcpServer(
            broker,
            exposed,
            { name: 'admin-mcp', version: '1.0.0' },
            { session: userSession } // Alice has roles: ['user'], NOT 'admin'
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);

        const client = new Client({ name: 'test-client', version: '1.0.0' });
        await client.connect(clientTransport);

        const result = await client.callTool({
            name: 'admin.purge_logs',
            arguments: { days: 3 },
        });

        expect(result.isError).toBe(true);
        expect(firstText(result)).toMatch(/Insufficient privileges/i);

        await client.close();
        await mcpServer.close();
    });

    it('allows auth: admin tools when an admin session is provided', async () => {
        const exposed: ExposeEntry[] = [
            { contract: adminPurgeContract, auth: 'admin' },
        ];

        const mcpServer = buildMcpServer(
            broker,
            exposed,
            { name: 'admin-mcp', version: '1.0.0' },
            { session: adminSession }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);

        const client = new Client({ name: 'test-client', version: '1.0.0' });
        await client.connect(clientTransport);

        const result = await client.callTool({
            name: 'admin.purge_logs',
            arguments: { days: 5 },
        });

        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse(firstText(result));
        expect(parsed).toEqual({
            purged: true,
            count: 50,
        });

        await client.close();
        await mcpServer.close();
    });

    it('supports dynamic session accessor functions', async () => {
        const exposed: ExposeEntry[] = [
            { contract: userProfileContract, auth: 'user' },
        ];

        let currentSession: SessionRecord | undefined = undefined;

        const mcpServer = buildMcpServer(
            broker,
            exposed,
            { name: 'dynamic-mcp', version: '1.0.0' },
            { session: () => currentSession }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);

        const client = new Client({ name: 'test-client', version: '1.0.0' });
        await client.connect(clientTransport);

        // Initially unauthenticated -> fails
        const unauthResult = await client.callTool({ name: 'user.get_profile', arguments: {} });
        expect(unauthResult.isError).toBe(true);
        expect(firstText(unauthResult)).toMatch(/Authentication required/i);

        // Authenticate dynamically
        currentSession = userSession;

        const authResult = await client.callTool({ name: 'user.get_profile', arguments: {} });
        expect(authResult.isError).toBeFalsy();
        const parsed = JSON.parse(firstText(authResult));
        expect(parsed.userId).toBe('alice_123');

        await client.close();
        await mcpServer.close();
    });

    it('throws at build time when contract inputSchema is not an object schema, naming the tool key', () => {
        const invalidContract = defineContract({
            domain: 'invalid',
            action: 'scalar_input',
            description: 'Contract with a non-object input schema',
            inputSchema: z.string(),
            outputSchema: z.object({ ok: z.boolean() }),
            rest: { method: 'POST', path: '/invalid/scalar' },
            print: defaultPrint,
        });

        const exposed: ExposeEntry[] = [
            { contract: invalidContract, auth: 'public' },
        ];

        expect(() => {
            buildMcpServer(broker, exposed, {
                name: 'invalid-mcp',
                version: '1.0.0',
            });
        }).toThrow(/contract 'invalid\.scalar_input' inputSchema must be an object schema to expose over MCP/i);
    });
});
