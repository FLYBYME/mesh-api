// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ScrollManager } from '../../src/runtime/router/scroll.js';
import { createRouter } from '../../src/runtime/router/router.js';

describe('scroll and focus restoration', () => {
    let mockScrollX = 0;
    let mockScrollY = 0;

    beforeEach(() => {
        mockScrollX = 0;
        mockScrollY = 0;
        window.scrollX = 0;
        window.scrollY = 0;
        window.scrollTo = (xOrOptions?: number | ScrollToOptions, y?: number): void => {
            if (typeof xOrOptions === 'number') {
                mockScrollX = xOrOptions;
                mockScrollY = y ?? 0;
            } else if (xOrOptions && typeof xOrOptions === 'object') {
                mockScrollX = xOrOptions.left ?? 0;
                mockScrollY = xOrOptions.top ?? 0;
            } else {
                mockScrollX = 0;
                mockScrollY = 0;
            }
            window.scrollX = mockScrollX;
            window.scrollY = mockScrollY;
        };
        window.history.replaceState(null, '', '/');
    });

    it('back/forward restores scroll position', async () => {
        const router = createRouter({
            routes: [
                { appId: 'app1', route: '/page1' },
                { appId: 'app2', route: '/page2' },
            ],
        });

        // 1. Initial page at /page1
        await router.navigate('/page1');
        // User scrolls down to y = 500
        window.scrollTo(0, 500);
        expect(mockScrollY).toBe(500);

        // 2. Navigate to /page2 via push
        await router.navigate('/page2');

        // Scroll is reset to (0, 0) on new push navigation
        expect(mockScrollY).toBe(0);

        // User scrolls on page 2 to y = 250
        window.scrollTo(0, 250);

        // 3. User navigates Back (popstate event triggered)
        window.history.back();
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));

        // Scroll position of /page1 is restored to y = 500
        expect(mockScrollY).toBe(500);

        router.dispose();
    });

    it('ScrollManager records and restores coordinates across history keys', () => {
        const sm = new ScrollManager();

        window.scrollTo(10, 300);
        sm.save('/article/1', window);

        sm.reset(window);
        expect(mockScrollX).toBe(0);
        expect(mockScrollY).toBe(0);

        sm.restore('/article/1', window);
        expect(mockScrollX).toBe(10);
        expect(mockScrollY).toBe(300);
    });

    it('moves focus to the main content heading on navigation', async () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        const heading = document.createElement('h1');
        heading.textContent = 'Main Heading';
        root.appendChild(heading);

        const focusSpy = vi.spyOn(heading, 'focus');

        const router = createRouter({
            root,
            routes: [{ appId: 'app1', route: '/dashboard' }],
        });

        await router.navigate('/dashboard');

        expect(focusSpy).toHaveBeenCalled();
        expect(heading.getAttribute('tabindex')).toBe('-1');

        router.dispose();
        root.remove();
    });
});
