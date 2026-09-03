/**
 * HTTP has one type, and contracts have many.
 *
 * Path params and query strings are always strings. A contract declaring `limit: z.number()` would
 * therefore reject `?limit=10` on a technicality that has nothing to do with the caller being wrong.
 *
 * So string-shaped input is coerced **toward what the contract already declares**, before
 * validation. This is not a second schema and not a second validation layer — the contract remains
 * the sole authority on what is valid. It is only being told the value in the type it asked for.
 * Anything the schema does not describe as a number, boolean or array passes through untouched.
 *
 * Carried forward from `archive/pre-rewrite`, which got this right.
 */

import { z } from 'zod';

/** The field map of an object schema, looking through optional, nullable and default wrappers. */
function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
    const inner = unwrap(schema);
    if (inner instanceof z.ZodObject) return inner.shape as Record<string, z.ZodTypeAny>;
    return undefined;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
    let current = schema;
    // Bounded rather than `while (true)`: a self-referential schema would otherwise spin here, and
    // a request thread spinning is worse than a request failing.
    for (let i = 0; i < 10; i++) {
        if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
            current = current.unwrap() as z.ZodTypeAny;
            continue;
        }
        if (current instanceof z.ZodDefault) {
            current = current.removeDefault() as z.ZodTypeAny;
            continue;
        }
        if (current instanceof z.ZodEffects) {
            current = current.innerType() as z.ZodTypeAny;
            continue;
        }
        break;
    }
    return current;
}

export function coerceToSchema(
    schema: z.ZodTypeAny,
    input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    const shape = shapeOf(schema);
    if (shape === undefined) return { ...input };

    const out: Record<string, unknown> = { ...input };
    for (const [key, value] of Object.entries(input)) {
        const field = shape[key];
        if (field === undefined) continue;
        out[key] = coerce(unwrap(field), value);
    }
    return out;
}

function coerce(field: z.ZodTypeAny, value: unknown): unknown {
    if (field instanceof z.ZodArray) {
        // `?tag=a&tag=b` arrives as an array; `?tag=a` arrives as a scalar. A contract asking for an
        // array should get one either way.
        const items = Array.isArray(value) ? value : [value];
        return items.map((item) => coerce(unwrap(field.element as z.ZodTypeAny), item));
    }

    if (typeof value !== 'string') return value;

    if (field instanceof z.ZodNumber) {
        // An empty string is not zero. Leave it and let the schema reject it with a real message.
        if (value.trim() === '') return value;
        const n = Number(value);
        return Number.isNaN(n) ? value : n;
    }

    if (field instanceof z.ZodBoolean) {
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
    }

    return value;
}

/**
 * A validation failure a client can act on.
 *
 * The broker validates too, but it wraps the failure in a plain `Error`, which maps to a 500 and
 * hides the reason. Validating at the boundary with the contract's own schema is what makes a bad
 * request a 400 that names the field.
 */
export function formatZodError(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.join('.');
            return path === '' ? issue.message : `${path}: ${issue.message}`;
        })
        .join('; ');
}
