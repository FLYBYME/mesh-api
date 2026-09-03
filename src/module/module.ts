/**
 * The `api` ServiceModule.
 *
 * mesh-web roadmap C3.1b, and the point at which everything else in this repository stops running
 * against a fake. Until now the broker was a `Map`, identity was a string comparison, and the mesh
 * was a `Map<string, Set<handler>>` — 85 tests that could not disagree with me about anything.
 *
 * What this adds is small and specific: a module the mesh can register, a real broker behind the
 * router, real ticket validation over the mesh, and real events out of it.
 *
 * ## Why a duck-typed module rather than `extends ServiceModule`
 *
 * `ServiceBroker.registerModule` takes the `IServiceModule` **interface** and never checks
 * `instanceof`, so what it needs is the five members it actually calls. Implementing those directly
 * keeps this module a plain object with no inherited lifecycle to reason about — which matters here
 * because this module's job is to *own a port*, and a port has a lifecycle the base class knows
 * nothing about.
 *
 * ## Registration order
 *
 * `MeshApp.registerModule` before `app.start()` queues into `pendingModules`, and that flush is
 * **unawaited** — so a module registered early may not be ready when the first call arrives.
 * Register after `start()`. `createApiNode` below does that, so nobody has to remember it.
 */

import type {
    IServiceBroker, IServiceContext, IServiceModule, ToolContract, z,
} from '@flybyme/mesh';
import type { Server } from 'node:http';

import type { ExposeEntry } from '../exposure/types.js';
import type { EventExposeEntry } from '../exposure/events.js';
import type { AuthorizeHook } from '../auth/gate.js';
import { createApiServer, type ApiServer } from '../server/server.js';
import type { ApiBroker } from '../server/broker.js';
import type { EventSource } from '../server/sse.js';
import { identityValidator } from './identity.js';
import { apiRoutesContract, apiStatusContract } from './contracts.js';

export interface ApiModuleOptions {
    readonly application: string;
    readonly expose: readonly ExposeEntry[];
    readonly events?: readonly EventExposeEntry[];
    readonly authorize?: AuthorizeHook;
    readonly port: number;
    readonly host?: string;
    readonly base?: string;
    /** The contract identity answers ticket validation on. Absent means no ticket is ever valid. */
    readonly validateTool?: string;
    readonly onError?: (error: unknown, context: { readonly key: string }) => void;
    readonly onUnscopable?: (event: string, payload: unknown) => void;
}

export interface ApiModule extends IServiceModule {
    /** The HTTP server, once started. Present so a test can address it without guessing a port. */
    readonly listener: Server | undefined;
    readonly api: ApiServer | undefined;
}

/**
 * Build the module.
 *
 * Nothing binds a port and nothing validates the exposure until `onStart` — a module that threw at
 * construction would fail before the mesh could log why, and a module that bound a port at
 * construction could not be registered twice in one process for a test.
 */
export function createApiModule(options: ApiModuleOptions): ApiModule {
    let api: ApiServer | undefined;
    let listener: Server | undefined;
    let broker: IServiceBroker | undefined;

    const contracts: ToolContract<z.ZodTypeAny, z.ZodTypeAny>[] = [
        apiStatusContract as unknown as ToolContract<z.ZodTypeAny, z.ZodTypeAny>,
        apiRoutesContract as unknown as ToolContract<z.ZodTypeAny, z.ZodTypeAny>,
    ];

    return {
        domain: 'api',

        getContracts: () => contracts,

        isCrud: () => false,

        getEventHandlers: () => new Map(),

        async beforeCrud(_domain, _action, input) { return input; },
        async afterCrud(_domain, _action, output) { return output; },

        async onStart(started: IServiceBroker): Promise<void> {
            broker = started;

            // The narrow structural interface, not IServiceBroker itself — see server/broker.ts for
            // why the dynamic call is confined to one declaration.
            const apiBroker: ApiBroker = {
                call: (tool, params, o) =>
                    (started as unknown as {
                        call(t: string, p: unknown, opts?: unknown): Promise<unknown>;
                    }).call(tool, params, o),
            };

            const source: EventSource = {
                on: (event, handler) => {
                    (started as unknown as { on(e: string, h: (p: unknown, k?: unknown) => void): unknown })
                        .on(event, handler);
                },
                off: (event, handler) => {
                    (started as unknown as { off(e: string, h: (p: unknown, k?: unknown) => void): void })
                        .off(event, handler);
                },
            };

            // Building the server validates the exposure — an ungated entry, a route collision, an
            // internal contract or an undescribable schema all throw here. Thrown from onStart, so
            // the mesh sees a module that failed to start rather than a node quietly serving a
            // surface nobody intended.
            api = createApiServer({
                application: options.application,
                expose: options.expose,
                broker: apiBroker,
                ...(options.events === undefined ? {} : { events: options.events, source }),
                ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
                ...(options.base === undefined ? {} : { base: options.base }),
                ...(options.onError === undefined ? {} : { onError: options.onError }),
                ...(options.onUnscopable === undefined ? {} : { onUnscopable: options.onUnscopable }),
                // No validate tool means no ticket is ever valid, which is correct for a site
                // exposing only public contracts and refuses everything else — rather than a
                // default that quietly admits people.
                ...(options.validateTool === undefined ? {} : {
                    validateTicket: identityValidator({ broker: apiBroker, tool: options.validateTool }),
                }),
            });

            listener = await api.listen(options.port, options.host);
            started.logger.info(
                `[api] ${options.application} listening on ${options.host ?? '0.0.0.0'}:${String(options.port)} — ` +
                `${String(api.descriptor.calls.length)} calls at ${api.descriptor.exposure}`,
            );
        },

        async onStop(): Promise<void> {
            api?.events?.close();
            await new Promise<void>((resolve) => {
                if (listener === undefined) return resolve();
                listener.close(() => resolve());
            });
            listener = undefined;
            api = undefined;
        },

        async execute(domain: string, action: string, _input: unknown, ctx: IServiceContext): Promise<unknown> {
            if (api === undefined) throw new Error('api module received a call before it started');

            const key = `${domain}.${action}`;

            if (key === 'api.status') {
                return {
                    application: api.descriptor.application,
                    exposure: api.descriptor.exposure,
                    base: api.descriptor.base,
                    calls: api.descriptor.calls.length,
                    events: options.events?.length ?? 0,
                    tickets: api.tickets.size,
                    listening: addressOf(listener),
                    nodeID: ctx.nodeID ?? broker?.nodeID ?? 'unknown',
                };
            }

            if (key === 'api.routes') {
                return {
                    exposure: api.descriptor.exposure,
                    routes: api.descriptor.calls.map((c) => ({
                        key: c.key,
                        method: c.method,
                        path: c.path,
                        gate: c.gate.kind === 'auth' ? `auth:${c.gate.level}` : `permission:${c.gate.permission}`,
                    })),
                };
            }

            throw new Error(`api module has no action "${action}"`);
        },

        get listener(): Server | undefined { return listener; },
        get api(): ApiServer | undefined { return api; },
    };
}

function addressOf(server: Server | undefined): number | null {
    const address = server?.address();
    return typeof address === 'object' && address !== null ? address.port : null;
}
