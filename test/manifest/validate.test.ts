import { describe, it, expect } from 'vitest';
import { validateManifest } from '../../src/runtime/manifest/validate.js';
import type { Manifest } from '../../src/runtime/manifest/types.js';

describe('manifest validation', () => {
    const validManifest: Manifest = {
        site: {
            id: 'console',
            title: 'SurfDNS Console',
            theme: 'dark',
        },
        layout: {
            regions: {
                header: { slots: ['nav', 'spacer', 'search', 'notifications', 'user'] },
                sidebar: { slots: ['primary', 'secondary'], collapsible: true },
                content: { roles: ['page'] },
                footer: { slots: ['status'] },
            },
            banners: 'enabled',
            taskSwitcher: {
                enabled: true,
                hotkey: 'Ctrl+`',
            },
        },
        remotes: [
            {
                namespace: 'b',
                origin: 'https://b.example.com',
                mount: '/b',
                apps: [
                    {
                        id: 'shop',
                        integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC',
                        version: '1.4.2',
                        surfaces: [{ role: 'panel', slot: 'sidebar.secondary', order: 40 }],
                    },
                ],
            },
        ],
        apps: [
            {
                id: 'dashboard',
                module: './apps/dashboard.js',
                load: 'eager',
                surfaces: [
                    { role: 'page', route: '/' },
                    { role: 'panel', slot: 'sidebar.primary', order: 10 },
                ],
            },
            {
                id: 'kanban',
                module: './apps/kanban.js',
                load: 'on-route',
                auth: 'user',
                surfaces: [
                    { role: 'page', route: '/kanban/*' },
                    { role: 'panel', slot: 'sidebar.primary', order: 20 },
                ],
            },
        ],
    };

    it('validates a complete, conformant manifest without errors', () => {
        const validated = validateManifest(validManifest);
        expect(validated.site.id).toBe('console');
        expect(validated.apps).toHaveLength(2);
        expect(validated.remotes).toHaveLength(1);
    });

    it('a manifest with a remote missing an SRI hash fails validation', () => {
        const badManifest = {
            ...validManifest,
            remotes: [
                {
                    namespace: 'b',
                    origin: 'https://b.example.com',
                    mount: '/b',
                    apps: [
                        {
                            id: 'shop',
                            version: '1.4.2',
                            // integrity omitted -- federation requires pinned SRI
                            surfaces: [{ role: 'panel', slot: 'sidebar.secondary' }],
                        },
                    ],
                },
            ],
        };

        expect(() => validateManifest(badManifest)).toThrow(/integrity|SRI/i);
    });

    it('a manifest with a remote missing a pinned version fails validation', () => {
        const badManifest = {
            ...validManifest,
            remotes: [
                {
                    namespace: 'b',
                    origin: 'https://b.example.com',
                    mount: '/b',
                    apps: [
                        {
                            id: 'shop',
                            integrity: 'sha384-someHash',
                            // version omitted
                        },
                    ],
                },
            ],
        };

        expect(() => validateManifest(badManifest)).toThrow(/version/i);
    });

    it('fails when an app references a non-existent slot', () => {
        const badManifest: Manifest = {
            ...validManifest,
            apps: [
                {
                    id: 'rogue-panel',
                    module: './apps/rogue.js',
                    surfaces: [
                        // layout.regions.sidebar only defines 'primary' and 'secondary'
                        { role: 'panel', slot: 'sidebar.tertiary' },
                    ],
                },
            ],
        };

        expect(() => validateManifest(badManifest)).toThrow(
            /App "rogue-panel" references slot "sidebar.tertiary" which does not exist in layout regions/
        );
    });

    it('fails when an app references an unknown region as a slot', () => {
        const badManifest: Manifest = {
            ...validManifest,
            apps: [
                {
                    id: 'unknown-slot-app',
                    module: './apps/unknown.js',
                    surfaces: [{ role: 'panel', slot: 'nonexistent_region.primary' }],
                },
            ],
        };

        expect(() => validateManifest(badManifest)).toThrow(
            /App "unknown-slot-app" references slot "nonexistent_region.primary" which does not exist/
        );
    });

    it('fails when duplicate app IDs are declared', () => {
        const badManifest: Manifest = {
            ...validManifest,
            apps: [
                { id: 'duplicate-id', module: './a.js' },
                { id: 'duplicate-id', module: './b.js' },
            ],
        };

        expect(() => validateManifest(badManifest)).toThrow(/Duplicate app id "duplicate-id"/);
    });

    it('fails when a remote has an empty apps array (wildcards forbidden)', () => {
        const badManifest = {
            ...validManifest,
            remotes: [
                {
                    namespace: 'b',
                    origin: 'https://b.example.com',
                    mount: '/b',
                    apps: [],
                },
            ],
        };

        expect(() => validateManifest(badManifest)).toThrow(/apps/i);
    });

    it('fails when duplicate remote namespaces are declared', () => {
        const badManifest: Manifest = {
            ...validManifest,
            remotes: [
                {
                    namespace: 'b',
                    origin: 'https://b1.example.com',
                    mount: '/b1',
                    apps: [{ id: 'app1', version: '1.0', integrity: 'sha384-x' }],
                },
                {
                    namespace: 'b',
                    origin: 'https://b2.example.com',
                    mount: '/b2',
                    apps: [{ id: 'app2', version: '1.0', integrity: 'sha384-y' }],
                },
            ],
        };

        expect(() => validateManifest(badManifest)).toThrow(/Duplicate remote namespace "b"/);
    });
});
