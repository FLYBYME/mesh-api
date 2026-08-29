// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { flushSync, createScope } from '../../src/runtime/reactivity/index.js';
import {
    defineApp,
    clearAppRegistry,
    createAppHost,
    AppStateContainerImpl,
    MemoryStorage,
    type AppContext,
    type LayoutPolicy,
    type SurfaceResult,
} from '../../src/runtime/app/index.js';

// Dispatch 5 was killed by a quota lock before writing any tests, so this file is the only
// verification this layer has. Written against the properties spec/03 and spec/04 say are
// load-bearing, not against whatever the implementation happens to do.

function makePolicy(root: HTMLElement, regions: Record<string, { roles: readonly string[] }>): LayoutPolicy {
    const built: Record<string, { roles: readonly ('page' | 'panel' | 'popup' | 'banner' | 'overlay' | 'background')[]; container: HTMLElement }> = {};
    for (const [name, cfg] of Object.entries(regions)) {
        const el = document.createElement('div');
        el.dataset.region = name;
        root.appendChild(el);
        const roles = cfg.roles.filter((r): r is 'page' | 'panel' | 'popup' | 'banner' | 'overlay' | 'background' =>
            ['page', 'panel', 'popup', 'banner', 'overlay', 'background'].includes(r));
        built[name] = { roles, container: el };
    }
    return { regions: built, root };
}

describe('an app can never place itself', () => {
    it('receives a context with no positioning, selector, or region API at all', async () => {
        clearAppRegistry();
        const root = document.createElement('div');
        document.body.appendChild(root);
        let captured: AppContext | undefined;

        defineApp({ id: 'inspector', title: 'Inspector', onLoad(ctx) { captured = ctx; } });
        const host = createAppHost({ policy: makePolicy(root, { content: { roles: ['page'] } }), root });
        await host.loadApp('inspector');

        if (!captured) throw new Error('onLoad never ran');
        // This is the Wayland property, and it has to hold structurally rather than by convention:
        // an app that *cannot* express a position cannot misbehave into the wrong one. Asserting
        // the absence of the capability is the only way to test "impossible" rather than "discouraged".
        const keys = Object.keys(captured).concat(
            Object.getOwnPropertyNames(Object.getPrototypeOf(captured) ?? {})
        );
        for (const forbidden of ['mount', 'container', 'element', 'region', 'querySelector', 'appendTo', 'position', 'placeAt', 'root']) {
            expect(keys).not.toContain(forbidden);
        }
        host.dispose();
        root.remove();
    });
});

describe('surface refusal is explicit and un-ignorable', () => {
    it('refuses a panel under a layout with no panel region, as data rather than a throw or a null', async () => {
        clearAppRegistry();
        const root = document.createElement('div');
        document.body.appendChild(root);
        let result: SurfaceResult | undefined;

        defineApp({
            id: 'panel-wanter',
            title: 'Panel Wanter',
            async onLoad(ctx) { result = await ctx.requestSurface({ role: 'panel' }); },
        });
        // A page region only -- exactly the storefront-shell case spec/03 describes.
        const host = createAppHost({ policy: makePolicy(root, { content: { roles: ['page'] } }), root });
        await host.loadApp('panel-wanter');

        if (!result) throw new Error('requestSurface never resolved');
        expect(result.granted).toBe(false);
        // The discriminated union is what makes refusal un-ignorable: `container` is not reachable
        // without narrowing on `granted` first, so a caller cannot accidentally use a refused
        // surface. A nullable container would compile and fail at runtime instead.
        if (result.granted === false) {
            expect(typeof result.reason).toBe('string');
        }
        host.dispose();
        root.remove();
    });

    it('grants the same request under a layout that does have the region', async () => {
        clearAppRegistry();
        const root = document.createElement('div');
        document.body.appendChild(root);
        let result: SurfaceResult | undefined;

        defineApp({
            id: 'panel-wanter-2',
            title: 'Panel Wanter 2',
            async onLoad(ctx) { result = await ctx.requestSurface({ role: 'panel' }); },
        });
        const host = createAppHost({ policy: makePolicy(root, { sidebar: { roles: ['panel'] }, content: { roles: ['page'] } }), root });
        await host.loadApp('panel-wanter-2');

        // The same app, unchanged, running under a different shell. That portability is the point.
        expect(result?.granted).toBe(true);
        host.dispose();
        root.remove();
    });
});

