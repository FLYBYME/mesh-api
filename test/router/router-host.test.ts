// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
    defineApp,
    clearAppRegistry,
    createAppHost,
} from '../../src/runtime/app/index.js';
import { createRouter } from '../../src/runtime/router/router.js';
import type { Manifest } from '../../src/runtime/manifest/types.js';
import type { SessionUser } from '../../src/auth/types.js';

describe('Router and AppHost integration', () => {
    beforeEach(() => {
        clearAppRegistry();
        window.history.replaceState(null, '', '/');
    });

    const manifest: Manifest = {
        site: { id: 'console', title: 'Console' },
        layout: {
            regions: {
                content: { roles: ['page'] },
                sidebar: { slots: ['primary'] },
            },
        },
        apps: [
            {
                id: 'dashboard',
                module: './apps/dashboard.js',
                load: 'eager',
                surfaces: [{ role: 'page', route: '/dashboard' }],
            },
            {
                id: 'kanban',
                module: './apps/kanban.js',
                load: 'on-route',
                auth: 'user',
                surfaces: [{ role: 'page', route: '/kanban/*' }],
            },
        ],
    };

    it('router drives app loading and activation through the AppHost lifecycle', async () => {
        let dashboardActivated = 0;
        let kanbanActivated = 0;

        defineApp({
            id: 'dashboard',
            title: 'Dashboard',
            onActivate() {
                dashboardActivated++;
            },
        });

        defineApp({
            id: 'kanban',
            title: 'Kanban',
            onActivate() {
                kanbanActivated++;
            },
        });

        const root = document.createElement('div');
        const host = createAppHost({
            root,
            policy: { regions: { content: { roles: ['page'] } } },
        });

        const authedUser: SessionUser = { id: 'u1', tenant_id: 't1' };

        const router = createRouter({
            host,
            manifest,
            session: () => authedUser,
        });

        // 1. Navigate to /dashboard
        await router.navigate('/dashboard');

        expect(host.getForegroundAppId()).toBe('dashboard');
        expect(host.getAppState('dashboard')).toBe('foreground');
        expect(dashboardActivated).toBe(1);

        // 2. Navigate to /kanban/card/100
        await router.navigate('/kanban/card/100');

        // Outgoing dashboard is backgrounded; incoming kanban is loaded and activated
        expect(host.getForegroundAppId()).toBe('kanban');
        expect(host.getAppState('dashboard')).toBe('background');
        expect(host.getAppState('kanban')).toBe('foreground');
        expect(kanbanActivated).toBe(1);

        router.dispose();
        host.dispose();
    });

    it('auth-gated app is not loaded or activated when visited by anonymous user', async () => {
        let kanbanLoadCount = 0;

        defineApp({
            id: 'dashboard',
            title: 'Dashboard',
        });

        defineApp({
            id: 'kanban',
            title: 'Kanban',
            onLoad() {
                kanbanLoadCount++;
            },
        });

        const root = document.createElement('div');
        const host = createAppHost({
            root,
            policy: { regions: { content: { roles: ['page'] } } },
        });

        // Anonymous session
        const router = createRouter({
            host,
            manifest,
            session: () => null,
        });

        await router.navigate('/dashboard');
        expect(host.getForegroundAppId()).toBe('dashboard');

        // Anonymous user attempts to visit /kanban
        await router.navigate('/kanban/card/100');

        expect(router.isUnauthorized()).toBe(true);
        expect(kanbanLoadCount).toBe(0);
        expect(host.getAppState('kanban')).toBeUndefined();

        router.dispose();
        host.dispose();
    });

    it('sets isNotFound when navigating to an unmatched route', async () => {
        const root = document.createElement('div');
        const host = createAppHost({
            root,
            policy: { regions: { content: { roles: ['page'] } } },
        });

        const router = createRouter({
            host,
            manifest,
        });

        await router.navigate('/unknown-path');
        expect(router.isNotFound()).toBe(true);
        expect(router.currentAppId()).toBeNull();

        router.dispose();
        host.dispose();
    });
});
