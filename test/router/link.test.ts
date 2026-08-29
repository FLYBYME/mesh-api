// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
    shouldInterceptLinkClick,
    attachLinkInterceptor,
} from '../../src/runtime/router/link.js';

describe('link interception logic', () => {
    const origin = 'http://localhost:3000';

    function createAnchor(attrs: Record<string, string>): HTMLAnchorElement {
        const a = document.createElement('a');
        for (const [k, v] of Object.entries(attrs)) {
            a.setAttribute(k, v);
        }
        return a;
    }

    function createClickEvent(options: Partial<MouseEventInit> = {}): MouseEvent {
        return new MouseEvent('click', {
            button: 0,
            bubbles: true,
            cancelable: true,
            ...options,
        });
    }

    it('a modified click (cmd/ctrl/middle/target=_blank) is NOT intercepted; a plain same-origin click is', () => {
        const plainAnchor = createAnchor({ href: '/kanban/card/123' });

        // 1. Plain same-origin click is intercepted
        const plainEvent = createClickEvent();
        expect(shouldInterceptLinkClick(plainEvent, plainAnchor, origin)).toBe(true);

        // 2. Cmd / Meta click is NOT intercepted (allows open-in-new-tab)
        const cmdEvent = createClickEvent({ metaKey: true });
        expect(shouldInterceptLinkClick(cmdEvent, plainAnchor, origin)).toBe(false);

        // 3. Ctrl click is NOT intercepted
        const ctrlEvent = createClickEvent({ ctrlKey: true });
        expect(shouldInterceptLinkClick(ctrlEvent, plainAnchor, origin)).toBe(false);

        // 4. Shift click is NOT intercepted
        const shiftEvent = createClickEvent({ shiftKey: true });
        expect(shouldInterceptLinkClick(shiftEvent, plainAnchor, origin)).toBe(false);

        // 5. Alt click is NOT intercepted
        const altEvent = createClickEvent({ altKey: true });
        expect(shouldInterceptLinkClick(altEvent, plainAnchor, origin)).toBe(false);

        // 6. Middle click (button 1) is NOT intercepted
        const middleEvent = createClickEvent({ button: 1 });
        expect(shouldInterceptLinkClick(middleEvent, plainAnchor, origin)).toBe(false);

        // 7. Right click (button 2) is NOT intercepted
        const rightEvent = createClickEvent({ button: 2 });
        expect(shouldInterceptLinkClick(rightEvent, plainAnchor, origin)).toBe(false);

        // 8. target="_blank" is NOT intercepted
        const blankAnchor = createAnchor({ href: '/kanban/card/123', target: '_blank' });
        expect(shouldInterceptLinkClick(plainEvent, blankAnchor, origin)).toBe(false);

        // 9. target="_top" or target="_parent" is NOT intercepted
        const topAnchor = createAnchor({ href: '/kanban/card/123', target: '_top' });
        expect(shouldInterceptLinkClick(plainEvent, topAnchor, origin)).toBe(false);

        // 10. download attribute is NOT intercepted
        const downloadAnchor = createAnchor({ href: '/export.csv', download: 'data.csv' });
        expect(shouldInterceptLinkClick(plainEvent, downloadAnchor, origin)).toBe(false);

        // 11. External origin is NOT intercepted
        const externalAnchor = createAnchor({ href: 'https://example.com/other' });
        expect(shouldInterceptLinkClick(plainEvent, externalAnchor, origin)).toBe(false);

        // 12. data-external attribute is NOT intercepted
        const optOutAnchor = createAnchor({ href: '/kanban/card/123', 'data-external': 'true' });
        expect(shouldInterceptLinkClick(plainEvent, optOutAnchor, origin)).toBe(false);
    });

    it('attachLinkInterceptor intercepts click events in the DOM tree and dispatches navigation', () => {
        const root = document.createElement('div');
        document.body.appendChild(root);

        const a = document.createElement('a');
        a.href = '/kanban/card/456';
        const span = document.createElement('span');
        span.textContent = 'Card Link';
        a.appendChild(span);
        root.appendChild(a);

        let navigatedTo: string | null = null;
        const cleanup = attachLinkInterceptor(root, (href) => {
            navigatedTo = href;
        });

        // Click on the nested span
        const event = new MouseEvent('click', {
            button: 0,
            bubbles: true,
            cancelable: true,
        });
        span.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(navigatedTo).toBe('/kanban/card/456');

        cleanup();
        root.remove();
    });
});
