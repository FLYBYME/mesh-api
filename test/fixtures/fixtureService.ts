import { z, defineContract, defaultPrint, MeshError } from '@flybyme/mesh';
import { WebServiceModule } from '../../src/index.js';

export const echoContract = defineContract({
    domain: 'fixture',
    action: 'echo',
    description: 'Echoes a message and checks caller identity',
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ reply: z.string(), receivedUser: z.string().optional() }),
    rest: { method: 'POST', path: '/echo' },
    print: defaultPrint,
    destructive: true,
});

export const publicListContract = defineContract({
    domain: 'fixture',
    action: 'list',
    description: 'Lists items with optional limit coerced from query',
    inputSchema: z.object({ limit: z.number().optional() }),
    outputSchema: z.object({ items: z.array(z.string()), limitReceived: z.number().optional() }),
    rest: { method: 'GET', path: '/items' },
    print: defaultPrint,
});

export const userProfileContract = defineContract({
    domain: 'fixture',
    action: 'user_profile',
    description: 'Returns the user profile resolved from session meta',
    inputSchema: z.object({}),
    outputSchema: z.object({ userId: z.string(), tenantId: z.string() }),
    rest: { method: 'GET', path: '/profile' },
    print: defaultPrint,
});

export const adminActionContract = defineContract({
    domain: 'fixture',
    action: 'admin_purge',
    description: 'Performs an admin-only destructive purge',
    inputSchema: z.object({ reason: z.string() }),
    outputSchema: z.object({ purged: z.boolean(), reason: z.string() }),
    rest: { method: 'POST', path: '/admin/purge' },
    print: defaultPrint,
    destructive: true,
});

export const notFoundContract = defineContract({
    domain: 'fixture',
    action: 'throws_not_found',
    description: 'Throws a 404 MeshError',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    rest: { method: 'GET', path: '/not-found-item' },
    print: defaultPrint,
});

export const serverErrorContract = defineContract({
    domain: 'fixture',
    action: 'throws_error',
    description: 'Throws an unhandled internal Error',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    rest: { method: 'GET', path: '/server-error' },
    print: defaultPrint,
});

export const unexposedContract = defineContract({
    domain: 'fixture',
    action: 'internal_secret',
    description: 'Internal contract registered on mesh but NOT exposed to web',
    inputSchema: z.object({}),
    outputSchema: z.object({ secret: z.string() }),
    rest: { method: 'GET', path: '/internal/secret' },
    print: defaultPrint,
});

export class FixtureService extends WebServiceModule {
    public readonly domain = 'fixture';

    constructor() {
        super();

        this.mountTool(echoContract, async (input, ctx) => {
            return {
                reply: input.message,
                receivedUser: ctx.meta?.user?.id,
            };
        });

        this.mountTool(publicListContract, async (input) => {
            return {
                items: ['item1', 'item2'],
                limitReceived: input.limit,
            };
        });

        this.mountTool(userProfileContract, async (_input, ctx) => {
            const user = ctx.meta?.user;
            if (!user) {
                throw new MeshError({ code: 'UNAUTHENTICATED', status: 401, message: 'User meta missing' });
            }
            return {
                userId: user.id,
                tenantId: user.tenant_id,
            };
        });

        this.mountTool(adminActionContract, async (input) => {
            return {
                purged: true,
                reason: input.reason,
            };
        });

        this.mountTool(notFoundContract, async () => {
            throw new MeshError({ code: 'NOT_FOUND', status: 404, message: 'Resource not found' });
        });

        this.mountTool(serverErrorContract, async () => {
            throw new Error('Secret database password leaked');
        });

        this.mountTool(unexposedContract, async () => {
            return { secret: 'top_secret' };
        });

        this.mountWeb({
            expose: [
                { contract: echoContract, auth: 'user' },
                { contract: publicListContract, auth: 'public' },
                { contract: userProfileContract, auth: 'user' },
                { contract: adminActionContract, auth: 'admin' },
                { contract: notFoundContract, auth: 'public' },
                { contract: serverErrorContract, auth: 'public' },
                // unexposedContract is intentionally omitted to verify exposure policy enforcement
            ],
        });
    }
}
