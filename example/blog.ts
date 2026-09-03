/**
 * A real API, for a real browser to call.
 *
 * mesh-web roadmap A3.1/C2 — the integration. Everything on both sides of this seam has been
 * verified against something the other side did not write: the browser's `net` client against a fake
 * transport, this server against a `Map` broker. Three times today a seam like that turned out to
 * have a bug in it, so this exists to find the next one.
 *
 * It is a whole site in one file: a mesh with a `post` domain, an identity that validates two
 * hard-coded tickets, an authorize hook with two organizations, and an exposure list. `npm run
 * example:blog` starts it; `npm run example:client` generates the browser's typed client from it.
 *
 * The data is in a `Map` because the *data* is not what is under test here — the boundary is.
 */

import { MeshApp, BrokerModule, RegistryModule, defineContract, z } from '@flybyme/mesh';
import type { IServiceContext, IServiceModule, ToolContract } from '@flybyme/mesh';

import { createApiModule, DeclaredFailure, describeExposure, type ExposeEntry } from '../src/index.js';

// ---------------------------------------------------------------------------- contracts

const PostSchema = z.object({
    slug: z.string().describe('The post’s stable id'),
    title: z.string(),
    published: z.boolean(),
    organizationId: z.string().describe('Which organization owns it'),
});

export const postListContract = defineContract({
    domain: 'post',
    action: 'list',
    description: 'Every post in the calling organization.',
    inputSchema: z.object({ includeDrafts: z.boolean().optional() }),
    outputSchema: z.object({ items: z.array(PostSchema), organization: z.string() }),
    rest: { method: 'GET', path: '/post' },
    visibility: 'public',
    print: String,
});

export const postCreateContract = defineContract({
    domain: 'post',
    action: 'create',
    description: 'Start a new draft.',
    inputSchema: z.object({ title: z.string().min(1) }),
    outputSchema: PostSchema,
    rest: { method: 'POST', path: '/post' },
    visibility: 'public',
    destructive: true,
    print: String,
});

export const postPublishContract = defineContract({
    domain: 'post',
    action: 'publish',
    description: 'Publish or unpublish a post.',
    inputSchema: z.object({ slug: z.string() }),
    outputSchema: PostSchema,
    rest: { method: 'POST', path: '/post/publish' },
    visibility: 'public',
    destructive: true,
    print: String,
});

const ticketValidateContract = defineContract({
    domain: 'identity',
    action: 'ticket_validate',
    description: 'Is this ticket valid, and whose is it.',
    inputSchema: z.object({ ticket: z.string() }),
    outputSchema: z.object({
        valid: z.boolean(),
        userId: z.string().optional(),
        roles: z.array(z.string()).optional(),
    }),
    rest: { method: 'POST', path: '/internal/ticket/validate' },
    print: String,
});

// ---------------------------------------------------------------------------- the site's exposure

/**
 * What this site serves, and to whom.
 *
 * `identity.ticket_validate` is deliberately **not** here. The API calls it over the mesh; putting
 * it on the internet would let anyone test tickets against it.
 */
export const expose: readonly ExposeEntry[] = [
    { contract: postListContract as unknown as ExposeEntry['contract'], auth: 'user' },
    {
        contract: postCreateContract as unknown as ExposeEntry['contract'],
        permission: 'post.write',
        errors: ['title_taken'],
    },
    {
        contract: postPublishContract as unknown as ExposeEntry['contract'],
        permission: 'post.write',
        errors: ['not_found'],
    },
];

// ---------------------------------------------------------------------------- the mesh side

const tickets: Record<string, { userId: string; roles: string[] }> = {
    'alice-ticket': { userId: 'u-alice', roles: [] },
    'bob-ticket': { userId: 'u-bob', roles: [] },
};

/** alice writes in org-a; bob only reads, and in a different organization. */
const memberships: Record<string, { org: string; permissions: string[] }> = {
    'u-alice': { org: 'org-a', permissions: ['post.write'] },
    'u-bob': { org: 'org-b', permissions: [] },
};

const posts = new Map<string, z.infer<typeof PostSchema>>([
    ['welcome', { slug: 'welcome', title: 'A window you can drag', published: true, organizationId: 'org-a' }],
    ['fine', { slug: 'fine', title: 'Fine-grained, no diffing', published: false, organizationId: 'org-a' }],
    ['kernel', { slug: 'kernel', title: 'The kernel drives everything', published: true, organizationId: 'org-a' }],
    ['other', { slug: 'other', title: 'Not yours', published: true, organizationId: 'org-b' }],
]);

/**
 * A failure this site named in its exposure list.
 *
 * Before `DeclaredFailure` existed, this was a plain `Error` subclass — and a plain Error is an
 * *unexpected* failure, so it became a 500 with no detail. The declared errors in the exposure list
 * above were therefore unreachable: declared on one side, undeliverable on the other, with nothing
 * failing to say so.
 */
