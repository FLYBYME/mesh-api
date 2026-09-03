/**
 * REST from contracts.
 *
 * mesh-web roadmap C3.3. One express route per exposed contract, and the route comes from the
 * contract's own `rest` metadata rather than from anything written here — so the path the browser
 * calls and the path the server serves have one source. When they had two, the failure was silent:
 * the old `createWebServer` mounted under `/api` while the client generator defaulted to `''`, and a
 * generated client fetched `/kanban/cards` against a server serving `/api/kanban/cards`.
 *
 * The sequence per request is fixed and each step exists because skipping it was a bug once:
 *
 *   1. resolve the ticket        — who is calling, from the cache, never from the body
 *   2. run the gate              — coarse always, then the site's hook, which can only narrow
 *   3. validate and coerce       — the contract's own schema, so a bad request is a 400 that says why
 *   4. call the mesh             — with the *resolved* scope as tenant_id
 *   5. map the failure           — a MeshError keeps its status; anything else is a 500 with no detail
 */

import type { Request, RequestHandler, Response, Router } from 'express';
import { MeshError } from '@flybyme/mesh';
import { z } from 'zod';

import { gateOf, keyOf, type ExposeEntry } from '../exposure/types.js';
import { executeGate, SCOPE_HEADER, type AuthorizeHook, type Caller } from '../auth/gate.js';
import type { TicketCache } from '../auth/tickets.js';
import type { ApiBroker } from './broker.js';
import { coerceToSchema, formatZodError } from './input.js';

export interface MountOptions {
    readonly broker: ApiBroker;
    readonly expose: readonly ExposeEntry[];
    readonly tickets: TicketCache;
    readonly authorize?: AuthorizeHook;
    /**
     * The exposure hash, reported on every response.
     *
     * mesh-web spec/network.md §6: a generated client carries the hash it was built from and refuses
     * to speak to an API serving a different one. This is the other half of that check — without it
     * the client has nothing to compare against and a stale client fails confusingly instead.
     */
    readonly exposure?: string;
    readonly onError?: (error: unknown, context: { readonly key: string }) => void;
}

export const EXPOSURE_HEADER = 'x-exposure';

/** The one error shape this layer returns, so a client can branch on `code` without matching text. */
interface ErrorBody {
    readonly error: string;
    readonly message: string;
    /** Present and true only for a failure the contract declared. See DeclaredFailure. */
    readonly declared?: true;
}

export function mountRest(router: Router, options: MountOptions): void {
    const routes = new Map<string, string>();

    for (const entry of options.expose) {
        const contract = entry.contract;
        const key = keyOf(entry);

        // Throws on an ungated or double-gated entry, at mount time rather than at request time.
        // A misconfigured API must fail to start, not fail per request in production.
        const gate = gateOf(entry);

        const method = contract.rest.method.toUpperCase();
        const route = `${method} ${contract.rest.path}`;
        const owner = routes.get(route);
        if (owner !== undefined) {
            throw new Error(`Route collision: ${route} is claimed by both ${owner} and ${key}.`);
        }
        routes.set(route, key);

        const handler: RequestHandler = (req, res) => {
            void serve(req, res, { entry, gate, key, options });
        };

        switch (method) {
            case 'GET': router.get(contract.rest.path, handler); break;
            case 'POST': router.post(contract.rest.path, handler); break;
            case 'PUT': router.put(contract.rest.path, handler); break;
            case 'PATCH': router.patch(contract.rest.path, handler); break;
            case 'DELETE': router.delete(contract.rest.path, handler); break;
            default:
                throw new Error(`${key} declares an unsupported REST method: ${method}.`);
        }
    }
}

