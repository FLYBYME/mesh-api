// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { flushSync } from '../../src/runtime/reactivity/index.js';
import {
    defineApp,
    clearAppRegistry,
    createAppHost,
    type LayoutPolicy,
    type LayoutRegionPolicy,
} from '../../src/runtime/app/index.js';

function makePolicy(
    root: HTMLElement,
    regions: Record<string, { roles?: readonly ('page' | 'panel' | 'popup' | 'banner' | 'overlay' | 'background')[]; slots?: readonly string[] }>
): LayoutPolicy {
    // Typed as the real `LayoutRegionPolicy` rather than a structural lookalike, and each optional
    // field spread in only when present. Under `exactOptionalPropertyTypes`, writing
    // `roles: cfg.roles` sets the property to `undefined`, which is a different thing from leaving
    // it absent — and the two are not assignable to each other.
    const built: Record<string, LayoutRegionPolicy> = {};
    for (const [name, cfg] of Object.entries(regions)) {
        const el = document.createElement('div');
        el.dataset.region = name;
        root.appendChild(el);
        built[name] = {
            container: el,
            ...(cfg.roles === undefined ? {} : { roles: cfg.roles }),
            ...(cfg.slots === undefined ? {} : { slots: cfg.slots }),
        };
    }
    return { regions: built, root };
}

describe('Slotted Surfaces', () => {
    let root: HTMLElement;

    beforeEach(() => {
        clearAppRegistry();
        root = document.createElement('div');
        document.body.appendChild(root);
    });

    afterEach(() => {
        root.remove();
    });

    it('an app that is loaded but never activated must have its slotted surface mounted, and must still have it after another app is activated', async () => {
        let slottedMountCount = 0;
        
        defineApp({
            id: 'slotted-app',
            title: 'Slotted App',
            surfaces: [
                {
                    role: 'panel',
                    slot: 'header.user',
                    mount(container) {
                        slottedMountCount++;
                        container.innerHTML = '<span id="slotted-content">Slotted Content</span>';
                    }
                }
            ]
        });

        defineApp({
            id: 'page-app',
            title: 'Page App',
            surfaces: [
                {
                    role: 'page',
                    mount(container) {
                        container.innerHTML = '<span id="page-content">Page Content</span>';
                    }
                }
            ]
        });

        const host = createAppHost({
            root,
            policy: makePolicy(root, { 
                content: { roles: ['page'] },
                header: { slots: ['header.user'] }
            }),
        });

        await host.loadApp('slotted-app');
        flushSync();
        
        const headerRegion = root.querySelector('[data-region="header"]');
        expect(headerRegion).not.toBeNull();
        const slottedContent = headerRegion?.querySelector('#slotted-content');
        expect(slottedContent).not.toBeNull();
        expect(slottedMountCount).toBe(1);

        // Load and activate a different app
        await host.loadApp('page-app');
        await host.activateApp('page-app');
        flushSync();

        // The slotted surface must survive
        const slottedContentAfter = headerRegion?.querySelector('#slotted-content');
        expect(slottedContentAfter).not.toBeNull();
        expect(slottedMountCount).toBe(1); // Not remounted

        host.dispose();
    });
});
