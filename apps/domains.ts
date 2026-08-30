import { z, defineCrud } from '@flybyme/mesh';
import {
    h,
    When,
    Table,
    Form,
    Heading,
    Text,
    Badge,
    Card,
    Row,
    Spinner,
    EmptyState,
    defineApp,
    mountViews,
    signal,
    computed,
    resource,
    effect,
    type AppContext,
    type AppDefinition,
    type ScopedRouter,
    type ViewDefinition,
    type ViewComponent,
    type Resource,
    type Signal,
    type ReadonlySignal,
} from '../src/runtime/index.js';

// --- Domain Schema & CRUD Contract (from /home/ubuntu/code/paas/src/tenancy/tenancy.schema.ts) ---

export const DomainRegistrarEnum = z.enum(['name-com', 'external']);
export type DomainRegistrar = z.infer<typeof DomainRegistrarEnum>;

export const DomainVerificationStatusEnum = z.enum(['pending', 'verified', 'failed']);
export type DomainVerificationStatus = z.infer<typeof DomainVerificationStatusEnum>;

export const DomainStatusEnum = z.enum(['active', 'suspended']);
export type DomainStatus = z.infer<typeof DomainStatusEnum>;

export const DomainSchema = z.object({
    orgId: z.string().min(1, 'Organization ID is required').describe("-> organization; or platform sentinel 'platform'"),
    fqdn: z.string().min(1, 'FQDN is required').describe("Fully-qualified domain name, e.g. example.com"),
    registrar: DomainRegistrarEnum.optional().describe("Registrar where domain is held"),
    verificationStatus: DomainVerificationStatusEnum.default('pending').describe("written by domain_verify"),
    dnsZoneId: z.string().optional().describe("-> dnsZone"),
    status: DomainStatusEnum.default('active').describe("Domain status"),
});
export type DomainInput = z.infer<typeof DomainSchema>;

export interface DomainRecord extends DomainInput {
    id: string;
    createdAt?: Date;
    updatedAt?: Date;
}

export const domainCrud = defineCrud('domain', DomainSchema);

// --- DNS Record Schema & Types (from /home/ubuntu/code/paas/src/dns/dns.schema.ts) ---

export const DnsRecordTypeEnum = z.enum(['A', 'AAAA', 'CNAME', 'NS', 'PTR', 'DNAME', 'MX', 'TXT', 'SRV', 'CAA']);
export type DnsRecordType = z.infer<typeof DnsRecordTypeEnum>;

export const DnsRecordSchema = z.object({
    dnsZoneId: z.string().describe("-> dnsZone"),
    name: z.string().describe("relative to zone, @ = apex"),
    ttl: z.number().int().default(300),
    managed: z.boolean().default(false).describe("true if smart-DNS-derived from proxy topology"),
    type: DnsRecordTypeEnum,
    address: z.string().optional(),
    target: z.string().optional(),
    preference: z.number().int().optional(),
    text: z.array(z.string()).optional(),
    priority: z.number().int().optional(),
    weight: z.number().int().optional(),
    port: z.number().int().optional(),
    flags: z.number().int().optional(),
    tag: z.enum(['issue', 'issuewild', 'iodef']).optional(),
    value: z.string().optional(),
});
export type DnsRecordInput = z.infer<typeof DnsRecordSchema>;

export interface DnsRecordItem extends DnsRecordInput {
    id: string;
    createdAt?: Date;
    updatedAt?: Date;
}

export const dnsRecordCrud = defineCrud('dnsRecord', DnsRecordSchema);

// --- API Client Interface ---

export interface DomainApiClient {
    domain: {
        find(query?: { fqdn?: string; orgId?: string }): Promise<DomainRecord[]>;
        get(id: string): Promise<DomainRecord | null>;
        create(input: DomainInput): Promise<DomainRecord>;
        delete(id: string): Promise<{ success: boolean }>;
    };
    dnsRecord: {
        find(query?: { dnsZoneId?: string }): Promise<DnsRecordItem[]>;
        create(input: DnsRecordInput): Promise<DnsRecordItem>;
    };
    verifyDomain?(domainId: string): Promise<{ verificationStatus: DomainVerificationStatus }>;
}

// --- Seed Data & In-Memory Default Client ---

