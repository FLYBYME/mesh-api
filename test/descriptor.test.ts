/**
 * The exposure descriptor.
 *
 * mesh-web roadmap C3.1 and C3.2. Two things are being checked and they are different in kind: that
 * a descriptor says what the site exposes, and that a mistake in the exposure list stops the build
 * rather than reaching production. The second set is the reason this file is longer than the first.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeExposure, hashDescriptor, gateOf, type ExposeEntry } from '../src/index.js';

// ---------------------------------------------------------------------------- contracts to expose

type Contract = ExposeEntry['contract'];

/** A contract shaped like mesh's, without booting a mesh to get one. */
const contract = (options: {
    domain: string;
    action: string;
    method?: string;
    path?: string;
    input?: z.ZodTypeAny;
    output?: z.ZodTypeAny;
    visibility?: 'public' | 'internal';
    destructive?: boolean;
    stream?: boolean;
}): Contract => ({
    domain: options.domain,
    action: options.action,
    description: `${options.domain}.${options.action}`,
    inputSchema: options.input ?? z.object({ id: z.string() }),
    outputSchema: options.output ?? z.object({ ok: z.boolean() }),
    rest: {
        method: (options.method ?? 'GET') as 'GET',
        path: options.path ?? `/${options.domain}/${options.action}`,
        ...(options.stream === true ? { isStream: true } : {}),
    },
    visibility: options.visibility ?? 'public',
    ...(options.destructive === true ? { destructive: true } : {}),
    print: String,
}) as Contract;

const resolve = contract({
    domain: 'credential',
    action: 'resolve',
    path: '/credential/resolve',
    input: z.object({ id: z.string() }),
    output: z.object({
        id: z.string(),
        name: z.string(),
        provider: z.enum(['cloudflare', 'route53']),
        createdAt: z.number(),
    }),
});

const create = contract({
    domain: 'credential',
    action: 'create',
    method: 'POST',
    path: '/credential',
    destructive: true,
});

const site = { application: 'surfdns.console' };

// ---------------------------------------------------------------------------- what it produces

describe('a descriptor is the exposure, as data', () => {
    it('flattens each entry into something with no zod left in it', () => {
        const d = describeExposure([{ contract: resolve, auth: 'user' }], site);

        expect(d.application).toBe('surfdns.console');
        expect(d.base).toBe('/api');
        expect(d.calls).toHaveLength(1);

        const call = d.calls[0]!;
        expect(call.key).toBe('credential.resolve');
        expect(call.method).toBe('GET');
        expect(call.path).toBe('/credential/resolve');
        expect(call.gate).toEqual({ kind: 'auth', level: 'user' });

        // Survives JSON, which is the entire requirement: a build reads this without importing the
        // site's TypeScript or starting a cluster.
        expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    });

    it('describes input and output structurally, so a generator need not see the schema', () => {
        const d = describeExposure([{ contract: resolve, auth: 'user' }], site);
        const output = d.calls[0]!.output as { properties: Record<string, { type?: string; enum?: string[] }> };

        // mesh-web spec/network.md §3.1 — this is what replaces a `z.infer` reaching across a
        // package boundary, which is what surfdns #15 actually was.
        expect(Object.keys(output.properties).sort()).toEqual(['createdAt', 'id', 'name', 'provider']);
        expect(output.properties['createdAt']!.type).toBe('number');
        expect(output.properties['provider']!.enum).toEqual(['cloudflare', 'route53']);
    });

    it('carries the flags a router and a client both need', () => {
        const d = describeExposure(
            [
                { contract: create, permission: 'credential.write' },
                { contract: contract({ domain: 'log', action: 'tail', path: '/log/tail', stream: true }), auth: 'admin' },
            ],
            site,
        );

        const byKey = new Map(d.calls.map((c) => [c.key, c]));
        expect(byKey.get('credential.create')!.destructive).toBe(true);
        expect(byKey.get('credential.create')!.gate).toEqual({ kind: 'permission', permission: 'credential.write' });
        expect(byKey.get('log.tail')!.stream).toBe(true);
    });
});

// ---------------------------------------------------------------------------- the hash

