/**
 * The listener.
 *
 * mesh-web spec/service-modules.md §2: mesh-api binds a port, plain HTTP, no TLS, behind the surfdns
 * proxy (spec/hosting.md §1). Per request it is stateless; across requests it holds the exposure map
 * and the ticket cache, and nothing else.
 *
 * **Nothing may assume sticky routing** (hosting §4). There is no session here, no per-connection
 * state beyond a live SSE or WebSocket, and no reason a second instance would answer differently —
 * which is what lets a deployment put a process behind any address it likes, or ten of them.
 */

import express, { Router, type Express } from 'express';
import type { Server } from 'node:http';

import { describeExposure, type ExposureDescriptor } from '../exposure/descriptor.js';
import type { ExposeEntry } from '../exposure/types.js';
import type { AuthorizeHook } from '../auth/gate.js';
import { createTicketCache, type TicketCache, type Validator } from '../auth/tickets.js';
import type { ApiBroker } from './broker.js';
import { mountRest } from './rest.js';

export interface ApiServerOptions {
    readonly application: string;
    readonly expose: readonly ExposeEntry[];
    readonly broker: ApiBroker;
    /**
     * How a ticket is checked. The mesh call to identity, injected.
     *
     * Absent means every request is anonymous, which is correct for a site exposing only public
     * contracts and refuses everything else — rather than a default that quietly admits people.
     */
    readonly validateTicket?: Validator;
    readonly authorize?: AuthorizeHook;
    readonly base?: string;
    readonly allowInternal?: boolean;
    readonly onError?: (error: unknown, context: { readonly key: string }) => void;
}

export interface ApiServer {
    readonly app: Express;
    /** What this instance serves, and the hash of it. `api_routes` and `api_status` read this. */
    readonly descriptor: ExposureDescriptor;
    readonly tickets: TicketCache;
    listen(port: number, host?: string): Promise<Server>;
}

/**
 * Build the server.
 *
 * The descriptor is computed **first**, and its construction is what validates the exposure: an
 * ungated entry, a route collision, an internal contract or an undescribable schema all throw here,
 * before a port is bound. A misconfigured API fails to start rather than serving a surface nobody
 * intended.
 */
export function createApiServer(options: ApiServerOptions): ApiServer {
    const descriptor = describeExposure(options.expose, {
        application: options.application,
        ...(options.base === undefined ? {} : { base: options.base }),
        ...(options.allowInternal === undefined ? {} : { allowInternal: options.allowInternal }),
    });

    const tickets = createTicketCache({
        validate: options.validateTicket ?? (async () => ({ valid: false })),
    });

    const router = Router();
    mountRest(router, {
        broker: options.broker,
        expose: options.expose,
        tickets,
        exposure: descriptor.exposure,
        ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
        ...(options.onError === undefined ? {} : { onError: options.onError }),
    });

    const app = express();
    app.use(express.json());

    // What this instance serves, from the instance itself. spec/network.md §6 — a client checks the
    // hash it was built against, and a human debugging a mismatch needs to be able to see both.
    app.get('/_api/status', (_req, res) => {
        res.json({
            application: descriptor.application,
            exposure: descriptor.exposure,
            base: descriptor.base,
            calls: descriptor.calls.length,
            tickets: tickets.size,
        });
    });

    app.get('/_api/routes', (_req, res) => {
        res.json(descriptor.calls.map((c) => ({ key: c.key, method: c.method, path: c.path, gate: c.gate })));
    });

    app.use(descriptor.base, router);

    return {
        app,
        descriptor,
        tickets,
        listen(port: number, host = '0.0.0.0'): Promise<Server> {
            return new Promise((resolve, reject) => {
                const server = app.listen(port, host, () => resolve(server));
                server.once('error', reject);
            });
        },
    };
}
