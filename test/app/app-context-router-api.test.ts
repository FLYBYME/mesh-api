// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync, createScope, signal } from '../../src/runtime/reactivity/index.js';
import {
    defineApp,
    clearAppRegistry,
    createAppHost,
    AppContextImpl,
    AppStateContainerImpl,
    Compositor,
    type LayoutPolicy,
    type AppContext,
} from '../../src/runtime/app/index.js';
import { createRouter } from '../../src/runtime/router/router.js';
import type { Manifest } from '../../src/runtime/manifest/types.js';

function makePolicy(root: HTMLElement, regions: Record<string, { roles: readonly ('page' | 'panel' | 'popup' | 'banner' | 'overlay' | 'background')[] }>): LayoutPolicy {
    const built: Record<string, { roles: readonly ('page' | 'panel' | 'popup' | 'banner' | 'overlay' | 'background')[]; container: HTMLElement }> = {};
    for (const [name, cfg] of Object.entries(regions)) {
        const el = document.createElement('div');
        el.dataset.region = name;
        root.appendChild(el);
        built[name] = { roles: cfg.roles, container: el };
    }
    return { regions: built, root };
}

interface MockPaasApi {
    kanban: {
        board_list(query?: { repo?: string }): Promise<{ cards: Array<{ id: string; title: string }> }>;
        card_claim(input: { cardId: string }): Promise<{ card: { id: string; claimed: boolean } }>;
    };
}

