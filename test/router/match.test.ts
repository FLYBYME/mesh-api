import { describe, it, expect } from 'vitest';
import {
    matchRoutePattern,
    resolveHierarchy,
    normalizePath,
} from '../../src/runtime/router/match.js';
import type { AppRouteDefinition } from '../../src/runtime/router/types.js';
import type { RemoteSiteConfig } from '../../src/runtime/manifest/types.js';

describe('router path matching and 3-level resolution', () => {
    it('normalizes path strings properly', () => {
        expect(normalizePath('')).toBe('/');
        expect(normalizePath('/')).toBe('/');
        expect(normalizePath('/kanban')).toBe('/kanban');
        expect(normalizePath('/kanban/')).toBe('/kanban');
        expect(normalizePath('kanban')).toBe('/kanban');
        expect(normalizePath('//a///b//')).toBe('/a/b');
    });

    it('matches exact and wildcard route patterns', () => {
        expect(matchRoutePattern('/', '/')).toEqual({ matched: true, params: {}, rest: '' });
        expect(matchRoutePattern('/', '/about')).toBeNull();

        expect(matchRoutePattern('/kanban', '/kanban')).toEqual({
            matched: true,
            params: {},
            rest: '',
        });

        // Wildcard matches
        expect(matchRoutePattern('/kanban/*', '/kanban')).toEqual({
            matched: true,
            params: {},
            rest: '/',
        });
        expect(matchRoutePattern('/kanban/*', '/kanban/card/abc123')).toEqual({
            matched: true,
            params: {},
            rest: '/card/abc123',
        });
    });

    it('extracts named parameters from pattern segments', () => {
        const res = matchRoutePattern('/card/:id', '/card/abc123');
        expect(res).toEqual({
            matched: true,
            params: { id: 'abc123' },
            rest: '',
        });

        const multi = matchRoutePattern('/items/:category/:id', '/items/books/42');
        expect(multi).toEqual({
            matched: true,
            params: { category: 'books', id: '42' },
            rest: '',
        });
    });

    it('resolves three-tier hierarchy (namespace -> app -> view)', () => {
        const remotes: RemoteSiteConfig[] = [
            {
                namespace: 'b',
                origin: 'https://b.example.com',
                mount: '/b',
                apps: [{ id: 'shop', version: '1.0', integrity: 'sha384-x' }],
            },
        ];

        const routes: AppRouteDefinition[] = [
            {
                appId: 'kanban',
                route: '/kanban/*',
                namespace: 'local',
                views: [
                    { path: '/', view: () => document.createElement('div') },
                    { path: '/card/:id', view: () => document.createElement('div') },
                ],
            },
            {
                appId: 'shop',
                route: '/shop/*',
                namespace: 'b',
                mountPrefix: '/b',
                views: [
                    { path: '/product/:id', view: () => document.createElement('div') },
                ],
            },
        ];

        // 1. Local App + View resolution
        const localRes = resolveHierarchy('/kanban/card/xyz999', remotes, routes);
        expect(localRes.matched).toBe(true);
        expect(localRes.namespace).toBeUndefined();
        expect(localRes.mountPrefix).toBe('');
        expect(localRes.appId).toBe('kanban');
        expect(localRes.appRelativePath).toBe('/kanban/card/xyz999');
        expect(localRes.viewRelativePath).toBe('/card/xyz999');
        expect(localRes.params).toEqual({ id: 'xyz999' });

        // 2. Remote Federated App + View resolution
        const remoteRes = resolveHierarchy('/b/shop/product/item42', remotes, routes);
        expect(remoteRes.matched).toBe(true);
        expect(remoteRes.namespace).toBe('b');
        expect(remoteRes.mountPrefix).toBe('/b');
        expect(remoteRes.appId).toBe('shop');
        expect(remoteRes.appRelativePath).toBe('/shop/product/item42');
        expect(remoteRes.viewRelativePath).toBe('/product/item42');
        expect(remoteRes.params).toEqual({ id: 'item42' });

        // 3. Unmatched path
        const missingRes = resolveHierarchy('/nonexistent', remotes, routes);
        expect(missingRes.matched).toBe(false);
    });
});
