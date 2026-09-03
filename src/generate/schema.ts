/**
 * JSON Schema to a TypeScript type expression.
 *
 * This is the whole of the client generator's difficulty, and it exists because of a decision made
 * two documents away: mesh-web spec/network.md §3.1 says a generated client emits **structural
 * types, never a `z.infer` reference across a package boundary**. surfdns #15 was exactly that
 * reference, and it broke on a zod version bump. So the shapes have to be written out, and writing
 * them out means reading JSON Schema.
 *
 * **The rule when a schema cannot be represented is to fail, not to emit `unknown`.** An `unknown`
 * in a generated client is worse than no client: it type-checks everywhere, so nobody finds out, and
 * the whole point of generating this file is that the compiler knows what the API accepts.
 *
 * Only what `zod-to-json-schema` actually emits is handled — deliberately, rather than aiming at the
 * whole JSON Schema specification. A generator that half-supports `$ref` is a generator that emits a
 * wrong type for a schema someone wrote in good faith.
 */

export interface Emitted {
    /** The type expression, e.g. `{ id: string }` or `CredentialOutput`. */
    readonly type: string;
    /** Named interfaces this expression refers to, in declaration order. */
    readonly declarations: readonly string[];
}

interface Context {
    /** Named types collected so far, keyed by name, so two identical shapes share one name. */
    readonly named: Map<string, string>;
    /** Where we are, for an error message that says which field could not be represented. */
    readonly path: readonly string[];
}

export class UnrepresentableSchema extends Error {
    constructor(readonly at: readonly string[], readonly schema: unknown, detail: string) {
        super(
            `Cannot generate a type for ${at.length === 0 ? 'the root' : at.join('.')}: ${detail}. ` +
            `A generated client that types this as \`unknown\` would type-check everywhere and tell ` +
            `nobody, so this is refused instead. Schema: ${JSON.stringify(schema).slice(0, 200)}`,
        );
        this.name = 'UnrepresentableSchema';
    }
}

/**
 * Turn one schema into a type expression, plus any named interfaces it needs.
 *
 * `name` is a suggestion: an object schema becomes an interface with that name, and anything else
 * becomes an inline expression, because `type CredentialId = string` is noise.
 */
export function emitType(schema: unknown, name: string): Emitted {
    const named = new Map<string, string>();
    const type = walk(schema, { named, path: [] }, name);
    return { type, declarations: [...named.values()] };
}

function walk(schema: unknown, ctx: Context, suggestedName?: string): string {
    if (schema === true) return 'unknown';
    if (typeof schema !== 'object' || schema === null) {
        throw new UnrepresentableSchema(ctx.path, schema, 'not a schema object');
    }

    const s = schema as Record<string, unknown>;

    // An empty schema is `z.unknown()` or `z.any()`. The author said "anything", which is a
    // decision rather than a gap, so it is honoured rather than refused.
    const keys = Object.keys(s).filter((k) => k !== '$schema' && k !== 'description' && k !== 'default');
    if (keys.length === 0) return 'unknown';

    if (typeof s['$ref'] === 'string') {
        throw new UnrepresentableSchema(
            ctx.path, schema,
            `a $ref, which means the descriptor was generated without $refStrategy: 'none'`,
        );
    }

    if (Array.isArray(s['enum'])) return unionOf(s['enum'].map(literal));
    if ('const' in s) return literal(s['const']);

    if (Array.isArray(s['anyOf'])) return unionOf(s['anyOf'].map((m, i) => walk(m, at(ctx, `[${String(i)}]`))));
    if (Array.isArray(s['oneOf'])) return unionOf(s['oneOf'].map((m, i) => walk(m, at(ctx, `[${String(i)}]`))));

    if (Array.isArray(s['allOf'])) {
        // An intersection. Parenthesised because `A & B | C` does not mean what it looks like.
        return s['allOf'].map((m, i) => walk(m, at(ctx, `&${String(i)}`))).join(' & ');
    }

    const type = s['type'];

    // `type: ['string', 'null']` — how some emitters write a nullable.
    if (Array.isArray(type)) {
        return unionOf(type.map((t) => walk({ ...s, type: t }, ctx)));
    }

    switch (type) {
        case 'string':
            // A zod date becomes a date-time string over JSON. Typing it as `Date` would be a lie:
            // nothing revives it on the way in.
            return 'string';
        case 'number':
        case 'integer':
            return 'number';
        case 'boolean':
            return 'boolean';
        case 'null':
            return 'null';

        case 'array': {
            const items = s['items'];
            if (Array.isArray(items)) {
                // A tuple.
                return `[${items.map((m, i) => walk(m, at(ctx, `[${String(i)}]`))).join(', ')}]`;
            }
            if (items === undefined) {
                throw new UnrepresentableSchema(ctx.path, schema, 'an array with no item schema');
            }
            const inner = walk(items, at(ctx, '[]'), suggestedName === undefined ? undefined : singular(suggestedName));
            return `readonly ${wrap(inner)}[]`;
        }

        case 'object':
            return object(s, ctx, suggestedName);

        default:
            throw new UnrepresentableSchema(ctx.path, schema, `an unsupported type: ${JSON.stringify(type)}`);
    }
}