describe('the hash identifies an exposure, not a file', () => {
    it('does not change when the list is reordered', () => {
        const a = describeExposure([{ contract: resolve, auth: 'user' }, { contract: create, auth: 'admin' }], site);
        const b = describeExposure([{ contract: create, auth: 'admin' }, { contract: resolve, auth: 'user' }], site);

        // Moving two lines in a file is not a change to the API, and a CI check that said otherwise
        // would be ignored within a week.
        expect(a.exposure).toBe(b.exposure);
    });

    it('changes when a gate is loosened', () => {
        const strict = describeExposure([{ contract: resolve, auth: 'admin' }], site);
        const loose = describeExposure([{ contract: resolve, auth: 'public' }], site);

        // The case the check exists for. Widening a gate must never be invisible.
        expect(strict.exposure).not.toBe(loose.exposure);
    });

    it('changes when a shape changes', () => {
        const before = describeExposure([{ contract: resolve, auth: 'user' }], site);
        const after = describeExposure([{
            contract: contract({
                domain: 'credential',
                action: 'resolve',
                path: '/credential/resolve',
                output: z.object({ id: z.string() }),
            }),
            auth: 'user',
        }], site);

        expect(before.exposure).not.toBe(after.exposure);
    });

    it('recomputes to itself, so a stored descriptor can be verified', () => {
        const d = describeExposure([{ contract: resolve, auth: 'user' }, { contract: create, auth: 'admin' }], site);

        // What CI does: regenerate, rehash, compare. And what the API does when it reports its own.
        expect(hashDescriptor(d)).toBe(d.exposure);
        expect(hashDescriptor(JSON.parse(JSON.stringify(d)))).toBe(d.exposure);
    });
});

// ---------------------------------------------------------------------------- refusals

describe('a mistake in the exposure list stops the build', () => {
    it('refuses an entry with no gate', () => {
        // Unrepresentable in TypeScript — the union has no member without one — so this is the
        // second line of defence, for a list that arrived as JSON or from a package built elsewhere.
        const ungated = { contract: resolve } as unknown as ExposeEntry;

        expect(() => gateOf(ungated)).toThrow(/must never/);
        expect(() => describeExposure([ungated], site)).toThrow(/no gate/);
    });

    it('refuses an entry that declares both a gate and a permission', () => {
        const both = { contract: resolve, auth: 'public', permission: 'credential.read' } as unknown as ExposeEntry;
        expect(() => describeExposure([both], site)).toThrow(/both auth and permission/);
    });

    it('will not compile an entry with neither', () => {
        // @ts-expect-error an exposed contract must declare auth or permission
        const _entry: ExposeEntry = { contract: resolve };
    });

    it('refuses to expose a contract its own domain marks internal', () => {
        const internal = contract({ domain: 'credential', action: 'purge', visibility: 'internal' });

        // mesh defaults contracts to internal so that defineCrud's ten generated contracts are not
        // all published. Exposing one to the internet should be a decision, not an omission.
        expect(() => describeExposure([{ contract: internal, auth: 'admin' }], site))
            .toThrow(/marked internal/);

        // And an explicit override exists, because sometimes it really is the right call.
        expect(describeExposure([{ contract: internal, auth: 'admin' }], { ...site, allowInternal: true }).calls)
            .toHaveLength(1);
    });

    it('refuses two entries for one contract', () => {
        expect(() => describeExposure(
            [{ contract: resolve, auth: 'public' }, { contract: resolve, auth: 'admin' }],
            site,
        )).toThrow(/exposed twice/);
    });

    it('refuses a route collision', () => {
        const clash = contract({ domain: 'other', action: 'thing', path: '/credential/resolve' });

        expect(() => describeExposure(
            [{ contract: resolve, auth: 'public' }, { contract: clash, auth: 'public' }],
            site,
        )).toThrow(/Route collision/);
    });

    it('says which contract could not be described', () => {
        const undescribable = contract({ domain: 'weird', action: 'thing' });
        // A schema the converter cannot represent. Silently emitting `{}` would produce a client
        // that types this as `unknown` and looks like it works.
        (undescribable as { inputSchema: unknown }).inputSchema = { _def: 'not a schema' };

        expect(() => describeExposure([{ contract: undescribable, auth: 'public' }], site))
            .toThrow(/weird\.thing/);
    });
});