export const INITIAL_DOMAINS: DomainRecord[] = [
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

export const INITIAL_DNS_RECORDS: DnsRecordItem[] = [
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
    {
        id: 'rec-3',
        dnsZoneId: 'zone-1',
        name: '@',
        type: 'TXT',
        text: ['v=spf1 include:_spf.google.com ~all'],
        ttl: 3600,
        managed: false,
    },
    {
        id: 'rec-4',
        dnsZoneId: 'zone-2',
        name: '@',
        type: 'A',
        address: '1.1.1.1',
        ttl: 300,
        managed: false,
    },
];

export function createInMemoryApiClient(
    initialDomains: readonly DomainRecord[] = INITIAL_DOMAINS,
    initialDnsRecords: readonly DnsRecordItem[] = INITIAL_DNS_RECORDS
): DomainApiClient {
    const domains = [...initialDomains];
    const dnsRecords = [...initialDnsRecords];
    let domainCounter = domains.length;
    let dnsCounter = dnsRecords.length;

    return {
        domain: {
            async find(query) {
                if (!query?.fqdn) return [...domains];
                const filter = query.fqdn.toLowerCase();
                return domains.filter(d => d.fqdn.toLowerCase().includes(filter));
            },
            async get(id) {
                const found = domains.find(d => d.id === id);
                return found ? { ...found } : null;
            },
            async create(input) {
                const id = `dom-${++domainCounter}`;
                const newDomain: DomainRecord = {
                    ...input,
                    id,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };
                domains.push(newDomain);
                return { ...newDomain };
            },
            async delete(id) {
                const idx = domains.findIndex(d => d.id === id);
                if (idx !== -1) {
                    domains.splice(idx, 1);
                    return { success: true };
                }
                return { success: false };
            },
        },
        dnsRecord: {
            async find(query) {
                if (!query?.dnsZoneId) return [...dnsRecords];
                return dnsRecords.filter(r => r.dnsZoneId === query.dnsZoneId);
            },
            async create(input) {
                const id = `rec-${++dnsCounter}`;
                const newRec: DnsRecordItem = {
                    ...input,
                    id,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };
                dnsRecords.push(newRec);
                return { ...newRec };
            },
        },
        async verifyDomain(domainId) {
            const domain = domains.find(d => d.id === domainId);
            if (domain) {
                domain.verificationStatus = 'verified';
                return { verificationStatus: 'verified' };
            }
            return { verificationStatus: 'failed' };
        },
    };
}

let activeApiClient: DomainApiClient = createInMemoryApiClient();

export function setDomainApiClient(client: DomainApiClient): void {
    activeApiClient = client;
}

export function getDomainApiClient(): DomainApiClient {
    return activeApiClient;
}

// --- App State & Resource Factory ---

export interface DomainAppState {
    readonly domainsResource: Resource<DomainRecord[]>;
    readonly fqdnFilter: Signal<string>;
    readonly filteredDomains: ReadonlySignal<readonly DomainRecord[]>;
    readonly activeDomainId: Signal<string | null>;
    readonly activeDomainResource: Resource<DomainRecord | null>;
    readonly activeDnsRecordsResource: Resource<DnsRecordItem[]>;
}

export function createDomainAppState(
    ctx: AppContext,
    apiClient: DomainApiClient = getDomainApiClient()
): DomainAppState {
    const fqdnFilter = ctx.state.signal('');
    const activeDomainId = ctx.state.signal<string | null>(null);

    const domainsResource = ctx.state.resource(async () => {
        return apiClient.domain.find();
    });

    const filteredDomains = ctx.state.computed<readonly DomainRecord[]>(() => {
        const raw = domainsResource.data();
        const list: readonly DomainRecord[] = Array.isArray(raw) ? raw : [];
        const filter = fqdnFilter().trim().toLowerCase();
        if (!filter) return list;
        return list.filter(d => d.fqdn.toLowerCase().includes(filter));
    });

    const activeDomainResource = ctx.state.resource(async () => {
        const id = activeDomainId();
        if (!id) return null;
        return apiClient.domain.get(id);
    });

    const activeDnsRecordsResource = ctx.state.resource(async () => {
        const domain = activeDomainResource.data();
        if (!domain?.dnsZoneId) return [];
        return apiClient.dnsRecord.find({ dnsZoneId: domain.dnsZoneId });
    });

    return {
        domainsResource,
        fqdnFilter,
        filteredDomains,
        activeDomainId,
        activeDomainResource,
        activeDnsRecordsResource,
    };
}

// Standalone fallback state when views are rendered outside a full AppContext
export function createStandaloneDomainAppState(
    apiClient: DomainApiClient = getDomainApiClient()
): DomainAppState {
    const fqdnFilter = signal('');
    const activeDomainId = signal<string | null>(null);

    const domainsResource = resource(async () => {
        return apiClient.domain.find();
    });

    const filteredDomains = computed<readonly DomainRecord[]>(() => {
        const raw = domainsResource.data();
        const list: readonly DomainRecord[] = Array.isArray(raw) ? raw : [];
        const filter = fqdnFilter().trim().toLowerCase();
        if (!filter) return list;
        return list.filter(d => d.fqdn.toLowerCase().includes(filter));
    });

    const activeDomainResource = resource(async () => {
        const id = activeDomainId();
        if (!id) return null;
        return apiClient.domain.get(id);
    });

    const activeDnsRecordsResource = resource(async () => {
        const domain = activeDomainResource.data();
        if (!domain?.dnsZoneId) return [];
        return apiClient.dnsRecord.find({ dnsZoneId: domain.dnsZoneId });
    });

    return {
        domainsResource,
        fqdnFilter,
        filteredDomains,
        activeDomainId,
        activeDomainResource,
        activeDnsRecordsResource,
    };
}

// --- View 1: Domains List View ---

export function createDomainsListView(
    appState: DomainAppState,
    apiClient: DomainApiClient = getDomainApiClient()
): ViewComponent {
    return ({ router }) => {
        const { domainsResource, fqdnFilter, filteredDomains } = appState;

        // 1. Header
        const header = h('div', { class: 'domains-list-header' },
            Heading({ level: 1, class: 'domains-title' }, 'Domains'),
            Text({ variant: 'muted', class: 'domains-subtitle' }, 'Manage registered domains, DNS records, and verification status.')
        );

        // 2. Filter Toolbar
        const filterInput = h('input', {
            type: 'text',
            class: 'mesh-input domains-filter-input',
            placeholder: 'Filter domains by FQDN (e.g. example.com)...',
            value: () => fqdnFilter(),
            onInput: (e: Event) => {
                const target = e.target;
                if (target instanceof HTMLInputElement) {
                    fqdnFilter.set(target.value);
                }
            },
        });

        const countBadge = Badge(
            { variant: 'default', class: 'domains-count-badge' },
            () => {
                const count = filteredDomains().length;
                return `${count} domain${count === 1 ? '' : 's'}`;
            }
        );

        const toolbar = h('div', { class: 'domains-toolbar' },
            filterInput,
            countBadge
        );

        // 3. Table of Domains with Keyed For and Real Anchor Navigation
        const table = Table<DomainRecord>({
            rows: filteredDomains,
            key: 'id',
            sortable: true,
            class: 'domains-table',
            columns: [
                {
                    key: 'fqdn',
                    label: 'Domain (FQDN)',
                    render: (_val, row) => {
                        return h('a', {
                            href: `/domains/${row.id}`,
                            class: 'domain-detail-link',
                            'data-id': row.id,
                        }, row.fqdn);
                    },
                },
                {
                    key: 'orgId',
                    label: 'Organization',
                    render: (val) => String(val ?? '—'),
                },
                {
                    key: 'registrar',
                    label: 'Registrar',
                    render: (val) => val ? String(val) : 'None (external)',
                },
                {
                    key: 'verificationStatus',
                    label: 'Verification',
                    render: (val) => {
                        const status = String(val ?? 'pending');
                        const variant = status === 'verified' ? 'success' : status === 'failed' ? 'danger' : 'warning';
                        return Badge({ variant, class: `verification-badge verification-${status}` }, status);
                    },
                },
                {
                    key: 'status',
                    label: 'Status',
                    render: (val) => {
                        const status = String(val ?? 'active');
                        const variant = status === 'active' ? 'success' : 'default';
                        return Badge({ variant, class: `status-badge status-${status}` }, status);
                    },
                },
            ],
        });

        // 4. Create Domain Form (Generated directly from domainCrud.create contract)
        const createCard = Card({ class: 'domain-create-card' },
            Heading({ level: 2, class: 'domain-create-heading' }, 'Register New Domain'),
            Text({ variant: 'muted', class: 'domain-create-subheading' }, 'Add a custom domain or platform-owned domain.'),
            Form({
                contract: domainCrud.create,
                submitLabel: 'Create Domain',
                class: 'domain-create-form',
                onSubmit: async (data) => {
                    const created = await apiClient.domain.create(data);
                    domainsResource.refetch();
                    if (router) {
                        await router.navigate(`/domains/${created.id}`);
                    }
                    return created;
                },
            })
        );

        // 5. Assemble List View Container
        return h('div', { class: 'domains-list-view', 'data-view': 'domains-list' },
            header,
            toolbar,
            table,
            createCard
        );
    };
}

// --- View 2: Domain Detail View ---

export function createDomainDetailView(
    appState: DomainAppState,
    apiClient: DomainApiClient = getDomainApiClient()
): ViewComponent {
    return ({ params, router }) => {
        const { activeDomainId, activeDomainResource, activeDnsRecordsResource, domainsResource } = appState;

        // Keep active domain ID reactively in sync with the route params signal
        effect(() => {
            const nextId = params().id ?? null;
            activeDomainId.set(nextId);
        });

        // 1. Back Link
        const backLink = h('a', {
            href: '/domains',
            class: 'domains-back-link',
        }, '← Back to Domains');

        // 2. Domain Header & Status
        const domainHeader = h('div', { class: 'domain-detail-header' },
            Heading({ level: 1, class: 'domain-fqdn-title' }, () => activeDomainResource.data()?.fqdn ?? 'Domain Details'),
            Row({ gap: 'sm', class: 'domain-badges-row' },
                Badge({
                    class: () => {
                        const s = activeDomainResource.data()?.verificationStatus;
                        const vClass = s === 'verified' ? 'mesh-badge-variant-success' : s === 'failed' ? 'mesh-badge-variant-danger' : 'mesh-badge-variant-warning';
                        return `detail-verification-badge ${vClass}`;
                    },
                }, () => `Verification: ${activeDomainResource.data()?.verificationStatus ?? 'pending'}`),
                Badge({
                    class: () => {
                        const s = activeDomainResource.data()?.status;
                        const vClass = s === 'active' ? 'mesh-badge-variant-success' : 'mesh-badge-variant-default';
                        return `detail-status-badge ${vClass}`;
                    },
                }, () => `Status: ${activeDomainResource.data()?.status ?? 'active'}`)
            )
        );

        // 3. Domain Info Card
        const domainInfoCard = Card({ class: 'domain-info-card' },
            Heading({ level: 3, class: 'domain-info-heading' }, 'Domain Configuration'),
            h('dl', { class: 'domain-metadata-list' },
                h('dt', {}, 'Domain ID:'),
                h('dd', { class: 'meta-domain-id' }, () => activeDomainResource.data()?.id ?? '—'),
                h('dt', {}, 'FQDN:'),
                h('dd', { class: 'meta-fqdn' }, () => activeDomainResource.data()?.fqdn ?? '—'),
                h('dt', {}, 'Organization:'),
                h('dd', { class: 'meta-org-id' }, () => activeDomainResource.data()?.orgId ?? '—'),
                h('dt', {}, 'Registrar:'),
                h('dd', { class: 'meta-registrar' }, () => activeDomainResource.data()?.registrar ?? 'None (external)'),
                h('dt', {}, 'DNS Zone ID:'),
                h('dd', { class: 'meta-zone-id' }, () => activeDomainResource.data()?.dnsZoneId ?? '—')
            )
        );

        // 4. DNS Records Table
        const dnsRecordsRows = computed<readonly DnsRecordItem[]>(() => {
            const raw = activeDnsRecordsResource.data();
            return Array.isArray(raw) ? raw : [];
        });

        const dnsTable = Table<DnsRecordItem>({
            rows: dnsRecordsRows,
            key: 'id',
            sortable: true,
            class: 'dns-records-table',
            columns: [
                { key: 'name', label: 'Name' },
                {
                    key: 'type',
                    label: 'Type',
                    render: (val) => Badge({ variant: 'default' }, String(val ?? 'A')),
                },
                {
                    key: 'value',
                    label: 'Target / Value',
                    render: (_v, row) => {
                        return row.address || row.target || (row.text ? row.text.join(', ') : '—');
                    },
                },
                {
                    key: 'ttl',
                    label: 'TTL (sec)',
                    render: (val) => String(val ?? 300),
                },
                {
                    key: 'managed',
                    label: 'Managed',
                    render: (val) => val ? 'Yes (proxy)' : 'No (manual)',
                },
            ],
        });

        const dnsRecordsCard = Card({ class: 'dns-records-card' },
            Heading({ level: 2, class: 'dns-section-heading' }, 'DNS Records'),
            Text({ variant: 'muted', class: 'dns-section-subtitle' }, 'Records configured for this domain zone.'),
            When(
                () => activeDnsRecordsResource.loading(),
                () => Spinner({ label: 'Loading DNS records...', size: 'sm' }),
                () => When(
                    () => dnsRecordsRows().length === 0,
                    () => EmptyState({ title: 'No DNS records found', description: 'No records exist in this DNS zone.' }),
                    () => dnsTable
                )
            )
        );

        // 5. Create Domain Form on Detail Page
        const createCard = Card({ class: 'domain-create-card' },
            Heading({ level: 2, class: 'domain-create-heading' }, 'Register New Domain'),
            Form({
                contract: domainCrud.create,
                submitLabel: 'Create Domain',
                class: 'domain-create-form',
                onSubmit: async (data) => {
                    const created = await apiClient.domain.create(data);
                    domainsResource.refetch();
                    if (router) {
                        await router.navigate(`/domains/${created.id}`);
                    }
                    return created;
                },
            })
        );

        return h('div', { class: 'domain-detail-view', 'data-view': 'domain-detail' },
            backLink,
            domainHeader,
            domainInfoCard,
            dnsRecordsCard,
            createCard
        );
    };
}

// --- App Factory & Self-Registration via defineApp ---

let currentAppState: DomainAppState | null = null;
let currentAppCleanup: (() => void) | null = null;

export function getActiveDomainAppState(): DomainAppState | null {
    return currentAppState;
}

export const domainViews: readonly ViewDefinition[] = [
    {
        path: '/',
        view: (props) => {
            const client = getDomainApiClient();
            const state = currentAppState ?? createStandaloneDomainAppState(client);
            return createDomainsListView(state, client)(props);
        },
    },
    {
        path: '/:id',
        view: (props) => {
            const client = getDomainApiClient();
            const state = currentAppState ?? createStandaloneDomainAppState(client);
            return createDomainDetailView(state, client)(props);
        },
    },
];

export const domainsApp: AppDefinition = defineApp({
    id: 'domains',
    title: 'Domains',

    async onLoad(ctx: AppContext) {
        const apiClient = getDomainApiClient();
        const appState = createDomainAppState(ctx, apiClient);
        currentAppState = appState;

        // The app never places itself -- requests a surface from the compositor
        // Refusal is handled gracefully without throwing
        const pageSurface = await ctx.requestSurface({ role: 'page' });
        if (!pageSurface.granted) {
            // Surface refused by compositor layout policy (normal outcome, not an error)
            return;
        }

        // Surface granted: setup views
        const listView = createDomainsListView(appState, apiClient);
        const detailView = createDomainDetailView(appState, apiClient);

        const views: readonly ViewDefinition[] = [
            { path: '/', view: listView },
            { path: '/:id', view: detailView },
        ];

        const routeParams = ctx.state.signal<Record<string, string>>({});
        const routeQuery = ctx.state.signal<URLSearchParams>(new URLSearchParams());
        const currentPath = ctx.state.signal<string>('/domains');

        const fallbackRouter: ScopedRouter = {
            navigate: async (path) => { currentPath.set(path); },
            replace: async (path) => { currentPath.set(path); },
            back: () => {},
            forward: () => {},
            params: routeParams,
            query: routeQuery,
            currentPath,
            mountPrefix: '/domains',
            queryParam: (_name, defaultValue = '') => {
                return ctx.state.signal(defaultValue);
            },
        };

        const cleanupViews = mountViews(pageSurface.container, views, fallbackRouter);
        currentAppCleanup = cleanupViews;
        ctx.registerCleanup(() => {
            cleanupViews();
            currentAppCleanup = null;
            currentAppState = null;
        });
    },

    async onUnload(_ctx: AppContext) {
        if (currentAppCleanup) {
            currentAppCleanup();
            currentAppCleanup = null;
        }
        currentAppState = null;
    },

    surfaces: [
        {
            role: 'page',
            route: '/domains/*',
            mount(container: HTMLElement, ctx: AppContext) {
                const apiClient = getDomainApiClient();
                const appState = currentAppState ?? createDomainAppState(ctx, apiClient);
                currentAppState = appState;

                const listView = createDomainsListView(appState, apiClient);
                const detailView = createDomainDetailView(appState, apiClient);

                const views: readonly ViewDefinition[] = [
                    { path: '/', view: listView },
                    { path: '/:id', view: detailView },
                ];

                const routeParams = ctx.state.signal<Record<string, string>>({});
                const routeQuery = ctx.state.signal<URLSearchParams>(new URLSearchParams());
                const currentPath = ctx.state.signal<string>('/domains');

                const fallbackRouter: ScopedRouter = {
                    navigate: async (path) => { currentPath.set(path); },
                    replace: async (path) => { currentPath.set(path); },
                    back: () => {},
                    forward: () => {},
                    params: routeParams,
                    query: routeQuery,
                    currentPath,
                    mountPrefix: '/domains',
                    queryParam: (_name, defaultValue = '') => {
                        return ctx.state.signal(defaultValue);
                    },
                };

                const cleanup = mountViews(container, views, fallbackRouter);
                return cleanup;
            },
        },
    ],
});
