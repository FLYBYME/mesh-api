// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { flushSync, signal, type Signal } from '../../src/runtime/reactivity/index.js';
import {
    clearAppRegistry,
    defineApp,
    createAppHost,
    type LayoutPolicy,
    type AppContext,
} from '../../src/runtime/app/index.js';
import { parseManifest } from '../../src/runtime/manifest/index.js';
import { mountViews } from '../../src/runtime/router/view.js';
import type { ScopedRouter } from '../../src/runtime/router/types.js';
import {
    domainsApp,
    domainViews,
    createInMemoryApiClient,
    setDomainApiClient,
    createStandaloneDomainAppState,
    createDomainsListView,
    createDomainDetailView,
    type DomainRecord,
    type DnsRecordItem,
} from '../../apps/domains.js';

function makePolicy(root: HTMLElement, regions: Record<string, { roles: readonly ('page' | 'panel' | 'popup' | 'banner' | 'overlay' | 'background')[] }>): LayoutPolicy {
    const built: Record<string, { roles: readonly ('page' | 'panel' | 'popup' | 'banner' | 'overlay' | 'background')[]; container: HTMLElement }> = {};
    for (const [name, cfg] of Object.entries(regions)) {
        const el = document.createElement('div');
        el.dataset.region = name;
        root.appendChild(el);
        built[name] = { roles: cfg.roles, container: el };
    }
    return { regions: built, root };
}

function createTestScopedRouter(initialPath = '/domains', initialParams: Record<string, string> = {}): ScopedRouter {
    const paramsSig = signal<Record<string, string>>(initialParams);
    const querySig = signal<URLSearchParams>(new URLSearchParams());
    const pathSig = signal<string>(initialPath);

    return {
        navigate: async (p) => { pathSig.set(p); },
        replace: async (p) => { pathSig.set(p); },
        back: () => {},
        forward: () => {},
        params: paramsSig,
        query: querySig,
        currentPath: pathSig,
        mountPrefix: '/domains',
        queryParam: (_name, defaultValue = '') => signal(defaultValue),
    };
}

