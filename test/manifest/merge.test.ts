import { describe, it, expect } from 'vitest';
import { mergeManifests } from '../../src/runtime/manifest/merge.js';
import type { Manifest, ManifestOverlay } from '../../src/runtime/manifest/types.js';

describe('manifest environment overlay merging', () => {
    const baseManifest: Manifest = {
        site: {
            id: 'console',
            title: 'Console Production',
            theme: 'dark',
        },
        layout: {
            regions: {
                header: { slots: ['nav', 'user'] },
                sidebar: { slots: ['primary'] },
                content: { roles: ['page'] },
            },
            banners: false,
        },
        apps: [
            {
                id: 'dashboard',
                module: './apps/dashboard.js',
                load: 'eager',
                surfaces: [{ role: 'page', route: '/' }],
            },
            {
                id: 'kanban',
                module: './apps/kanban.js',
                load: 'on-route',
                surfaces: [{ role: 'page', route: '/kanban/*' }],
            },
        ],
    };

    it('merges site and layout overrides from overlay', () => {
        const overlay: ManifestOverlay = {
            site: {
                title: 'Console Dev Mode',
            },
            layout: {
                regions: {
                    sidebar: { slots: ['primary', 'dev-tools'] },
                },
                banners: 'enabled',
            },
        };

        const merged = mergeManifests(baseManifest, overlay);

        expect(merged.site.title).toBe('Console Dev Mode');
        expect(merged.site.theme).toBe('dark'); // preserved
        expect(merged.layout.banners).toBe('enabled');
        expect(merged.layout.regions.sidebar?.slots).toEqual(['primary', 'dev-tools']);
        expect(merged.layout.regions.header?.slots).toEqual(['nav', 'user']); // preserved
    });

    it('merges new development apps by ID into the apps array', () => {
        const overlay: ManifestOverlay = {
            layout: {
                regions: {
                    sidebar: { slots: ['primary', 'dev-tools'] },
                },
            },
            apps: [
                {
                    id: 'dev-tools',
                    module: './apps/dev-tools.js',
                    load: 'eager',
                    surfaces: [
                        { role: 'panel', slot: 'sidebar.dev-tools' },
                    ],
                },
            ],
        };

        const merged = mergeManifests(baseManifest, overlay);

        expect(merged.apps).toHaveLength(3);
        const devToolsApp = merged.apps?.find((a) => a.id === 'dev-tools');
        expect(devToolsApp).toBeDefined();
        expect(devToolsApp?.load).toBe('eager');
    });

    it('replaces an existing app when overlay specifies matching ID', () => {
        const overlay: ManifestOverlay = {
            apps: [
                {
                    id: 'dashboard',
                    module: './apps/dashboard-mock.js',
                    load: 'eager',
                    surfaces: [{ role: 'page', route: '/' }],
                },
            ],
        };

        const merged = mergeManifests(baseManifest, overlay);

        expect(merged.apps).toHaveLength(2);
        const dashboard = merged.apps?.find((a) => a.id === 'dashboard');
        expect(dashboard?.module).toBe('./apps/dashboard-mock.js');
    });

    it('merges federated remote apps by namespace', () => {
        const baseWithRemote: Manifest = {
            ...baseManifest,
            remotes: [
                {
                    namespace: 'b',
                    origin: 'https://b.example.com',
                    mount: '/b',
                    apps: [
                        { id: 'shop', version: '1.0.0', integrity: 'sha384-abc' },
                    ],
                },
            ],
        };

        const overlay: ManifestOverlay = {
            remotes: [
                {
                    namespace: 'b',
                    origin: 'https://b.example.com',
                    mount: '/b',
                    apps: [
                        { id: 'shop', version: '1.0.1', integrity: 'sha384-updated' },
                        { id: 'cart', version: '2.0.0', integrity: 'sha384-cart' },
                    ],
                },
            ],
        };

        const merged = mergeManifests(baseWithRemote, overlay);

        expect(merged.remotes).toHaveLength(1);
        const remoteB = merged.remotes?.[0];
        expect(remoteB?.apps).toHaveLength(2);
        const shopApp = remoteB?.apps.find((a) => a.id === 'shop');
        expect(shopApp?.version).toBe('1.0.1');
        expect(shopApp?.integrity).toBe('sha384-updated');
    });
});
