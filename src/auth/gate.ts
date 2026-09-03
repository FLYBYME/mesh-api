/**
 * The gate: may this caller make this call, and in whose scope.
 *
 * mesh-web spec/kernel.md §4 — the API is the only security boundary in the system. Everything else
 * in this repository is plumbing; this file is the part that must be right.
 *
 * ## What changed from `archive/pre-rewrite`, and why
 *
 * The old `executeGate` read, in essence:
 *
 *     if (authorize) { ...delegate entirely... }
 *     else { checkAuth(entry.auth) }
 *
 * so supplying an `authorize` hook **replaced** the coarse gate instead of adding to it. surfdns
 * found this and wrote it down in its own source before anyone else did:
 *
 *   > "mesh-api's `executeGate` replaces `checkAuth` when an authorize hook is supplied, so a hook
 *   > that returns 'no objection from me' grants everything."
 *
 * A security boundary that can be switched off by returning `true` from the wrong place is not a
 * boundary. Here the coarse gate **always** runs, and the hook runs after it and **can only narrow**:
 * it may deny, and it may resolve a scope. It cannot admit anyone the gate refused.
 */

import type { ToolContract, z } from '@flybyme/mesh';

import type { Gate } from '../exposure/types.js';

/** Who is calling, as established by the ticket. Never taken from the request body. */
export interface Caller {
    readonly userId: string;
    /** Platform-level roles. Organization roles are per-scope and resolved by the hook. */
    readonly roles: readonly string[];
}

export interface Denied {
    readonly ok: false;
    readonly status: 401 | 403 | 404 | 400;
    readonly code: string;
    readonly message: string;
}

export interface Allowed {
    readonly ok: true;
    /**
     * The scope the request runs in, as resolved from the caller's own memberships.
     *
     * This is the mechanism, and it is worth stating plainly: it goes on to become
     * `meta.user.tenant_id`, which confines every scoped collection. **A caller-supplied
     * organization id cannot override it** — that is the whole reason the hook returns the scope
     * rather than the request carrying it.
     */
    readonly scope?: string;
}

export type GateOutcome = Allowed | Denied;

export interface AuthorizeInput {
    readonly caller: Caller | undefined;
    /** What the caller *asked* for. A request, not a grant — the hook decides. */
    readonly requestedScope: string | undefined;
    readonly permission: string | undefined;
    readonly gate: Gate;
    readonly contract: ToolContract<z.ZodTypeAny, z.ZodTypeAny>;
    readonly input: Readonly<Record<string, unknown>>;
}

export type AuthorizeResult =
    | { readonly authorized: true; readonly resolvedScope?: string }
    | { readonly authorized: false; readonly status?: 400 | 403 | 404; readonly code?: string; readonly message?: string };

export type AuthorizeHook = (input: AuthorizeInput) => Promise<AuthorizeResult> | AuthorizeResult;

/**
 * Where a requested scope comes from — one header, and nothing else.
 *
 * The old implementation searched "path params, query params, or body" for any of `orgId`,
 * `tenantId`, `scope` or `organizationId`: four caller-controlled names across three locations,
 * with precedence decided by object spread order. Guessing which key meant scope is how a request
 * ends up reading the wrong organization's data, and the failure is silent because the wrong answer
 * is a perfectly valid one.
 *
 * One header. If it is absent the hook decides what that means — for a caller in exactly one
 * organization it is unambiguous, and for a caller in several it is an error the hook can explain.
 */
export const SCOPE_HEADER = 'x-organization';

export interface GateRequest {
    readonly gate: Gate;
    readonly contract: ToolContract<z.ZodTypeAny, z.ZodTypeAny>;
    readonly caller: Caller | undefined;
    readonly requestedScope: string | undefined;
    readonly input: Readonly<Record<string, unknown>>;
    readonly authorize?: AuthorizeHook;
}

/** The platform role that satisfies `auth: 'admin'`. Organization roles are a different question. */
export const ADMIN_ROLE = 'admin';

/**
 * Run the gate.
 *
 * Two stages, always in this order, and the second can only take away:
 *
 *   1. **coarse** — is this reachable at all by this caller. Cannot be skipped or replaced.
 *   2. **the hook** — the site's own answer to "in which organization, and may they do this there".
 *      It runs only if stage 1 allowed the call.
 */
export async function executeGate(request: GateRequest): Promise<GateOutcome> {
    const coarse = checkCoarse(request);
    if (!coarse.ok) return coarse;

    const permission = request.gate.kind === 'permission' ? request.gate.permission : undefined;

    if (request.authorize === undefined) {
        // A permission cannot be evaluated without the site's hook — only the site knows what
        // `identity.invite` means. Serving the call anyway would be serving it ungated, so this is
        // a refusal rather than a fallback. A misconfigured deployment must fail closed.
        if (permission !== undefined) {
            return {
                ok: false,
                status: 403,
                code: 'NO_AUTHORIZE_HOOK',
                message: `${key(request.contract)} requires permission '${permission}', ` +
                    `and this API has no authorize hook to evaluate it.`,
            };
        }
        return coarse;
    }

    const result = await request.authorize({
        caller: request.caller,
        requestedScope: request.requestedScope,
        permission,
        gate: request.gate,
        contract: request.contract,
        input: request.input,
    });

    if (!result.authorized) {
        return {
            ok: false,
            status: result.status ?? (request.caller === undefined ? 401 : 403),
            code: result.code ?? 'FORBIDDEN',
            message: result.message ?? 'Insufficient privileges',
        };
    }

    // The hook allowed it — but stage 1 already allowed it too, so this adds only the scope. There
    // is deliberately no path by which `authorized: true` overturns a coarse refusal.
    return result.resolvedScope === undefined ? { ok: true } : { ok: true, scope: result.resolvedScope };
}

/**
 * The coarse gate. Reachable at all, and by whom.
 *
 * A `permission` entry implies authentication: there is no such thing as an anonymous caller
 * satisfying `identity.invite`, so the check is here rather than left to every hook to remember.
 */
function checkCoarse(request: GateRequest): GateOutcome {
    const { gate, caller } = request;

    if (gate.kind === 'permission') {
        return caller === undefined ? unauthenticated(request) : { ok: true };
    }

    switch (gate.level) {
        case 'public':
            return { ok: true };

        case 'user':
            return caller === undefined ? unauthenticated(request) : { ok: true };

        case 'admin':
            if (caller === undefined) return unauthenticated(request);
            if (!caller.roles.includes(ADMIN_ROLE)) {
                return {
                    ok: false,
                    status: 403,
                    code: 'FORBIDDEN',
                    message: `${key(request.contract)} requires the ${ADMIN_ROLE} role.`,
                };
            }
            return { ok: true };
    }
}

const unauthenticated = (request: GateRequest): Denied => ({
    ok: false,
    status: 401,
    code: 'UNAUTHENTICATED',
    message: `${key(request.contract)} requires a valid ticket.`,
});

const key = (contract: ToolContract<z.ZodTypeAny, z.ZodTypeAny>): string =>
    `${contract.domain}.${contract.action}`;
