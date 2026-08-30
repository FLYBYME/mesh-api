// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { flushSync, signal, effect } from '../../src/runtime/reactivity/index.js';
import {
    defineApp,
    clearAppRegistry,
    createAppHost,
    type LayoutPolicy,
    type AppContext,
    type ViewDefinition,
} from '../../src/runtime/app/index.js';
import type { ViewProps } from '../../src/runtime/router/types.js';
import { createRouter } from '../../src/runtime/router/router.js';
import type { Manifest } from '../../src/runtime/manifest/types.js';
import { h, Badge, Table, Heading, Text, type TableColumn } from '../../src/runtime/dom/index.js';

function makePolicy(
    root: HTMLElement,
    regions: Record<string, { roles: readonly ('page' | 'panel' | 'popup' | 'banner' | 'overlay' | 'background')[] }>
): LayoutPolicy {
    const built: Record<string, { roles: readonly ('page' | 'panel' | 'popup' | 'banner' | 'overlay' | 'background')[]; container: HTMLElement }> = {};
    for (const [name, cfg] of Object.entries(regions)) {
        const el = document.createElement('div');
        el.dataset.region = name;
        root.appendChild(el);
        built[name] = { roles: cfg.roles, container: el };
    }
    return { regions: built, root };
}

describe('Consumer Findings 2, 3, 5, 6 verification', () => {
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

    // --- Finding 2: SurfaceDefinition.views & Prefix Transparency ---
    it('1. an app declares two views; navigating between them mounts and unmounts the right one, and URL carries mount prefix without app naming it', async () => {
        interface ShopState {
            selectedId: { (): string; set(v: string): void };
        }

        const manifest: Manifest = {
            site: { id: 'console', title: 'Console' },
            layout: { regions: { main: { roles: ['page'] } } },
            remotes: [
                {
                    namespace: 'remote-shop',
                    mount: '/storefront/shop',
                    origin: 'https://store.example.com',
                    apps: [
                        {
                            id: 'catalog',
                            module: './apps/catalog.js',
                            version: '1.0.0',
                            integrity: 'sha256-catalogintegrity',
                            surfaces: [{ role: 'page', route: '/*' }],
                        },
                    ],
                },
            ],
        };

        const views: readonly ViewDefinition[] = [
            {
                path: '/',
                view: (props: ViewProps) => {
                    const el = h('div', { class: 'catalog-list-view' },
                        Heading({ level: 1 }, 'Catalog List'),
                        h('button', {
                            id: 'goto-item-btn',
                            onClick: () => props.router.navigate('/item/42'),
                        }, 'Go to Item 42')
                    );
                    return el;
                },
            },
            {
                path: '/item/:id',
                view: (props: ViewProps) => {
                    const el = h('div', { class: 'catalog-item-view' },
                        Heading({ level: 1 }, 'Catalog Item'),
                        Text({ class: 'item-id-display' }, () => `Item ID: ${props.params().id}`),
                        h('button', {
                            id: 'back-btn',
                            onClick: () => props.router.navigate('/'),
                        }, 'Back to List')
                    );
                    return el;
                },
            },
        ];

        defineApp({
            id: 'catalog',
            title: 'Catalog',
            onLoad(ctx: AppContext) {
                ctx.state.set<ShopState>({
                    selectedId: ctx.state.signal(''),
                });
            },
            surfaces: [
                {
                    role: 'page',
                    route: '/*',
                    views,
                },
            ],
        });

        const host = createAppHost({
            root,
            policy: makePolicy(root, { main: { roles: ['page'] } }),
        });

        const router = createRouter({
            host,
            manifest,
        });

        // 1. Initial navigation to storefront route
        await router.navigate('/storefront/shop');
        flushSync();

        // App-scoped views mounted automatically inside page region
        const pageContainer = root.querySelector('[data-region="main"]');
        expect(pageContainer?.querySelector('.catalog-list-view')).not.toBeNull();
        expect(pageContainer?.querySelector('.catalog-item-view')).toBeNull();

        // 2. Click button inside View 1 to navigate to View 2 in app coordinate space
        const gotoBtn = pageContainer?.querySelector('#goto-item-btn') as HTMLButtonElement;
        expect(gotoBtn).not.toBeNull();
        gotoBtn.click();
        flushSync();

        // Prefix transparency: top-level URL is /storefront/shop/item/42
        expect(router.fullPath()).toBe('/storefront/shop/item/42');

        // View 2 is now mounted and View 1 is unmounted
        expect(pageContainer?.querySelector('.catalog-list-view')).toBeNull();
        const itemView = pageContainer?.querySelector('.catalog-item-view');
        expect(itemView).not.toBeNull();
        expect(itemView?.querySelector('.item-id-display')?.textContent).toBe('Item ID: 42');

        // 3. Click back button inside View 2 to navigate back to View 1
        const backBtn = pageContainer?.querySelector('#back-btn') as HTMLButtonElement;
        expect(backBtn).not.toBeNull();
        backBtn.click();
        flushSync();

        expect(router.fullPath()).toBe('/storefront/shop');
        expect(pageContainer?.querySelector('.catalog-list-view')).not.toBeNull();
        expect(pageContainer?.querySelector('.catalog-item-view')).toBeNull();

        router.dispose();
        host.dispose();
    });

    // --- Finding 2: View Scope Lifecycle & Cleanup on Navigation Away ---
    it('2. a view\'s cleanup runs on navigation away — no effect outlives its view', async () => {
        let view1EffectRuns = 0;
        let view2EffectRuns = 0;
        const testSignal1 = signal(1);
        const testSignal2 = signal(100);

        const manifest: Manifest = {
            site: { id: 'console', title: 'Console' },
            layout: { regions: { main: { roles: ['page'] } } },
            apps: [
                {
                    id: 'cleanup-app',
                    module: './apps/cleanup.js',
                    surfaces: [{ role: 'page', route: '/app/*' }],
                },
            ],
        };

        defineApp({
            id: 'cleanup-app',
            title: 'Cleanup App',
            surfaces: [
                {
                    role: 'page',
                    route: '/app/*',
                    views: [
                        {
                            path: '/first',
                            view: () => {
                                // Effect registered inside view function body
                                effect(() => {
                                    testSignal1();
                                    view1EffectRuns++;
                                });
                                return h('div', { id: 'view-first' }, 'First View');
                            },
                        },
                        {
                            path: '/second',
                            view: () => {
                                effect(() => {
                                    testSignal2();
                                    view2EffectRuns++;
                                });
                                return h('div', { id: 'view-second' }, 'Second View');
                            },
                        },
                    ],
                },
            ],
        });

        const host = createAppHost({
            root,
            policy: makePolicy(root, { main: { roles: ['page'] } }),
        });

        const router = createRouter({ host, manifest });

        // Mount View 1
        await router.navigate('/app/first');
        flushSync();

        expect(view1EffectRuns).toBe(1);
        expect(view2EffectRuns).toBe(0);

        // Mutating View 1's signal while View 1 is active triggers its effect
        testSignal1.set(2);
        flushSync();
        expect(view1EffectRuns).toBe(2);

        // Navigate to View 2
        await router.navigate('/app/second');
        flushSync();

        expect(view2EffectRuns).toBe(1);

        // Crucial assertion: mutating View 1's signal after navigating away does NOT run View 1's effect
        testSignal1.set(3);
        testSignal1.set(4);
        flushSync();
        expect(view1EffectRuns).toBe(2); // Still 2! Isolated ReactiveScope was disposed on navigation away.

        // Mutating View 2's signal runs View 2's effect
        testSignal2.set(200);
        flushSync();
        expect(view2EffectRuns).toBe(2);

        router.dispose();
        host.dispose();
    });

    // --- Finding 5: Badge Reactive Variant Binding ---
    it('3. a Badge bound to a signal changes variant when the signal changes, with flushSync()', () => {
        const statusSignal = signal<'pending' | 'verified' | 'failed'>('pending');

        const badge = Badge(
            {
                variant: () => {
                    const s = statusSignal();
                    return s === 'verified' ? 'success' : s === 'failed' ? 'danger' : 'warning';
                },
                class: 'test-badge',
            },
            () => statusSignal()
        );

        root.appendChild(badge);
        flushSync();

        // 1. Initial state: pending -> warning variant
        expect(badge.className).toContain('mesh-badge-variant-warning');
        expect(badge.textContent).toBe('pending');

        // 2. Signal change: verified -> success variant
        statusSignal.set('verified');
        flushSync();
        expect(badge.className).toContain('mesh-badge-variant-success');
        expect(badge.className).not.toContain('mesh-badge-variant-warning');
        expect(badge.textContent).toBe('verified');

        // 3. Signal change: failed -> danger variant
        statusSignal.set('failed');
        flushSync();
        expect(badge.className).toContain('mesh-badge-variant-danger');
        expect(badge.className).not.toContain('mesh-badge-variant-success');
        expect(badge.textContent).toBe('failed');
    });

    // --- Finding 6: Table Typing & Row DOM Identity Preservation on Re-sort ---
    it('4. a Table re-sort still moves row nodes rather than recreating them (assert node identity) after typing change', () => {
        interface User {
            id: string;
            name: string;
            age: number;
            role: string;
        }

        const users = signal<readonly User[]>([
            { id: 'u1', name: 'Charlie', age: 35, role: 'admin' },
            { id: 'u2', name: 'Alice', age: 28, role: 'developer' },
            { id: 'u3', name: 'Bob', age: 42, role: 'manager' },
        ]);

        // Verified: TableColumn strongly types value as T[K] without any casts
        const columns: TableColumn<User>[] = [
            {
                key: 'name',
                label: 'User Name',
                sortable: true,
                render: (val, row) => h('span', { class: 'user-name-cell' }, `${val} (${row.role})`),
            },
            {
                key: 'age',
                label: 'Age',
                sortable: true,
                render: (val) => h('span', { class: 'user-age-cell' }, String(val)),
            },
        ];

        const table = Table<User>({
            rows: users,
            key: 'id',
            sortable: true,
            columns,
        });

        root.appendChild(table);
        flushSync();

        const tbody = table.querySelector('tbody');
        expect(tbody).not.toBeNull();

        const initialRows = Array.from(tbody!.querySelectorAll('tr'));
        expect(initialRows.length).toBe(3);

        const rowCharlie = initialRows[0];
        const rowAlice = initialRows[1];
        const rowBob = initialRows[2];

        expect(rowCharlie?.textContent).toContain('Charlie');
        expect(rowAlice?.textContent).toContain('Alice');
        expect(rowBob?.textContent).toContain('Bob');

        // Click on the 'User Name' header to sort ascending: Alice, Bob, Charlie
        const nameHeader = table.querySelector('th') as HTMLTableCellElement;
        expect(nameHeader).not.toBeNull();
        nameHeader.click();
        flushSync();

        const sortedRows = Array.from(tbody!.querySelectorAll('tr'));
        expect(sortedRows.length).toBe(3);

        // Strict Node Identity assertion: DOM nodes were reordered, NOT recreated
        expect(sortedRows[0]).toBe(rowAlice);
        expect(sortedRows[1]).toBe(rowBob);
        expect(sortedRows[2]).toBe(rowCharlie);
    });

    // --- Finding 3: AppStateContainer Store Pinning Decision ---
    it('5. AppStateContainer store helpers (set and get) provide typed, instance-isolated state sharing', async () => {
        interface CustomAppState {
            counter: { (): number; set(v: number): void };
            title: { (): string; set(v: string): void };
        }

        let instance1State: CustomAppState | undefined;
        let instance2State: CustomAppState | undefined;

        let ctx1: AppContext | undefined;

        defineApp({
            id: 'state-pinned-app-1',
            title: 'App 1',
            onLoad(ctx) {
                ctx1 = ctx;
                const s: CustomAppState = {
                    counter: ctx.state.signal(10),
                    title: ctx.state.signal('App 1 Title'),
                };
                ctx.state.set(s);
            },
            surfaces: [
                {
                    role: 'page',
                    mount(_container, ctx) {
                        instance1State = ctx.state.get<CustomAppState>();
                    },
                },
            ],
        });

        defineApp({
            id: 'state-pinned-app-2',
            title: 'App 2',
            onLoad(ctx) {
                const s: CustomAppState = {
                    counter: ctx.state.signal(99),
                    title: ctx.state.signal('App 2 Title'),
                };
                ctx.state.set(s);
            },
            surfaces: [
                {
                    role: 'page',
                    mount(_container, ctx) {
                        instance2State = ctx.state.get<CustomAppState>();
                    },
                },
            ],
        });

        const host = createAppHost({
            root,
            policy: makePolicy(root, { content: { roles: ['page'] } }),
        });

        await host.loadApp('state-pinned-app-1');
        await host.activateApp('state-pinned-app-1');
        await host.loadApp('state-pinned-app-2');
        await host.activateApp('state-pinned-app-2');
        flushSync();

        // 1. Both instances retrieved their own typed state containers via get()
        expect(instance1State).toBeDefined();
        expect(instance2State).toBeDefined();

        expect(instance1State?.counter()).toBe(10);
        expect(instance1State?.title()).toBe('App 1 Title');

        expect(instance2State?.counter()).toBe(99);
        expect(instance2State?.title()).toBe('App 2 Title');

        // 2. Modifying state on instance 1 does not pollute instance 2
        instance1State?.counter.set(11);
        flushSync();
        expect(instance1State?.counter()).toBe(11);
        expect(instance2State?.counter()).toBe(99);

        // 3. get() before set() throws informative error
        defineApp({
            id: 'unset-state-app',
            title: 'Unset App',
            onLoad(ctx) {
                expect(() => ctx.state.get()).toThrowError(/No state has been set on AppState for "unset-state-app"/);
            },
        });
        await host.loadApp('unset-state-app');

        // 4. Calling get() or set() on disposed state throws
        await host.unloadApp('state-pinned-app-1');
        expect(() => ctx1?.state.get()).toThrowError(/Cannot get state on disposed AppState/);
        expect(() => ctx1?.state.set({})).toThrowError(/Cannot set state on disposed AppState/);

        host.dispose();
    });
});