describe('AppContext: router and api integration', () => {
    let root: HTMLElement;

    beforeEach(() => {
        clearAppRegistry();
        root = document.createElement('div');
        document.body.appendChild(root);
        window.history.replaceState(null, '', '/');
    });

    afterEach(() => {
        root.remove();
    });

    it('1. an app\'s onLoad receives a context on which router and api are present and usable', async () => {
        let loadedCtx: AppContext<MockPaasApi> | undefined;
        let fetchedCards: Array<{ id: string; title: string }> | undefined;

        const mockApi: MockPaasApi = {
            kanban: {
                board_list: vi.fn(async (_q) => ({
                    cards: [
                        { id: 'card-1', title: 'Implement router on AppContext' },
                        { id: 'card-2', title: 'Implement api on AppContext' },
                    ],
                })),
                card_claim: vi.fn(async (input) => ({
                    card: { id: input.cardId, claimed: true },
                })),
            },
        };

        const manifest: Manifest = {
            site: { id: 'console', title: 'Console' },
            layout: { regions: { content: { roles: ['page'] } } },
            apps: [
                {
                    id: 'kanban',
                    module: './apps/kanban.js',
                    load: 'eager',
                    surfaces: [{ role: 'page', route: '/kanban/*' }],
                },
            ],
        };

        defineApp<MockPaasApi>({
            id: 'kanban',
            title: 'Kanban',
            async onLoad(ctx) {
                loadedCtx = ctx;

                // 1. Router is present and usable on ctx
                expect(ctx.router).toBeDefined();
                expect(ctx.router?.appId).toBe('kanban');

                // 2. Query param binding is usable
                const filter = ctx.router?.queryParam('filter', 'all');
                expect(filter?.()).toBe('all');

                // 3. API client is present and usable on ctx
                expect(ctx.api).toBeDefined();
                if (ctx.api) {
                    const res = await ctx.api.kanban.board_list({ repo: 'paas' });
                    fetchedCards = res.cards;
                }
            },
        });

        const host = createAppHost({
            root,
            policy: makePolicy(root, { content: { roles: ['page'] } }),
            api: mockApi,
        });

        const router = createRouter({
            host,
            manifest,
        });

        await router.navigate('/kanban');
        flushSync();

        expect(loadedCtx).toBeDefined();
        expect(loadedCtx?.appId).toBe('kanban');
        expect(loadedCtx?.status).toBe('foreground');
        expect(mockApi.kanban.board_list).toHaveBeenCalledWith({ repo: 'paas' });
        expect(fetchedCards?.length).toBe(2);
        expect(fetchedCards?.[0]?.title).toBe('Implement router on AppContext');

        router.dispose();
        host.dispose();
    });

    it('2. ctx.router is scoped: an app mounted under a prefix navigates in its own coordinate space and the resulting URL carries the prefix', async () => {
        let remoteCtx: AppContext | undefined;

        const manifest: Manifest = {
            site: { id: 'console', title: 'Console' },
            layout: { regions: { content: { roles: ['page'] } } },
            remotes: [
                {
                    namespace: 'remote-shop',
                    mount: '/storefront',
                    origin: 'https://store.example.com',
                    apps: [
                        {
                            id: 'catalog',
                            module: './apps/catalog.js',
                            version: '1.0.0',
                            integrity: 'sha256-mockintegrityhash',
                            surfaces: [{ role: 'page', route: '/products/*' }],
                        },
                    ],
                },
            ],
        };

        defineApp({
            id: 'catalog',
            title: 'Catalog',
            async onLoad(ctx) {
                remoteCtx = ctx;
            },
        });

        const host = createAppHost({
            root,
            policy: makePolicy(root, { content: { roles: ['page'] } }),
        });

        const router = createRouter({
            host,
            manifest,
        });

        // 1. Navigate top-level URL to federated remote route
        await router.navigate('/storefront/products/item-123');
        flushSync();

        expect(remoteCtx).toBeDefined();
        expect(remoteCtx?.router).toBeDefined();
        expect(remoteCtx?.router?.namespace).toBe('remote-shop');
        expect(remoteCtx?.router?.mountPrefix).toBe('/storefront');

        // App-scoped router sees app-relative path (prefix stripped)
        expect(remoteCtx?.router?.currentPath()).toBe('/products/item-123');
        expect(router.fullPath()).toBe('/storefront/products/item-123');

        // 2. App navigates in its own coordinate space (unprefixed)
        if (remoteCtx?.router) {
            await remoteCtx.router.navigate('/products/item-456');
            flushSync();
        }

        // The top-level URL carries the /storefront prefix, while the app sees /products/item-456
        expect(router.fullPath()).toBe('/storefront/products/item-456');
        expect(remoteCtx?.router?.currentPath()).toBe('/products/item-456');

        // 3. Two-way queryParam binding maintains the prefix
        if (remoteCtx?.router) {
            const sortParam = remoteCtx.router.queryParam('sort', 'price');
            expect(sortParam()).toBe('price');

            sortParam.set('rating');
            flushSync();

            expect(router.fullPath()).toBe('/storefront/products/item-456?sort=rating');
            expect(remoteCtx.router.currentPath()).toBe('/products/item-456');
            expect(remoteCtx.router.query().get('sort')).toBe('rating');
        }

        router.dispose();
        host.dispose();
    });

    it('3. two concurrently-loaded apps get their own routers and do not share navigation state', async () => {
        let ctxA: AppContext | undefined;
        let ctxB: AppContext | undefined;

        const manifest: Manifest = {
            site: { id: 'console', title: 'Console' },
            layout: {
                regions: {
                    content: { roles: ['page'] },
                    sidebar: { roles: ['panel'] },
                },
            },
            apps: [
                {
                    id: 'app-a',
                    module: './apps/a.js',
                    surfaces: [{ role: 'page', route: '/app-a/*' }],
                },
                {
                    id: 'app-b',
                    module: './apps/b.js',
                    surfaces: [{ role: 'panel', route: '/app-b/*' }],
                },
            ],
        };

        defineApp({
            id: 'app-a',
            title: 'App A',
            onLoad(ctx) { ctxA = ctx; },
        });

        defineApp({
            id: 'app-b',
            title: 'App B',
            onLoad(ctx) { ctxB = ctx; },
        });

        const host = createAppHost({
            root,
            policy: makePolicy(root, {
                content: { roles: ['page'] },
                sidebar: { roles: ['panel'] },
            }),
        });

        const router = createRouter({
            host,
            manifest,
        });

        await host.loadApp('app-a');
        await host.loadApp('app-b');
        flushSync();

        expect(ctxA).toBeDefined();
        expect(ctxB).toBeDefined();
        expect(ctxA?.router).toBeDefined();
        expect(ctxB?.router).toBeDefined();

        // Distinct ScopedRouter instances per app
        expect(ctxA?.router).not.toBe(ctxB?.router);
        expect(ctxA?.router?.appId).toBe('app-a');
        expect(ctxB?.router?.appId).toBe('app-b');

        router.dispose();
        host.dispose();
    });

    it('4. unloading an app disposes whatever the context holds — no listener outlives the app', async () => {
        let cleanupRan = false;
        let effectRuns = 0;
        let testSignal: { (): number; set(v: number): void } | undefined;
        const trackedResource = {
            isDisposed: false,
            dispose(): void {
                this.isDisposed = true;
            },
        };

        defineApp({
            id: 'disposable-app',
            title: 'Disposable App',
            onLoad(ctx) {
                testSignal = ctx.state.signal(10);

                ctx.state.effect(() => {
                    if (testSignal) testSignal();
                    effectRuns++;
                });

                ctx.trackLeakable(trackedResource);
                ctx.registerCleanup(() => {
                    cleanupRan = true;
                    trackedResource.dispose();
                });
            },
        });

        const host = createAppHost({
            root,
            policy: makePolicy(root, { content: { roles: ['page'] } }),
            devMode: true,
        });

        await host.loadApp('disposable-app');
        flushSync();

        expect(effectRuns).toBe(1);
        expect(cleanupRan).toBe(false);
        expect(trackedResource.isDisposed).toBe(false);

        // Updating signal triggers effect
        testSignal?.set(20);
        flushSync();
        expect(effectRuns).toBe(2);

        // Unload app with leak assertion enabled
        await host.unloadApp('disposable-app', { assertNoLeaks: true });
        flushSync();

        // 1. Cleanup handler was executed
        expect(cleanupRan).toBe(true);
        expect(trackedResource.isDisposed).toBe(true);

        // 2. Reactive scope disposed: mutating signal after unload no longer triggers effect
        testSignal?.set(30);
        testSignal?.set(40);
        flushSync();
        expect(effectRuns).toBe(2);

        host.dispose();
    });

    it('5. a context constructed without a router behaves as documented (optional & safe degradation)', async () => {
        const scope = createScope();
        const state = new AppStateContainerImpl('test-bare', scope);
        const compositor = new Compositor({
            root,
            policy: { regions: {} },
        });

        // Bare context constructed without router or api
        const bareCtx = new AppContextImpl('test-bare', state, compositor);

        // 1. router is undefined rather than a silent null-object that swallows navigations
        expect(bareCtx.router).toBeUndefined();
        expect(bareCtx.api).toBeUndefined();

        // 2. Optional chaining on router?.navigate does not throw
        expect(() => {
            const navResult = bareCtx.router?.navigate('/somewhere');
            expect(navResult).toBeUndefined();
        }).not.toThrow();

        // 3. Narrowing pattern works cleanly
        let navigated = false;
        if (bareCtx.router) {
            await bareCtx.router.navigate('/somewhere');
            navigated = true;
        }
        expect(navigated).toBe(false);

        // 4. Running an app in an AppHost without routing infrastructure degrades safely
        let appRan = false;
        defineApp({
            id: 'no-router-app',
            title: 'No Router App',
            onLoad(ctx) {
                appRan = true;
                expect(ctx.router).toBeUndefined();
                if (ctx.router) {
                    void ctx.router.navigate('/path');
                }
            },
        });

        const bareHost = createAppHost({
            root,
            policy: makePolicy(root, { content: { roles: ['page'] } }),
        });

        await expect(bareHost.loadApp('no-router-app')).resolves.toBeUndefined();
        expect(appRan).toBe(true);

        bareHost.dispose();
        state.dispose();
        scope.dispose();
    });
});