async function serve(
    req: Request,
    res: Response,
    context: {
        entry: ExposeEntry;
        gate: ReturnType<typeof gateOf>;
        key: string;
        options: MountOptions;
    },
): Promise<void> {
    const { entry, gate, key, options } = context;

    if (options.exposure !== undefined) res.setHeader(EXPOSURE_HEADER, options.exposure);

    try {
        // 1. Who is calling. An unknown or absent ticket is anonymous, not refused — the gate
        //    decides whether anonymous is good enough, because a public contract does not care.
        const caller: Caller | undefined = await options.tickets.resolve(bearer(req));

        // 2. The gate. Before anything is parsed, so a refused caller never reaches validation and
        //    cannot learn about the shape of an input they may not send.
        const outcome = await executeGate({
            gate,
            contract: entry.contract,
            caller,
            requestedScope: header(req, SCOPE_HEADER),
            input: merge(req),
            ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
        });

        if (!outcome.ok) {
            res.status(outcome.status).json({ error: outcome.code, message: outcome.message } satisfies ErrorBody);
            return;
        }

        // 3. Validate with the contract's own schema, after coercing what HTTP flattened to strings.
        const parsed = entry.contract.inputSchema.safeParse(
            coerceToSchema(entry.contract.inputSchema as z.ZodTypeAny, merge(req)),
        );

        if (!parsed.success) {
            res.status(400).json({
                error: 'INVALID_INPUT',
                message: formatZodError(parsed.error),
            } satisfies ErrorBody);
            return;
        }

        // 4. The mesh call. `tenant_id` is the scope the *hook* resolved from the caller's
        //    memberships — never anything the request carried. That is the whole mechanism by which
        //    a caller cannot read another organization's data by naming it.
        const result = await options.broker.call(key, parsed.data, {
            meta: {
                ...(caller === undefined ? {} : {
                    user: { id: caller.userId, ...(outcome.scope === undefined ? {} : { tenant_id: outcome.scope }) },
                }),
            },
        });

        res.status(successStatus(entry)).json(result ?? null);
    } catch (error) {
        options.onError?.(error, { key });
        const mapped = toHttpError(error);
        res.status(mapped.status).json(mapped.body);
    }
}

/**
 * A thrown value becomes a status and a safe body.
 *
 * A `MeshError` already carries the right status and code. Anything else is unexpected, and becomes
 * a 500 with a generic message — because the thrown message may hold internal detail (a Mongo error,
 * a connection string) that must never reach a client. The real error goes to `onError` instead.
 */
export function toHttpError(error: unknown): { status: number; body: ErrorBody } {
    // A failure the contract named. Marked `declared` on the wire, because without that marker it is
    // indistinguishable from a gate refusal — see DeclaredFailure.
    if (error instanceof DeclaredFailure) {
        return {
            status: error.status,
            body: { error: error.name_, message: error.message, declared: true },
        };
    }

    if (error instanceof MeshError) {
        return { status: error.status, body: { error: error.code, message: error.message } };
    }

    return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'Internal server error' } };
}

/**
 * A failure this contract declared, thrown by a handler.
 *
 * Found the moment a real browser called a real API: every gate refusal was arriving at the client
 * as a *declared* failure. The server answered a 401 with `{ error: 'UNAUTHENTICATED', message }`,
 * and the client's rule for "the site named this failure itself" was *a body with a string `error`*
 * — which that is. Two designs, made on opposite sides of the wire, agreeing on a shape and meaning
 * different things by it.
 *
 * Neither side was wrong on its own, and neither side's tests could see it: the client's fake server
 * only ever produced one of the two shapes, and the server's tests never parsed its own output the
 * way a client does. It took one real request to find, which is the argument for this whole
 * integration in one bug.
 *
 * So the two are now different on the wire. `declared: true` is the marker, and it is explicit
 * rather than inferred from a status code — a site is free to answer a declared failure with
 * whatever status suits it, and the caller still knows which kind it is.
 */
export class DeclaredFailure extends Error {
    /**
     * The declared name, e.g. `title_taken`.
     *
     * Not `name`, because `Error.name` already exists and means something else — a subclass that
     * overwrote it would break every `instanceof`-free check and every stack trace header.
     */
    readonly name_: string;
    readonly status: number;

    constructor(name: string, message: string, status = 400) {
        super(message);
        this.name = 'DeclaredFailure';
        this.name_ = name;
        this.status = status;
    }
}

/** 201 for a creation, 200 otherwise. */
const successStatus = (entry: ExposeEntry): number =>
    entry.contract.rest.method.toUpperCase() === 'POST' && entry.contract.action === 'create' ? 201 : 200;

/**
 * Path params, query and body, merged.
 *
 * Body last, deliberately: a route with `:id` in the path and `id` in the body is a caller trying to
 * act on one record through another's URL, and the URL is the one the gate and the router agreed on.
 */
function merge(req: Request): Record<string, unknown> {
    const body = req.body as unknown;
    return {
        ...(req.query as Record<string, unknown>),
        ...(typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {}),
        ...(req.params as Record<string, unknown>),
    };
}

/** The ticket, from the one place it is ever read. */
function bearer(req: Request): string | undefined {
    const value = header(req, 'authorization');
    if (value === undefined) return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(value);
    return match?.[1]?.trim();
}

function header(req: Request, name: string): string | undefined {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value === undefined || value.trim() === '' ? undefined : value.trim();
}
