// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { flushSync } from '../../src/runtime/reactivity/index.js';
import { createRouter } from '../../src/runtime/router/router.js';
import { mountViews } from '../../src/runtime/router/view.js';
import type { Manifest } from '../../src/runtime/manifest/types.js';
import type { ViewComponent } from '../../src/runtime/router/types.js';
import { h } from '../../src/runtime/dom/index.js';

describe('namespace prefix routing transparency', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        window.history.replaceState(null, '', '/');
    });

    it('a prefixed remote app resolves its own internal routes identically to when it is unprefixed — same app code, both mount points', async () => {
        let capturedParamId: string | undefined;
        let capturedAppPath: string | undefined;

        // The exact same App view implementation used across both deployments
        const ProductView: ViewComponent = ({ params, router }) => {
            capturedParamId = params().id;
            capturedAppPath = router.currentPath();
            return h('div', { class: 'product-view' }, [`Product: ${params().id}`]);
        };

        const CartView: ViewComponent = ({ router }) => {
            capturedAppPath = router.currentPath();
            return h('div', { class: 'cart-view' }, ['Shopping Cart']);
        };

        const shopViews = [
            { path: '/product/:id', view: ProductView },
            { path: '/cart', view: CartView },
        ];

        // -------------------------------------------------------------
        // DEPLOYMENT 1: Unprefixed at home (Site B serving its own app)
        // -------------------------------------------------------------
        const homeManifest: Manifest = {
            site: { id: 'site-b', title: 'Site B Store' },
            layout: { regions: { content: { roles: ['page'] } } },
            apps: [
                {
                    id: 'shop',
                    module: './apps/shop.js',
                    surfaces: [{ role: 'page', route: '/shop/*' }],
                },
            ],
        };

        const homeRouter = createRouter({
            manifest: homeManifest,
            routes: [
                {
                    appId: 'shop',
                    route: '/shop/*',
                    namespace: 'local',
                    views: shopViews,
                },
            ],
        });

        const homeScoped = homeRouter.getAppRouter('shop');
        const homeCleanup = mountViews(container, shopViews, homeScoped);

        // Navigate to product page at home
        await homeRouter.navigate('/shop/product/mech-keyboard');
        flushSync();

        // Verify unprefixed resolution
        expect(homeRouter.currentAppId()).toBe('shop');
        expect(capturedParamId).toBe('mech-keyboard');
        expect(capturedAppPath).toBe('/shop/product/mech-keyboard');
        expect(window.location.pathname).toBe('/shop/product/mech-keyboard');

        // App navigates internally to cart
        await homeScoped.navigate('/shop/cart');
        flushSync();
        expect(capturedAppPath).toBe('/shop/cart');
        expect(window.location.pathname).toBe('/shop/cart');

        homeCleanup();
        homeRouter.dispose();
        container.replaceChildren();

        // -------------------------------------------------------------
        // DEPLOYMENT 2: Prefixed federated under /b (Site A consuming Site B)
        // -------------------------------------------------------------
        const federatedManifest: Manifest = {
            site: { id: 'site-a', title: 'Site A Console' },
            layout: { regions: { content: { roles: ['page'] } } },
            remotes: [
                {
                    namespace: 'b',
                    origin: 'https://b.example.com',
                    mount: '/b',
                    apps: [
                        {
                            id: 'shop',
                            version: '1.4.2',
                            integrity: 'sha384-verifiedHash',
                            surfaces: [{ role: 'page', route: '/shop/*' }],
                        },
                    ],
                },
            ],
        };

        const federatedRouter = createRouter({
            manifest: federatedManifest,
            routes: [
                {
                    appId: 'shop',
                    route: '/shop/*',
                    namespace: 'b',
                    mountPrefix: '/b',
                    views: shopViews,
                },
            ],
        });

        const federatedScoped = federatedRouter.getAppRouter('shop', {
            namespace: 'b',
            mountPrefix: '/b',
        });
        const fedCleanup = mountViews(container, shopViews, federatedScoped);

        // Navigate to product page under namespace prefix /b
        await federatedRouter.navigate('/b/shop/product/mech-keyboard');
        flushSync();

        // Verify prefixed resolution:
        // - App sees the EXACT same params ('mech-keyboard')
        // - App sees the EXACT same appRelativePath ('/shop/product/mech-keyboard')
        // - Browser URL correctly carries the top-level prefix ('/b/shop/product/mech-keyboard')
        expect(federatedRouter.currentAppId()).toBe('shop');
        expect(federatedRouter.currentNamespace()).toBe('b');
        expect(federatedRouter.currentMountPrefix()).toBe('/b');
        expect(capturedParamId).toBe('mech-keyboard');
        expect(capturedAppPath).toBe('/shop/product/mech-keyboard');
        expect(window.location.pathname).toBe('/b/shop/product/mech-keyboard');

        // App executes the IDENTICAL navigation call ctx.router.navigate('/shop/cart')
        await federatedScoped.navigate('/shop/cart');
        flushSync();

        // App sees '/shop/cart', while browser URL was transparently prefixed with '/b/shop/cart'
        expect(capturedAppPath).toBe('/shop/cart');
        expect(window.location.pathname).toBe('/b/shop/cart');

        fedCleanup();
        federatedRouter.dispose();
        container.remove();
    });
});
