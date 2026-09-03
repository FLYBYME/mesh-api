/**
 * The client generator.
 *
 * mesh-web roadmap A3.1a-ii. Two kinds of test, and the second is the one that matters:
 *
 *   1. shapes — JSON Schema in, a TypeScript type expression out
 *   2. **the generated file is compiled**, against mesh-web's real `defineApi`/`call`, together with
 *      a usage file that asserts what the types infer to
 *
 * Without (2) this file would be testing string formatting. A generator whose output "looks right"
 * and does not compile is worth less than no generator, and one that compiles but infers `unknown`
 * is worth less still — it type-checks everywhere and tells nobody.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeExposure, emitClient, emitType, UnrepresentableSchema, type ExposeEntry } from '../src/index.js';

// ---------------------------------------------------------------------------- shapes

const typeOf = (schema: z.ZodTypeAny, name = 'T'): string => {
    const { zodToJsonSchema } = require('zod-to-json-schema') as typeof import('zod-to-json-schema');
    return emitType(zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }), name).type;
};

const declarationsOf = (schema: z.ZodTypeAny, name = 'T'): string => {
    const { zodToJsonSchema } = require('zod-to-json-schema') as typeof import('zod-to-json-schema');
    return emitType(zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }), name)
        .declarations.join('\n');
};

describe('a schema becomes a type', () => {
    it('handles the primitives', () => {
        expect(typeOf(z.string())).toBe('string');
        expect(typeOf(z.number())).toBe('number');
        expect(typeOf(z.boolean())).toBe('boolean');
        // A zod date is a date-time *string* over JSON. Typing it as Date would be a lie — nothing
        // revives it on the way in.
        expect(typeOf(z.date())).toBe('string');
    });

    it('handles enums and literals as unions of literals', () => {
        expect(typeOf(z.enum(['cloudflare', 'route53']))).toBe('"cloudflare" | "route53"');
        expect(typeOf(z.literal('only'))).toBe('"only"');
    });

    it('marks a field optional rather than typing it as undefined', () => {
        const declaration = declarationsOf(z.object({ id: z.string(), limit: z.number().optional() }));
        expect(declaration).toMatch(/readonly id: string;/);
        expect(declaration).toMatch(/readonly limit\?: number;/);
    });

    it('makes a nullable field a union with null', () => {
        expect(declarationsOf(z.object({ org: z.string().nullable() })))
            .toMatch(/readonly org: string \| null;/);
    });

    it('parenthesises a union inside an array', () => {
        // `A | B[]` is not `(A | B)[]`, and getting this wrong produces a type that compiles.
        expect(typeOf(z.array(z.union([z.string(), z.number()])))).toBe('readonly (string | number)[]');
    });

    it('names a nested object rather than inlining it twice', () => {
        const declarations = declarationsOf(
            z.object({ user: z.object({ id: z.string(), name: z.string() }) }),
            'Whoami',
        );

        expect(declarations).toMatch(/export interface WhoamiUser \{/);
        expect(declarations).toMatch(/readonly user: WhoamiUser;/);
    });

    it('handles a record and an array of objects', () => {
        expect(typeOf(z.record(z.string(), z.number()))).toBe('Readonly<Record<string, number>>');

        const declarations = declarationsOf(z.object({ items: z.array(z.object({ id: z.string() })) }), 'List');
        expect(declarations).toMatch(/export interface ListItem \{/);
        expect(declarations).toMatch(/readonly items: readonly ListItem\[\];/);
    });

    it('carries a description through as a doc comment', () => {
        expect(declarationsOf(z.object({ id: z.string().describe('The credential id') })))
            .toMatch(/\/\*\* The credential id \*\//);
    });

    it('refuses a schema it cannot represent rather than emitting unknown', () => {
        // The whole rule. An `unknown` here type-checks everywhere and tells nobody, which is worse
        // than no generated client at all.
        expect(() => emitType({ type: 'array' }, 'T')).toThrow(UnrepresentableSchema);
        expect(() => emitType({ type: 'weird' }, 'T')).toThrow(/unsupported type/);
        expect(() => emitType({ $ref: '#/definitions/X' }, 'T')).toThrow(/\$refStrategy/);
    });

    it('honours an explicitly unknown schema, because that was a decision', () => {
        expect(typeOf(z.unknown())).toBe('unknown');
    });
});

// ---------------------------------------------------------------------------- a real API

const contract = (o: {
    domain: string; action: string; method?: string; path?: string;
    input: z.ZodTypeAny; output: z.ZodTypeAny; description?: string;
}) => ({
    domain: o.domain,
    action: o.action,
    description: o.description ?? `${o.domain}.${o.action}`,
    inputSchema: o.input,
    outputSchema: o.output,
    rest: { method: (o.method ?? 'GET') as 'GET', path: o.path ?? `/${o.domain}/${o.action}` },
    visibility: 'public' as const,
    print: String,
}) as unknown as ExposeEntry['contract'];

const CredentialSchema = z.object({
    id: z.string().describe('The credential id'),
    name: z.string(),
    provider: z.enum(['cloudflare', 'route53']),
    createdAt: z.number(),
    rotatedAt: z.number().optional(),
});

const expose: readonly ExposeEntry[] = [
    {
        contract: contract({
            domain: 'credential', action: 'resolve', path: '/credential/resolve',
            input: z.object({ id: z.string() }),
            output: CredentialSchema,
            description: 'Resolve one credential by id.',
        }),
        auth: 'user',
        errors: ['revoked', 'expired'],
    },
    {
        contract: contract({
            domain: 'credential', action: 'list', path: '/credential',
            input: z.object({ limit: z.number().optional() }),
            output: z.object({ items: z.array(CredentialSchema) }),
        }),
        permission: 'credential.read',
    },
    {
        contract: contract({
            domain: 'session', action: 'whoami', path: '/session/whoami',
            input: z.object({}),
            output: z.object({ userId: z.string(), organization: z.string().nullable() }),
        }),
        auth: 'user',
    },
];

const descriptor = () => describeExposure(expose, { application: 'surfdns.console' });

describe('the emitted file', () => {
    it('declares the API, its hash, and one entry per exposed call', () => {
        const source = emitClient(descriptor());

        expect(source).toMatch(/export const surfdnsConsoleApi = defineApi\(\{/);
        expect(source).toMatch(/exposure: "sha256:[0-9a-f]+"/);
        expect(source).toMatch(/"credential\.resolve": call<CredentialResolveInput, CredentialResolveOutput, "expired" \| "revoked">\("GET", "\/credential\/resolve"\)/);
    });

    it('imports two functions and nothing else', () => {
        const source = emitClient(descriptor());
        const imports = source.split('\n').filter((line) => line.startsWith('import'));

        // §3.1: no zod, no schema package, no reference into the repo the contracts live in. That
        // reference is what surfdns #15 was.
        expect(imports).toEqual([`import { call, defineApi } from '@flybyme/mesh-web';`]);
        expect(source).not.toMatch(/zod|z\.infer|@surfdns/);
    });

    it('makes a call with no input take no argument', () => {
        // `Record<string, never>` would force every caller to pass `{}`.
        expect(emitClient(descriptor())).toMatch(/"session\.whoami": call<void, /);
    });

    it('records the gate and the route in a doc comment', () => {
        const source = emitClient(descriptor());
        expect(source).toMatch(/Resolve one credential by id\./);
        expect(source).toMatch(/GET \/credential\/resolve — auth: user/);
        expect(source).toMatch(/permission: credential\.read/);
    });

    it('shares one interface between calls that return the same shape', () => {
        const source = emitClient(descriptor());
        // Credential appears in `resolve` and inside `list`. Two differing declarations under one
        // name would be a naming bug; identical ones are one declaration.
        expect(source.match(/export interface CredentialResolveOutput /g)).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------- does it compile?

/**
 * The test this file exists for.
 *
 * Emit a client, write a file that uses it the way an Application would, and run `tsc` over both
 * against mesh-web's real declarations. Nothing else here proves the output is *usable*.
 */