const failed = (name: 'title_taken' | 'not_found', message: string): DeclaredFailure =>
    new DeclaredFailure(name, message, name === 'not_found' ? 404 : 409);

function siteModule(): IServiceModule {
    const contracts = [
        postListContract, postCreateContract, postPublishContract, ticketValidateContract,
    ] as unknown as ToolContract<z.ZodTypeAny, z.ZodTypeAny>[];

    return {
        domain: 'post',
        getContracts: () => contracts,
        isCrud: () => false,
        getEventHandlers: () => new Map(),
        async beforeCrud(_d, _a, input) { return input; },
        async afterCrud(_d, _a, output) { return output; },

        async execute(domain: string, action: string, input: unknown, ctx: IServiceContext): Promise<unknown> {
            const key = `${domain}.${action}`;

            if (key === 'identity.ticket_validate') {
                const found = tickets[(input as { ticket: string }).ticket];
                return found === undefined ? { valid: false } : { valid: true, ...found };
            }

            // The scope the API resolved from the caller's memberships. Not from the request.
            const scope = (ctx.meta as { user?: { tenant_id?: string } } | undefined)?.user?.tenant_id ?? '';

            if (key === 'post.list') {
                const drafts = (input as { includeDrafts?: boolean }).includeDrafts ?? true;
                return {
                    organization: scope,
                    items: [...posts.values()]
                        .filter((p) => p.organizationId === scope)
                        .filter((p) => drafts || p.published),
                };
            }

            if (key === 'post.create') {
                const title = (input as { title: string }).title;
                const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                if (posts.has(slug)) throw failed('title_taken', `A post called “${title}” already exists.`);
                const created = { slug, title, published: false, organizationId: scope };
                posts.set(slug, created);
                return created;
            }

            if (key === 'post.publish') {
                const slug = (input as { slug: string }).slug;
                const post = posts.get(slug);
                // Scoped here too, so a caller cannot flip a post in another organization by
                // naming its slug — the gate placed them in a scope, and the handler honours it.
                if (post === undefined || post.organizationId !== scope) {
                    throw failed('not_found', 'No such post.');
                }
                const next = { ...post, published: !post.published };
                posts.set(slug, next);
                return next;
            }

            throw new Error(`no such action ${key}`);
        },
    };
}

// ---------------------------------------------------------------------------- boot

const PORT = Number(process.env['PORT'] ?? 5005);

export async function start(port = PORT): Promise<{ stop: () => Promise<void>; port: number }> {
    const app = new MeshApp({ nodeID: 'blog-api', namespace: 'mesh-api-example' });
    app.use(new RegistryModule());
    app.use(new BrokerModule());
    await app.start();
    await app.registerModule(siteModule());

    const api = createApiModule({
        application: 'demo.blog',
        expose,
        port,
        host: '127.0.0.1',
        validateTool: 'identity.ticket_validate',

        // The harness is served from another port, so the browser treats this as cross-origin.
        // Which origins may call a site is part of what the site exposes, not a server default.
        allowOrigins: [
            'http://localhost:8080', 'http://127.0.0.1:8080',   // the harness
            'http://localhost:5174', 'http://127.0.0.1:5174',   // mesh-web's browser test project
        ],

        authorize: ({ caller, requestedScope, permission }) => {
            if (caller === undefined) return { authorized: true };

            const membership = memberships[caller.userId];
            if (membership === undefined) {
                return { authorized: false, status: 403, code: 'NO_ORGANIZATION', message: 'You belong to no organization.' };
            }
            if (requestedScope !== undefined && requestedScope !== membership.org) {
                // 404 rather than 403: "it exists but is not yours" is itself a disclosure.
                return { authorized: false, status: 404, code: 'NOT_FOUND', message: 'No such organization.' };
            }
            if (permission !== undefined && !membership.permissions.includes(permission)) {
                return { authorized: false, status: 403, code: 'FORBIDDEN', message: `Your role does not grant ${permission}.` };
            }
            return { authorized: true, resolvedScope: membership.org };
        },

        onError: (error, { key }) => {
            // A declared failure is an outcome, not a fault. Logging it as one trains people to
            // ignore the log.
            if (error instanceof DeclaredFailure) return;
            process.stderr.write(`[${key}] ${String(error)}\n`);
        },
    });

    await app.registerModule(api);

    return {
        port,
        stop: async () => {
            await api.onStop?.(undefined as never);
            await app.stop();
        },
    };
}

/** The descriptor, for the client generator. Same list, so the two cannot disagree. */
export const descriptor = (): ReturnType<typeof describeExposure> =>
    describeExposure(expose, { application: 'demo.blog' });

if (process.argv[1]?.endsWith('blog.js') === true) {
    void start().then(({ port }) => {
        process.stdout.write(`blog API on http://127.0.0.1:${String(port)}/api\n`);
        process.stdout.write(`  tickets: alice-ticket (writes, org-a) · bob-ticket (reads, org-b)\n`);
    });
}
