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

import express, { Router, type Express, type RequestHandler } from 'express';
import type { Server } from 'node:http';

import { describeExposure, type ExposureDescriptor } from '../exposure/descriptor.js';
import type { ExposeEntry } from '../exposure/types.js';
import { SCOPE_HEADER, type AuthorizeHook } from '../auth/gate.js';
import { createTicketCache, type TicketCache, type Validator } from '../auth/tickets.js';
import type { ApiBroker } from './broker.js';
import { EXPOSURE_HEADER, mountRest } from './rest.js';
import { mountEvents, type EventSource } from './sse.js';
import type { EventExposeEntry } from '../exposure/events.js';

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
    /** Exposed event streams. Requires `source`; declaring one without the other is a mistake. */
    readonly events?: readonly EventExposeEntry[];
    readonly source?: EventSource;
    readonly onUnscopable?: (event: string, payload: unknown) => void;
    /**
     * Origins allowed to call this API from a browser.
     *
     * **Which origins may call a site is part of what the site exposes**, alongside which contracts
     * and to whom — so it is declared here rather than defaulted by the server. Found while wiring
     * the first real browser to a real API: in production the CDN and the API sit behind one proxy
     * ([hosting §1](../../spec/hosting.md)) and the question never arises, so an implementation
     * verified only against tests never has to answer it.
     *
     * Absent means **same-origin only**, which is both the production shape and the safe default.
     * There is deliberately no wildcard: `*` plus credentials is the combination browsers refuse anyway, and
     * a list someone typed is a list someone can review.
     */
    readonly allowOrigins?: readonly string[];
}

export interface ApiServer {
    readonly app: Express;
    /** What this instance serves, and the hash of it. `api_routes` and `api_status` read this. */
    readonly descriptor: ExposureDescriptor;
    readonly tickets: TicketCache;
    /** Present only when event streams were exposed. `close()` drops every subscriber. */
    readonly events: { readonly close: () => void; readonly connections: () => number } | undefined;
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

    if ((options.events === undefined) !== (options.source === undefined)) {
        throw new Error(
            'createApiServer: `events` and `source` go together. Exposed events with nothing to ' +
            'listen to would be a subscription that never fires, which looks exactly like a quiet ' +
            'system.',
        );
    }

    const router = Router();

    mountRest(router, {
        broker: options.broker,
        expose: options.expose,
        tickets,
        exposure: descriptor.exposure,
        ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
        ...(options.onError === undefined ? {} : { onError: options.onError }),
    });

    const events = options.events === undefined || options.source === undefined
        ? undefined
        : mountEvents(router, {
            source: options.source,
            events: options.events,
            tickets,
            exposure: descriptor.exposure,
            ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
            ...(options.onUnscopable === undefined ? {} : { onUnscopable: options.onUnscopable }),
        });

    const app = express();

    // Before the body parser and before every route, because a preflight is answered rather than
    // served: the browser asks whether the real request is allowed, and nothing else should run.
    if (options.allowOrigins !== undefined) app.use(cors(options.allowOrigins, descriptor.exposure));

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
        events,
        listen(port: number, host = '0.0.0.0'): Promise<Server> {
            return new Promise((resolve, reject) => {
                const server = app.listen(port, host, () => resolve(server));
                server.once('error', reject);
            });
        },
    };
}

/**
 * Cross-origin access, for the origins the site declared.
 *
 * Written by hand rather than pulled in as a dependency because the interesting part is what is
 * *not* here: no wildcard, no reflect-any-origin, and no `Access-Control-Allow-Credentials`. This
 * API authenticates with a ticket in a header, not a cookie, so a browser never needs to be told to
 * send credentials cross-origin — which removes the one CORS configuration that turns a permissive
 * origin list into a session-riding hole.
 *
 * `x-exposure` is exposed to the page deliberately: the generated client reads it to notice it has
 * gone stale (spec/network.md §6), and a header the browser hides is a check that silently never
 * runs.
 */
function cors(allowed: readonly string[], exposure: string): RequestHandler {
    const origins = new Set(allowed);

    return (req, res, next) => {
        const origin = req.headers.origin;

        // Not a browser request, or an origin this site does not serve. Either way there is nothing
        // to add — and an unknown origin is answered normally rather than refused, because the
        // absence of the header is already the refusal the browser enforces.
        if (typeof origin !== 'string' || !origins.has(origin)) {
            if (req.method === 'OPTIONS') { res.sendStatus(403); return; }
            next();
            return;
        }

        res.setHeader('access-control-allow-origin', origin);
        // The response varies by origin, so a shared cache must not serve one origin's answer to
        // another. Cheap to add and invisible when wrong, which is the worst combination.
        res.setHeader('vary', 'Origin');
        res.setHeader('access-control-expose-headers', `${EXPOSURE_HEADER}, x-correlation-id`);

        if (req.method === 'OPTIONS') {
            res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
            res.setHeader('access-control-allow-headers', `content-type, authorization, ${SCOPE_HEADER}`);
            res.setHeader('access-control-max-age', '600');
            res.setHeader(EXPOSURE_HEADER, exposure);
            res.sendStatus(204);
            return;
        }

        next();
    };
}