describe('the generated client compiles, and infers', () => {
    const meshWeb = '/home/ubuntu/code/mesh-web/dist/index.d.ts';

    it.skipIf(!existsSync(meshWeb))('type-checks against mesh-web, and the types are the real shapes', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mesh-api-generate-'));

        writeFileSync(join(dir, 'client.ts'), emitClient(descriptor()));

        // How an Application would use it. Every assertion here is a *type* assertion: it compiles
        // only if inference produced the shape the contract declared.
        writeFileSync(join(dir, 'usage.ts'), `
import { surfdnsConsoleApi } from './client.js';
import { createClient, fetchTransport } from '@flybyme/mesh-web';

const client = createClient(surfdnsConsoleApi, { transport: fetchTransport() });

export async function main(): Promise<void> {
    const result = await client.call('credential.resolve', { id: 'c1' });

    // @ts-expect-error the value is not reachable before the failure has been considered
    void result.value;

    if (!result.ok) {
        // The declared failures are literals, so this switch is checked.
        if (result.error.kind === 'declared') {
            const name: 'revoked' | 'expired' = result.error.name;
            void name;
        }
        return;
    }

    // Inferred from the contract's own output schema, structurally.
    const provider: 'cloudflare' | 'route53' = result.value.provider;
    const rotated: number | undefined = result.value.rotatedAt;
    void provider; void rotated;

    // No second argument: the contract declares no input.
    const me = await client.call('session.whoami');
    if (me.ok) {
        const org: string | null = me.value.organization;
        void org;
    }

    // @ts-expect-error a call the exposure does not name
    await client.call('credential.delete', { id: 'c1' });

    // @ts-expect-error the wrong input shape
    await client.call('credential.resolve', { name: 'prod' });
}
`);

        writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
                target: 'ES2022',
                module: 'ESNext',
                moduleResolution: 'bundler',
                lib: ['ES2022', 'DOM'],
                strict: true,
                noUncheckedIndexedAccess: true,
                noEmit: true,
                skipLibCheck: true,
                types: [],
                baseUrl: '.',
                paths: { '@flybyme/mesh-web': [meshWeb] },
            },
            include: ['client.ts', 'usage.ts'],
        }));

        try {
            execFileSync('npx', ['tsc', '-p', join(dir, 'tsconfig.json')], {
                cwd: process.cwd(),
                encoding: 'utf8',
                stdio: 'pipe',
            });
        } catch (error) {
            const output = (error as { stdout?: string; stderr?: string }).stdout ?? '';
            throw new Error(`The generated client did not compile:\n${output}`);
        }
    }, 120_000);
});
