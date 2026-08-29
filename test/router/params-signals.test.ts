// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { flushSync } from '../../src/runtime/reactivity/index.js';
import { h, bindText } from '../../src/runtime/dom/index.js';
import { createRouter } from '../../src/runtime/router/router.js';
import { mountViews } from '../../src/runtime/router/view.js';
import type { ViewComponent } from '../../src/runtime/router/types.js';

describe('reactive route params and view preservation', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        window.history.replaceState(null, '', '/');
    });

    it('route params are signals: navigating updates a bound value without re-mounting the view', async () => {
        let viewMountCount = 0;
        let headingElement: HTMLElement | undefined;

        // CardDetailView binds heading text directly to `params().id`
        const CardDetailView: ViewComponent = ({ params }) => {
            viewMountCount++;
            const heading = h('h1', {});
            headingElement = heading;
            bindText(heading, () => `Card: ${params().id}`);
            return h('div', { class: 'card-detail' }, [heading]);
        };

        const router = createRouter({
            routes: [
                {
                    appId: 'kanban',
                    route: '/kanban/*',
                    views: [
                        { path: '/card/:id', view: CardDetailView },
                    ],
                },
            ],
        });

        const scopedRouter = router.getAppRouter('kanban');

        // Mount views inside page container
        const cleanupViews = mountViews(
            container,
            [{ path: '/card/:id', view: CardDetailView }],
            scopedRouter
        );

        // 1. Initial navigation to Card 1
        await router.navigate('/kanban/card/1');
        flushSync();

        expect(viewMountCount).toBe(1);
        expect(headingElement?.textContent).toBe('Card: 1');
        expect(container.querySelector('h1')?.textContent).toBe('Card: 1');
        const initialHeadingNode = headingElement;

        // 2. Navigate to Card 2 within the same view
        await router.navigate('/kanban/card/2');
        flushSync();

        // Critical properties asserted:
        // - Bound DOM text was reactively updated to Card 2
        // - View component function was NOT re-invoked (viewMountCount remains 1)
        // - DOM element reference is identical (no unmount/remount occurred)
        expect(viewMountCount).toBe(1);
        expect(headingElement?.textContent).toBe('Card: 2');
        expect(headingElement).toBe(initialHeadingNode);
        expect(container.querySelector('h1')?.textContent).toBe('Card: 2');

        // 3. Navigate to Card 42
        await router.navigate('/kanban/card/42');
        flushSync();

        expect(viewMountCount).toBe(1);
        expect(headingElement?.textContent).toBe('Card: 42');
        expect(headingElement).toBe(initialHeadingNode);

        cleanupViews();
        router.dispose();
        container.remove();
    });

    it('remounts cleanly only when transitioning to a different view definition', async () => {
        let cardMounts = 0;
        let settingsMounts = 0;

        const CardView: ViewComponent = () => {
            cardMounts++;
            return h('div', { class: 'card-view' }, ['Card View']);
        };

        const SettingsView: ViewComponent = () => {
            settingsMounts++;
            return h('div', { class: 'settings-view' }, ['Settings View']);
        };

        const router = createRouter({
            routes: [
                {
                    appId: 'kanban',
                    route: '/kanban/*',
                    views: [
                        { path: '/card/:id', view: CardView },
                        { path: '/settings', view: SettingsView },
                    ],
                },
            ],
        });

        const scopedRouter = router.getAppRouter('kanban');
        const cleanup = mountViews(
            container,
            [
                { path: '/card/:id', view: CardView },
                { path: '/settings', view: SettingsView },
            ],
            scopedRouter
        );

        await router.navigate('/kanban/card/100');
        flushSync();
        expect(cardMounts).toBe(1);
        expect(settingsMounts).toBe(0);

        // Switch to Settings view
        await router.navigate('/kanban/settings');
        flushSync();
        expect(cardMounts).toBe(1);
        expect(settingsMounts).toBe(1);
        expect(container.querySelector('.settings-view')).not.toBeNull();
        expect(container.querySelector('.card-view')).toBeNull();

        cleanup();
        router.dispose();
        container.remove();
    });

    it('two-way queryParam signal reads from URL and updates URL on write', async () => {
        const router = createRouter();
        const scoped = router.getAppRouter('test-app');

        await router.navigate('/dashboard?filter=active&sort=desc');
        flushSync();

        const filter = scoped.queryParam('filter', 'all');
        expect(filter()).toBe('active');

        // Write to queryParam signal
        filter.set('completed');
        flushSync();

        expect(filter()).toBe('completed');
        expect(scoped.query().get('filter')).toBe('completed');
        expect(scoped.query().get('sort')).toBe('desc'); // other query params preserved

        router.dispose();
        container.remove();
    });
});