describe('Domain Management App (apps/domains.ts)', () => {
    let container: HTMLElement;
    let root: HTMLElement;

    const sampleDomains: DomainRecord[] = [
        {
            id: 'dom-1',
            orgId: 'org-flybyme',
            fqdn: 'flybyme.io',
            registrar: 'name-com',
            verificationStatus: 'verified',
            dnsZoneId: 'zone-1',
            status: 'active',
        },
        {
            id: 'dom-2',
            orgId: 'org-flybyme',
            fqdn: 'api.flybyme.io',
            registrar: 'name-com',
            verificationStatus: 'verified',
            dnsZoneId: 'zone-1',
            status: 'active',
        },
        {
            id: 'dom-3',
            orgId: 'platform',
            fqdn: 'surfdns.net',
            registrar: 'external',
            verificationStatus: 'pending',
            dnsZoneId: 'zone-2',
            status: 'active',
        },
        {
            id: 'dom-4',
            orgId: 'org-acme',
            fqdn: 'acme-corp.com',
            registrar: 'external',
            verificationStatus: 'failed',
            dnsZoneId: 'zone-3',
            status: 'suspended',
        },
    ];

    const sampleDnsRecords: DnsRecordItem[] = [
        {
            id: 'rec-1',
            dnsZoneId: 'zone-1',
            name: '@',
            type: 'A',
            address: '76.76.21.21',
            ttl: 300,
            managed: false,
        },
        {
            id: 'rec-2',
            dnsZoneId: 'zone-1',
            name: 'api',
            type: 'CNAME',
            target: 'cname.flybyme.io',
            ttl: 300,
            managed: true,
        },
    ];

    beforeEach(() => {
        clearAppRegistry();
        defineApp(domainsApp);
        container = document.createElement('div');
        root = document.createElement('div');
        document.body.appendChild(container);
        document.body.appendChild(root);
        window.history.replaceState(null, '', '/domains');
        setDomainApiClient(createInMemoryApiClient(sampleDomains, sampleDnsRecords));
    });

    afterEach(() => {
        container.remove();
        root.remove();
    });

    it('1. list renders real rows from a resource, and filtering updates table without recreating surviving rows (assert node identity)', async () => {
        const apiClient = createInMemoryApiClient(sampleDomains, sampleDnsRecords);
        const state = createStandaloneDomainAppState(apiClient);
        const router = createTestScopedRouter('/domains');

        // Render ListView
        const listViewFn = createDomainsListView(state, apiClient);
        const viewEl = listViewFn({
            params: router.params,
            query: router.query,
            router,
        });

        if (viewEl instanceof HTMLElement) {
            container.appendChild(viewEl);
        }

        // Wait for async resource fetch to resolve and flush microtasks
        flushSync();
        await new Promise(resolve => setTimeout(resolve, 20));
        flushSync();

        const tbody = container.querySelector('tbody');
        expect(tbody).not.toBeNull();
        if (!tbody) throw new Error('tbody element not found');

        const initialRows = Array.from(tbody.children);
        expect(initialRows.length).toBe(4);

        // Capture EXACT object references to DOM nodes
        const nodeFlybyme = initialRows[0];
        const nodeApiFlybyme = initialRows[1];
        const nodeSurfdns = initialRows[2];
        const nodeAcme = initialRows[3];

        if (!nodeFlybyme || !nodeApiFlybyme || !nodeSurfdns || !nodeAcme) {
            throw new Error('Expected initial row nodes to exist');
        }

        expect(nodeFlybyme.getAttribute('data-key')).toBe('dom-1');
        expect(nodeApiFlybyme.getAttribute('data-key')).toBe('dom-2');
        expect(nodeSurfdns.getAttribute('data-key')).toBe('dom-3');
        expect(nodeAcme.getAttribute('data-key')).toBe('dom-4');

        // Apply filter "flybyme" -> 2 surviving rows (dom-1, dom-2)
        state.fqdnFilter.set('flybyme');
        flushSync();

        const filteredRows1 = Array.from(tbody.children);
        expect(filteredRows1.length).toBe(2);

        // CRITICAL PROOF: Node identities are strictly preserved, surviving rows NOT reconstructed
        expect(filteredRows1[0]).toBe(nodeFlybyme);
        expect(filteredRows1[1]).toBe(nodeApiFlybyme);

        // Filter further down to "api" -> 1 surviving row (dom-2)
        state.fqdnFilter.set('api');
        flushSync();

        const filteredRows2 = Array.from(tbody.children);
        expect(filteredRows2.length).toBe(1);
        expect(filteredRows2[0]).toBe(nodeApiFlybyme);

        // Reset filter -> 4 rows (dom-2 was never detached, preserves node identity)
        state.fqdnFilter.set('');
        flushSync();

        const resetRows = Array.from(tbody.children);
        expect(resetRows.length).toBe(4);
        expect(resetRows[1]).toBe(nodeApiFlybyme);

        // Sort table by FQDN: click column header
        const fqdnHeader = container.querySelector('th[data-column="fqdn"]');
        if (fqdnHeader instanceof HTMLTableCellElement) {
            fqdnHeader.click();
            flushSync();

            const sortedRows = Array.from(tbody.children);
            expect(sortedRows.length).toBe(4);
            // In ascending order: acme-corp.com, api.flybyme.io, flybyme.io, surfdns.net
            expect(sortedRows[0]?.getAttribute('data-key')).toBe('dom-4');
            expect(sortedRows[1]?.getAttribute('data-key')).toBe('dom-2');
            expect(sortedRows[2]?.getAttribute('data-key')).toBe('dom-1');
            expect(sortedRows[3]?.getAttribute('data-key')).toBe('dom-3');
            expect(sortedRows[1]).toBe(nodeApiFlybyme);
        }
    });

    it('2. a refused page surface is handled rather than throwing', async () => {
        // Layout with NO page region (e.g. sidebar-only storefront layout)
        const host = createAppHost({
            root,
            policy: makePolicy(root, { sidebar: { roles: ['panel'] } }),
        });

        // App loading & activation must NOT throw when page surface is refused
        await expect(host.loadApp('domains')).resolves.toBeUndefined();
        await expect(host.activateApp('domains')).resolves.toBeUndefined();

        expect(host.getAppState('domains')).toBe('foreground');
        host.dispose();
    });

    it('3. navigation is real anchors — assert href exists, not a click handler', async () => {
        const apiClient = createInMemoryApiClient(sampleDomains, sampleDnsRecords);
        const state = createStandaloneDomainAppState(apiClient);
        const router = createTestScopedRouter('/domains');

        // 1. List View Links
        const listView = createDomainsListView(state, apiClient)({
            params: router.params,
            query: router.query,
            router,
        });

        if (listView instanceof HTMLElement) {
            container.appendChild(listView);
        }
        flushSync();
        await new Promise(resolve => setTimeout(resolve, 20));
        flushSync();

        const domainLinks = container.querySelectorAll('a.domain-detail-link');
        expect(domainLinks.length).toBeGreaterThan(0);

        for (let i = 0; i < domainLinks.length; i++) {
            const link = domainLinks[i];
            if (!link) continue;
            expect(link.tagName.toLowerCase()).toBe('a');
            const href = link.getAttribute('href');
            expect(href).not.toBeNull();
            expect(href).toMatch(/^\/domains\/dom-/);
        }

        // 2. Detail View Back Link
        const detailRouter = createTestScopedRouter('/domains/dom-1', { id: 'dom-1' });
        const detailView = createDomainDetailView(state, apiClient)({
            params: detailRouter.params,
            query: detailRouter.query,
            router: detailRouter,
        });

        if (detailView instanceof HTMLElement) {
            container.appendChild(detailView);
        }
        flushSync();
        await new Promise(resolve => setTimeout(resolve, 20));
        flushSync();

        const backLink = container.querySelector('a.domains-back-link');
        expect(backLink).not.toBeNull();
        expect(backLink?.tagName.toLowerCase()).toBe('a');
        expect(backLink?.getAttribute('href')).toBe('/domains');
    });

    it('4. the create form rejects invalid input using the contract\'s own schema', async () => {
        const apiClient = createInMemoryApiClient(sampleDomains, sampleDnsRecords);
        const state = createStandaloneDomainAppState(apiClient);
        const router = createTestScopedRouter('/domains');

        const listView = createDomainsListView(state, apiClient)({
            params: router.params,
            query: router.query,
            router,
        });

        if (listView instanceof HTMLElement) {
            container.appendChild(listView);
        }
        await Promise.resolve();
        flushSync();

        const form = container.querySelector('form.domain-create-form');
        expect(form).not.toBeNull();
        if (!(form instanceof HTMLFormElement)) throw new Error('Expected form element');

        const submitBtn = form.querySelector('button[type="submit"]');
        expect(submitBtn).not.toBeNull();
        if (!(submitBtn instanceof HTMLButtonElement)) throw new Error('Expected submit button');

        // 1. Initial form state: orgId and fqdn are empty, so submit is disabled
        expect(submitBtn.disabled).toBe(true);

        const orgInput = form.querySelector('input[name="orgId"]');
        const fqdnInput = form.querySelector('input[name="fqdn"]');
        if (!(orgInput instanceof HTMLInputElement) || !(fqdnInput instanceof HTMLInputElement)) {
            throw new Error('Expected orgId and fqdn input elements');
        }

        // 2. Entering partial data keeps submit disabled
        orgInput.value = '';
        orgInput.dispatchEvent(new Event('input'));
        fqdnInput.value = 'valid-domain.com';
        fqdnInput.dispatchEvent(new Event('input'));
        flushSync();
        expect(submitBtn.disabled).toBe(true);

        // 3. Entering all valid required fields enables submit
        orgInput.value = 'org-acme';
        orgInput.dispatchEvent(new Event('input'));
        fqdnInput.value = 'acme-corp.net';
        fqdnInput.dispatchEvent(new Event('input'));
        flushSync();
        expect(submitBtn.disabled).toBe(false);

        // 4. Submitting dispatches to apiClient and adds domain
        const createSpy = vi.spyOn(apiClient.domain, 'create');
        form.dispatchEvent(new Event('submit'));
        flushSync();

        expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
            orgId: 'org-acme',
            fqdn: 'acme-corp.net',
            status: 'active',
            verificationStatus: 'pending',
        }));
    });

    it('5. unloading the app disposes its state and stops its effects', async () => {
        let effectTicks = 0;
        let testSig: Signal<number> | undefined;

        const host = createAppHost({
            root,
            policy: makePolicy(root, { content: { roles: ['page'] } }),
        });

        // Register test version to observe lifecycle teardown
        clearAppRegistry();
        const customDomainsApp = {
            ...domainsApp,
            onLoad(ctx: AppContext) {
                testSig = ctx.state.signal(0);
                ctx.state.effect(() => {
                    if (testSig) testSig();
                    effectTicks++;
                });
                return domainsApp.onLoad?.(ctx);
            },
        };

        defineApp(customDomainsApp);

        await host.loadApp('domains');
        await host.activateApp('domains');
        flushSync();

        expect(effectTicks).toBeGreaterThan(0);
        const runsBefore = effectTicks;

        // Mutating signal while loaded triggers effect
        if (testSig) {
            testSig.set(1);
        }
        flushSync();
        expect(effectTicks).toBe(runsBefore + 1);

        // Unload app
        await host.unloadApp('domains', { assertNoLeaks: true });
        expect(host.getAppState('domains')).toBeUndefined();
        expect(host.getLoadedAppIds()).not.toContain('domains');

        // Mutating signal after unload does NOT trigger effect
        if (testSig) {
            testSig.set(2);
            testSig.set(3);
        }
        flushSync();

        expect(effectTicks).toBe(runsBefore + 1);
        host.dispose();
    });

    it('6. manifest.yaml is valid per spec/09 schema and validates successfully', () => {
        const manifestPath = path.resolve(process.cwd(), 'manifest.yaml');
        expect(fs.existsSync(manifestPath)).toBe(true);

        const yamlContent = fs.readFileSync(manifestPath, 'utf8');
        const { manifest, policy } = parseManifest(yamlContent, { root });

        expect(manifest.site.id).toBe('console');
        expect(manifest.site.title).toBe('SurfDNS Console');
        expect(manifest.apps?.some(a => a.id === 'domains')).toBe(true);
        expect(policy.regions.content).toBeDefined();
    });

    it('7. mountViews seamlessly switches between List and Detail views and preserves Detail DOM across param changes', async () => {
        const apiClient = createInMemoryApiClient(sampleDomains, sampleDnsRecords);
        const state = createStandaloneDomainAppState(apiClient);

        const currentPathSig = signal<string>('/domains');
        const paramsSig = signal<Record<string, string>>({});
        const querySig = signal<URLSearchParams>(new URLSearchParams());

        const testRouter: ScopedRouter = {
            navigate: async (p) => {
                currentPathSig.set(p);
                const parts = p.split('/').filter(Boolean);
                if (parts.length >= 2 && parts[1]) {
                    paramsSig.set({ id: parts[1] });
                } else {
                    paramsSig.set({});
                }
            },
            replace: async (p) => {
                currentPathSig.set(p);
                const parts = p.split('/').filter(Boolean);
                if (parts.length >= 2 && parts[1]) {
                    paramsSig.set({ id: parts[1] });
                } else {
                    paramsSig.set({});
                }
            },
            back: () => {},
            forward: () => {},
            params: paramsSig,
            query: querySig,
            currentPath: currentPathSig,
            mountPrefix: '/domains',
            queryParam: (_name, defaultValue = '') => signal(defaultValue),
        };

        const cleanupViews = mountViews(container, domainViews, testRouter);

        // 1. Initial path: /domains -> renders List View
        flushSync();
        await new Promise(resolve => setTimeout(resolve, 20));
        flushSync();

        expect(container.querySelector('[data-view="domains-list"]')).not.toBeNull();
        expect(container.querySelector('[data-view="domain-detail"]')).toBeNull();

        // 2. Navigate to /domains/dom-1 -> renders Detail View for flybyme.io
        await testRouter.navigate('/domains/dom-1');
        flushSync();
        await new Promise(resolve => setTimeout(resolve, 20));
        flushSync();

        const detailViewEl = container.querySelector('[data-view="domain-detail"]');
        expect(detailViewEl).not.toBeNull();
        expect(container.querySelector('[data-view="domains-list"]')).toBeNull();

        const fqdnTitle = container.querySelector('.domain-fqdn-title');
        expect(fqdnTitle?.textContent).toBe('flybyme.io');

        const dnsRows = container.querySelectorAll('.dns-records-table tbody tr');
        expect(dnsRows.length).toBe(2);

        // 3. Navigate to /domains/dom-2 (same detail view, new params)
        await testRouter.navigate('/domains/dom-2');
        flushSync();
        await new Promise(resolve => setTimeout(resolve, 20));
        flushSync();

        // View subtree is preserved (same detail view container) while text re-evaluates
        expect(container.querySelector('[data-view="domain-detail"]')).toBe(detailViewEl);
        expect(container.querySelector('.domain-fqdn-title')?.textContent).toBe('api.flybyme.io');

        // 4. Navigate back to /domains -> restores List View
        await testRouter.navigate('/domains');
        flushSync();
        await new Promise(resolve => setTimeout(resolve, 20));
        flushSync();

        expect(container.querySelector('[data-view="domains-list"]')).not.toBeNull();
        expect(container.querySelector('[data-view="domain-detail"]')).toBeNull();

        cleanupViews();
    });
});