describe('backgrounding is not teardown', () => {
    it('preserves state and DOM across deactivate/activate', async () => {
        clearAppRegistry();
        const root = document.createElement('div');
        document.body.appendChild(root);
        let counter: { (): number; set(v: number): void } | undefined;
        let mountCount = 0;
        let container: HTMLElement | undefined;

        defineApp({
            id: 'terminal',
            title: 'Terminal',
            async onLoad(ctx) {
                counter = ctx.state.signal(0);
                const surface = await ctx.requestSurface({ role: 'page' });
                if (surface.granted) {
                    container = surface.container;
                    mountCount++;
                    surface.container.textContent = 'session';
                }
            },
        });
        const host = createAppHost({ policy: makePolicy(root, { content: { roles: ['page'] } }), root });
        await host.loadApp('terminal');
        await host.activateApp('terminal');

        counter?.set(42);
        flushSync();

        await host.deactivateApp('terminal');
        expect(host.getAppState('terminal')).toBe('background');
        await host.activateApp('terminal');

        // A backgrounded app that lost its state would make task switching useless -- switching
        // away from a live terminal and back must not drop the session.
        expect(counter?.()).toBe(42);
        expect(mountCount).toBe(1);
        expect(container?.textContent).toBe('session');
        host.dispose();
        root.remove();
    });
});

describe('unload releases everything', () => {
    it('stops an app effect after unload', async () => {
        clearAppRegistry();
        const root = document.createElement('div');
        document.body.appendChild(root);
        let ticks = 0;
        let sig: { (): number; set(v: number): void } | undefined;

        defineApp({
            id: 'ticker',
            title: 'Ticker',
            onLoad(ctx) {
                sig = ctx.state.signal(0);
                ctx.state.effect(() => { sig?.(); ticks++; });
            },
        });
        const host = createAppHost({ policy: makePolicy(root, { content: { roles: ['page'] } }), root });
        await host.loadApp('ticker');
        flushSync();

        sig?.set(1);
        flushSync();
        const before = ticks;
        expect(before).toBeGreaterThan(0);

        await host.unloadApp('ticker');
        sig?.set(2);
        sig?.set(3);
        flushSync();

        // An effect still running after unload is a leak that grows for the page's lifetime.
        expect(ticks).toBe(before);
        host.dispose();
        root.remove();
    });

    it('the leak assertion actually catches a deliberately leaky app', async () => {
        // A leak check that never fires is worse than none, so prove it fires on a real leak
        // rather than only proving it stays quiet on a clean one.
        clearAppRegistry();
        const root = document.createElement('div');
        document.body.appendChild(root);

        defineApp({
            id: 'leaky',
            title: 'Leaky',
            onLoad(ctx) {
                // Registered as disposable, never disposed -- exactly the shape of a real leak:
                // a subscription an app opens and forgets to close on unload.
                ctx.trackLeakable({ isDisposed: false, dispose: () => {} });
            },
        });
        const host = createAppHost({ policy: makePolicy(root, { content: { roles: ['page'] } }), root });
        await host.loadApp('leaky');

        await expect(host.unloadApp('leaky', { assertNoLeaks: true })).rejects.toThrow(/leak/i);

        host.dispose();
        root.remove();
    });

    it('stays quiet when an app cleans up properly', async () => {
        clearAppRegistry();
        const root = document.createElement('div');
        document.body.appendChild(root);

        defineApp({
            id: 'tidy',
            title: 'Tidy',
            onLoad(ctx) {
                const resource = { isDisposed: false, dispose(): void { this.isDisposed = true; } };
                ctx.trackLeakable(resource);
                ctx.registerCleanup(() => resource.dispose());
            },
        });
        const host = createAppHost({ policy: makePolicy(root, { content: { roles: ['page'] } }), root });
        await host.loadApp('tidy');

        await expect(host.unloadApp('tidy', { assertNoLeaks: true })).resolves.toBeUndefined();

        host.dispose();
        root.remove();
    });
});

describe('per-app state is isolated', () => {
    let storage: MemoryStorage;
    beforeEach(() => { storage = new MemoryStorage(); });

    it('two apps using the same persisted key do not collide, and neither can read the other', () => {
        const a = new AppStateContainerImpl('app-a', createScope(), storage);
        const b = new AppStateContainerImpl('app-b', createScope(), storage);

        const aPref = a.persisted('theme', 'dark');
        const bPref = b.persisted('theme', 'light');

        expect(aPref()).toBe('dark');
        expect(bPref()).toBe('light');

        aPref.set('solarized');
        flushSync();

        // Guessing another app's key must not work -- namespacing is what makes "no app reaches
        // into another app's state" true rather than merely intended.
        expect(bPref()).toBe('light');
        const bReads = b.persisted('theme', 'fallback');
        expect(bReads()).toBe('light');

        a.dispose();
        b.dispose();
    });
});