function object(s: Record<string, unknown>, ctx: Context, suggestedName?: string): string {
    const properties = s['properties'];

    // No properties, but an `additionalProperties` schema: a record.
    if (properties === undefined || Object.keys(properties as object).length === 0) {
        const additional = s['additionalProperties'];
        if (additional !== undefined && additional !== false && additional !== true) {
            return `Readonly<Record<string, ${walk(additional, at(ctx, '[key]'))}>>`;
        }
        if (additional === true) return 'Readonly<Record<string, unknown>>';
        // `z.object({})` — an object with nothing in it. Rare, and a real answer.
        return 'Record<string, never>';
    }

    const required = new Set(Array.isArray(s['required']) ? s['required'] as string[] : []);
    const fields: string[] = [];

    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
        const optional = required.has(key) ? '' : '?';
        const doc = descriptionOf(value);
        const inner = walk(value, at(ctx, key), suggestedName === undefined ? undefined : suggestedName + pascal(key));
        fields.push(`${doc}    readonly ${safeKey(key)}${optional}: ${inner};`);
    }

    const body = `{\n${fields.join('\n')}\n}`;

    // Only a named object becomes an interface. Everything else stays inline, because a generated
    // file full of `type Foo = string` is harder to read than the string.
    if (suggestedName === undefined) return body;

    const existing = ctx.named.get(suggestedName);
    if (existing === undefined) {
        ctx.named.set(suggestedName, `export interface ${suggestedName} ${body}`);
    }
    return suggestedName;
}

const at = (ctx: Context, segment: string): Context => ({ ...ctx, path: [...ctx.path, segment] });

const unionOf = (members: readonly string[]): string => {
    const unique = [...new Set(members)];
    return unique.length === 1 ? unique[0]! : unique.join(' | ');
};

/** Parenthesise a union before `[]`, because `A | B[]` is not `(A | B)[]`. */
const wrap = (type: string): string => (type.includes('|') || type.includes('&') ? `(${type})` : type);

function literal(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null) return 'null';
    throw new UnrepresentableSchema([], value, 'a literal that is not a string, number, boolean or null');
}

function descriptionOf(schema: unknown): string {
    const description = (schema as Record<string, unknown> | null)?.['description'];
    return typeof description === 'string' && description.trim() !== ''
        ? `    /** ${description.replace(/\*\//g, '*\\/')} */\n`
        : '';
}

/** A key that is not a plain identifier has to be quoted. */
const safeKey = (key: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key));

export const pascal = (value: string): string =>
    value
        .split(/[^A-Za-z0-9]+/)
        .filter((part) => part !== '')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');

/** `Items` → `Item`, so an array of objects names its element sensibly. */
const singular = (name: string): string => (name.endsWith('s') ? name.slice(0, -1) : `${name}Item`);
