/**
 * The gate.
 *
 * mesh-web spec/kernel.md §4: the API is the only security boundary in the system. These tests are
 * the boundary, so they are written as adversarially as I can manage — most of them describe a way
 * someone could get in, and assert that they do not.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { executeGate, type AuthorizeHook, type AuthorizeInput, type Caller, type GateOutcome } from '../src/index.js';
import type { ToolContract } from '@flybyme/mesh';

const contract = {
    domain: 'identity',
    action: 'invite',
    description: 'invite',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    rest: { method: 'POST', path: '/identity/invite' },
    visibility: 'public',
    print: String,
} as unknown as ToolContract;

const user: Caller = { userId: 'u1', roles: [] };
const admin: Caller = { userId: 'u2', roles: ['admin'] };

const run = (over: Partial<Parameters<typeof executeGate>[0]> = {}): Promise<GateOutcome> =>
    executeGate({
        gate: { kind: 'auth', level: 'public' },
        contract,
        caller: undefined,
        requestedScope: undefined,
        input: {},
        ...over,
    });

describe('the coarse gate', () => {
    it('lets anyone call a public contract', async () => {
        expect(await run()).toEqual({ ok: true });
    });

    it('refuses an anonymous caller on a user contract, with 401 rather than 403', async () => {
        const denied = await run({ gate: { kind: 'auth', level: 'user' } });

        // 401 means "say who you are", 403 means "I know who you are and no". Returning 403 to an
        // anonymous caller tells a browser to give up rather than to sign in.
        expect(denied).toMatchObject({ ok: false, status: 401, code: 'UNAUTHENTICATED' });
    });

    it('lets any authenticated caller call a user contract', async () => {
        expect(await run({ gate: { kind: 'auth', level: 'user' }, caller: user })).toEqual({ ok: true });
    });

    it('refuses a non-admin on an admin contract', async () => {
        expect(await run({ gate: { kind: 'auth', level: 'admin' }, caller: user }))
            .toMatchObject({ ok: false, status: 403 });

        expect(await run({ gate: { kind: 'auth', level: 'admin' }, caller: admin })).toEqual({ ok: true });
    });

    it('treats a permission as implying authentication', async () => {
        // There is no anonymous caller who satisfies `identity.invite`, so this is checked once here
        // rather than left to every site's hook to remember.
        expect(await run({ gate: { kind: 'permission', permission: 'identity.invite' } }))
            .toMatchObject({ ok: false, status: 401 });
    });

    it('refuses a permission it has no hook to evaluate', async () => {
        // Only the site knows what `identity.invite` means. With no hook, serving the call would be
        // serving it ungated — so a misconfigured deployment fails closed rather than open.
        expect(await run({ gate: { kind: 'permission', permission: 'identity.invite' }, caller: user }))
            .toMatchObject({ ok: false, code: 'NO_AUTHORIZE_HOOK' });
    });
});

describe('the hook can only narrow', () => {
    /**
     * The regression this file exists for.
     *
     * In `archive/pre-rewrite`, `executeGate` delegated *entirely* to the authorize hook when one was
     * supplied — `if (authorize) {...} else { checkAuth(...) }` — so a hook that meant "no objection
     * from me" granted everything, including admin-gated contracts to anonymous callers. surfdns
     * documented the trap in its own source. Here the coarse gate always runs first.
     */
    const permissive: AuthorizeHook = () => ({ authorized: true });

    it('does not let a permissive hook admit an anonymous caller', async () => {
        expect(await run({ gate: { kind: 'auth', level: 'user' }, authorize: permissive }))
            .toMatchObject({ ok: false, status: 401 });
    });

    it('does not let a permissive hook admit a non-admin to an admin contract', async () => {
        expect(await run({ gate: { kind: 'auth', level: 'admin' }, caller: user, authorize: permissive }))
            .toMatchObject({ ok: false, status: 403 });
    });

    it('never calls the hook at all when the coarse gate refused', async () => {
        const hook = vi.fn(permissive);
        await run({ gate: { kind: 'auth', level: 'admin' }, caller: user, authorize: hook });

        // Not merely "the answer is right": the hook is not consulted, so a hook that throws, hangs
        // or has a bug cannot affect a decision that was already made.
        expect(hook).not.toHaveBeenCalled();
    });

    it('lets the hook deny something the coarse gate allowed', async () => {
        const hook: AuthorizeHook = () => ({ authorized: false, status: 404, code: 'NOT_FOUND', message: 'No such organization' });

        // 404 rather than 403 for an organization that exists but is not yours: saying "it exists,
        // but not for you" is itself a disclosure. surfdns got this right and it is preserved.
        expect(await run({ gate: { kind: 'auth', level: 'user' }, caller: user, authorize: hook }))
            .toEqual({ ok: false, status: 404, code: 'NOT_FOUND', message: 'No such organization' });
    });
});

describe('scope comes from the hook, never from the request', () => {
    it('returns the scope the hook resolved', async () => {
        const hook: AuthorizeHook = () => ({ authorized: true, resolvedScope: 'org-real' });

        expect(await run({ gate: { kind: 'auth', level: 'user' }, caller: user, authorize: hook }))
            .toEqual({ ok: true, scope: 'org-real' });
    });

    it('passes what the caller asked for as a request, not as a grant', async () => {
        const seen: string[] = [];
        const hook: AuthorizeHook = (input) => {
            seen.push(String(input.requestedScope));
            // The hook checks it against the caller's memberships and says no.
            return { authorized: false, status: 404, code: 'NOT_FOUND', message: 'No such organization' };
        };

        const outcome = await run({
            gate: { kind: 'auth', level: 'user' },
            caller: user,
            requestedScope: 'org-someone-elses',
            authorize: hook,
        });

        expect(seen).toEqual(['org-someone-elses']);
        expect(outcome).toMatchObject({ ok: false, status: 404 });
    });

    it('ignores an organization id in the request body', async () => {
        const hook: AuthorizeHook = () => ({ authorized: true, resolvedScope: 'org-real' });

        const outcome = await run({
            gate: { kind: 'auth', level: 'user' },
            caller: user,
            // The attack: name someone else's organization in the payload and hope it is believed.
            input: { organizationId: 'org-someone-elses', orgId: 'org-someone-elses', scope: 'org-someone-elses' },
            authorize: hook,
        });

        // The scope is what the hook resolved from memberships. The body contributed nothing, which
        // is the entire mechanism — and is why `requestedScope` is one header rather than a search
        // through params, query and body for any of four names.
        expect(outcome).toEqual({ ok: true, scope: 'org-real' });
    });

    it('gives the hook the permission and the contract it is deciding about', async () => {
        const seen: AuthorizeInput[] = [];
        const hook: AuthorizeHook = (input) => {
            seen.push(input);
            return { authorized: true };
        };

        await run({
            gate: { kind: 'permission', permission: 'identity.invite' },
            caller: user,
            authorize: hook,
        });

        expect(seen[0]).toMatchObject({
            permission: 'identity.invite',
            caller: user,
            contract: { domain: 'identity', action: 'invite' },
        });
    });

    it('does not report a scope when the hook resolved none', async () => {
        const hook: AuthorizeHook = () => ({ authorized: true });
        expect(await run({ gate: { kind: 'auth', level: 'user' }, caller: user, authorize: hook }))
            .toEqual({ ok: true });
    });
});
