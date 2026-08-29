// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
    defineApp,
    clearAppRegistry,
    createAppHost,
} from '../../src/runtime/app/index.js';
import {
    loadEagerApps,
    isAppAuthAllowed,
} from '../../src/runtime/manifest/loader.js';
import type { Manifest } from '../../src/runtime/manifest/types.js';
import type { SessionUser } from '../../src/auth/types.js';

describe('auth gating and app loading', () => {
    beforeEach(() => {
        clearAppRegistry();
    });

    const manifest: Manifest = {
        site: { id: 'test-site', title: 'Test Site' },
        layout: { regions: { content: { roles: ['page'] } } },
        apps: [
            {
                id: 'public-app',
                module: './apps/public.js',
                load: 'eager',
                auth: 'public',
            },
            {
                id: 'user-app',
                module: './apps/user.js',
                load: 'eager',
                auth: 'user',
            },
            {
                id: 'admin-app',
                module: './apps/admin.js',
                load: 'eager',
                auth: 'admin',
            },
        ],
    };

    it('isAppAuthAllowed evaluates permissions correctly per auth level', () => {
        const anon = null;
        const regularUser: SessionUser = { id: 'u1', tenant_id: 't1', roles: ['member'] };
        const adminUser: SessionUser = { id: 'u2', tenant_id: 't1', roles: ['admin'] };

        expect(isAppAuthAllowed('public', anon)).toBe(true);
        expect(isAppAuthAllowed('user', anon)).toBe(false);
        expect(isAppAuthAllowed('admin', anon)).toBe(false);

        expect(isAppAuthAllowed('public', regularUser)).toBe(true);
        expect(isAppAuthAllowed('user', regularUser)).toBe(true);
        expect(isAppAuthAllowed('admin', regularUser)).toBe(false);

        expect(isAppAuthAllowed('public', adminUser)).toBe(true);
        expect(isAppAuthAllowed('user', adminUser)).toBe(true);
        expect(isAppAuthAllowed('admin', adminUser)).toBe(true);
    });

    it('an auth-gated app is not loaded at all for an anonymous visitor (assert it never loaded, not merely that it is not visible)', async () => {
        let publicLoadCount = 0;
        let userLoadCount = 0;
        let adminLoadCount = 0;

        defineApp({
            id: 'public-app',
            title: 'Public App',
            onLoad() {
                publicLoadCount++;
            },
        });
        defineApp({
            id: 'user-app',
            title: 'User App',
            onLoad() {
                userLoadCount++;
            },
        });
        defineApp({
            id: 'admin-app',
            title: 'Admin App',
            onLoad() {
                adminLoadCount++;
            },
        });

        const root = document.createElement('div');
        const host = createAppHost({
            root,
            policy: { regions: { content: { roles: ['page'] } } },
        });

        // Anonymous visitor session (null)
        const loadedIds = await loadEagerApps(manifest, host, null);

        // Assert strictly: only public-app is loaded; user-app and admin-app are never loaded
        expect(loadedIds).toEqual(['public-app']);
        expect(publicLoadCount).toBe(1);
        expect(userLoadCount).toBe(0);
        expect(adminLoadCount).toBe(0);

        expect(host.getAppState('public-app')).toBe('loaded');
        expect(host.getAppState('user-app')).toBeUndefined();
        expect(host.getAppState('admin-app')).toBeUndefined();

        host.dispose();
    });

    it('loads user-level apps for an authenticated regular user, but does not load admin apps', async () => {
        let userLoadCount = 0;
        let adminLoadCount = 0;

        defineApp({ id: 'public-app', title: 'Public App' });
        defineApp({
            id: 'user-app',
            title: 'User App',
            onLoad() {
                userLoadCount++;
            },
        });
        defineApp({
            id: 'admin-app',
            title: 'Admin App',
            onLoad() {
                adminLoadCount++;
            },
        });

        const root = document.createElement('div');
        const host = createAppHost({
            root,
            policy: { regions: { content: { roles: ['page'] } } },
        });

        const regularUser: SessionUser = { id: 'u1', tenant_id: 't1', roles: ['member'] };
        const loadedIds = await loadEagerApps(manifest, host, regularUser);

        expect(loadedIds).toContain('public-app');
        expect(loadedIds).toContain('user-app');
        expect(loadedIds).not.toContain('admin-app');

        expect(userLoadCount).toBe(1);
        expect(adminLoadCount).toBe(0);
        expect(host.getAppState('admin-app')).toBeUndefined();

        host.dispose();
    });

    it('loads all apps for an admin user', async () => {
        let adminLoadCount = 0;

        defineApp({ id: 'public-app', title: 'Public App' });
        defineApp({ id: 'user-app', title: 'User App' });
        defineApp({
            id: 'admin-app',
            title: 'Admin App',
            onLoad() {
                adminLoadCount++;
            },
        });

        const root = document.createElement('div');
        const host = createAppHost({
            root,
            policy: { regions: { content: { roles: ['page'] } } },
        });

        const adminUser: SessionUser = { id: 'u2', tenant_id: 't1', roles: ['admin'] };
        const loadedIds = await loadEagerApps(manifest, host, adminUser);

        expect(loadedIds).toEqual(['public-app', 'user-app', 'admin-app']);
        expect(adminLoadCount).toBe(1);
        expect(host.getAppState('admin-app')).toBe('loaded');

        host.dispose();
    });
});
