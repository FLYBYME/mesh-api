/**
 * A descriptor becomes a typed client.
 *
 * mesh-web roadmap A3.1a-ii. The emitted file is the shape mesh-web's `defineApi` / `call<I, O, E>`
 * was built to receive — that order was deliberate: the target existed first so the emitter had
 * something to hit rather than a shape invented alongside it.
 *
 * What comes out is a single self-contained module. It imports two functions from
 * `@flybyme/mesh-web` and nothing else — no zod, no schema package, no reference into whatever repo
 * the contracts live in. That is the point of §3.1: a generated file **states the shapes it means**,
 * so it cannot break because a dependency changed its inference.
 */

import type { DescribedCall, ExposureDescriptor } from '../exposure/descriptor.js';
import { emitType, pascal } from './schema.js';

export interface EmitOptions {
    /** The exported constant's name, e.g. `surfdnsApi`. Defaults from the application name. */
    readonly name?: string;
    /** Where `defineApi` and `call` come from. */
    readonly from?: string;
}

export const DEFAULT_IMPORT = '@flybyme/mesh-web';

export function emitClient(descriptor: ExposureDescriptor, options: EmitOptions = {}): string {
    const name = options.name ?? `${camel(descriptor.application)}Api`;
    const from = options.from ?? DEFAULT_IMPORT;

    const declarations: string[] = [];
    const entries: string[] = [];

    for (const call of [...descriptor.calls].sort((a, b) => a.key.localeCompare(b.key))) {
        const base = pascal(call.key);

        const input = emitType(call.input, `${base}Input`);
        const output = emitType(call.output, `${base}Output`);

        declarations.push(...input.declarations, ...output.declarations);
        entries.push(entry(call, input.type, output.type));
    }

    return [
        header(descriptor),
        `import { call, defineApi } from '${from}';`,
        '',
        ...dedupe(declarations).map((d) => `${d}\n`),
        `export const ${name} = defineApi({`,
        `    id: ${JSON.stringify(descriptor.application)},`,
        `    exposure: ${JSON.stringify(descriptor.exposure)},`,
        `    base: ${JSON.stringify(descriptor.base)},`,
        '    calls: {',
        ...entries,
        '    },',
        '});',
        '',
    ].join('\n');
}

function entry(call: DescribedCall, input: string, output: string): string {
    const errors = call.errors.length === 0
        ? 'never'
        : call.errors.map((e) => JSON.stringify(e)).join(' | ');

    // An input with no fields is `void`, so `cx.net.call('session.whoami')` takes no second
    // argument. Expressing "no input" as `{}` would force every caller to pass one.
    const inputType = input === 'Record<string, never>' ? 'void' : input;

    const gate = call.gate.kind === 'auth' ? `auth: ${call.gate.level}` : `permission: ${call.gate.permission}`;

    return [
        `        /**`,
        `         * ${call.description}`,
        `         *`,
        `         * ${call.method} ${call.path} — ${gate}${call.destructive ? ', destructive' : ''}`,
        `         */`,
        `        ${JSON.stringify(call.key)}: call<${inputType}, ${output}, ${errors}>(` +
        `${JSON.stringify(call.method)}, ${JSON.stringify(call.path)}),`,
    ].join('\n');
}

function header(descriptor: ExposureDescriptor): string {
    return [
        '// GENERATED FILE — do not edit.',
        '//',
        `// Emitted from ${descriptor.application}'s exposure descriptor by @flybyme/mesh-api.`,
        `// Exposure: ${descriptor.exposure}`,
        '//',
        '// Regenerate rather than editing. The exposure hash above is checked at run time against',
        '// the one the API reports, so a hand-edited client is a client that lies about a surface',
        '// nobody can verify (mesh-web spec/network.md section 6).',
        '',
    ].join('\n');
}

/**
 * Two calls can produce the same interface — a create and an update both returning a Credential.
 *
 * Deduplicated by exact text: identical declarations are one declaration, and *differing*
 * declarations that share a name are a collision worth failing on rather than silently picking one.
 */
function dedupe(declarations: readonly string[]): string[] {
    const byName = new Map<string, string>();

    for (const declaration of declarations) {
        const name = /export interface (\w+)/.exec(declaration)?.[1];
        if (name === undefined) continue;

        const existing = byName.get(name);
        if (existing !== undefined && existing !== declaration) {
            throw new Error(
                `The generator produced two different types both named ${name}. ` +
                `That is a bug in the naming scheme rather than a problem with the exposure — ` +
                `emitting either one would give a caller a type that is right for one call and ` +
                `wrong for another.`,
            );
        }
        byName.set(name, declaration);
    }

    return [...byName.values()];
}

const camel = (value: string): string => {
    const p = pascal(value);
    return p.charAt(0).toLowerCase() + p.slice(1);
};
