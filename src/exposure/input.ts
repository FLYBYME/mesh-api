import { z } from 'zod';
import { unwrapSchema, getObjectShape } from './schema.js';

/**
 * Path params and query strings are always strings -- HTTP has no other type. A contract that
 * declares `limit: z.number()` would therefore reject `?limit=10` on a technicality that has
 * nothing to do with the caller being wrong.
 *
 * So string-shaped inputs are coerced *toward what the contract already declares*, before
 * validation. This is not a second schema and not a second validation layer: the contract remains
 * the sole authority on what is valid: it is only being told the value in the type it asked for.
 * Anything the schema does not describe as a number/boolean/array is passed through untouched.
 */
export function coerceToSchema(schema: z.ZodTypeAny, input: Record<string, unknown>): Record<string, unknown> {
    const shape = getObjectShape(schema);
    if (!shape) return input;

    const out: Record<string, unknown> = { ...input };
    for (const [key, value] of Object.entries(input)) {
        const field = shape[key];
        if (!field) continue;
        const unwrapped = unwrapSchema(field);
        if (unwrapped) {
            out[key] = coerceValue(unwrapped.inner, value);
        }
    }
    return out;
}

function coerceValue(field: z.ZodTypeAny, value: unknown): unknown {
    if (field instanceof z.ZodArray) {
        // `?tag=a&tag=b` already arrives as an array; `?tag=a` arrives as a scalar. A contract
        // asking for an array should get one either way.
        const items = Array.isArray(value) ? value : [value];
        const elementUnwrapped = unwrapSchema(field.element);
        const element = elementUnwrapped ? elementUnwrapped.inner : field.element;
        return items.map(item => coerceValue(element, item));
    }
    if (typeof value !== 'string') return value;
    if (field instanceof z.ZodNumber) {
        // Empty string is not zero. Leave it alone and let the schema reject it with a real message.
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

/** Returns the field map of an object schema, or undefined if the schema is not an object. */
export function objectShapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
    return getObjectShape(schema);
}

/**
 * formatZodError: turns a validation failure into a message a client can act on.
 *
 * The broker also validates, but it wraps the failure in a plain `Error`, which would map to a 500
 * and hide the reason (`src/core/ServiceBroker.ts`). Validating at the boundary with the
 * contract's own schema is what makes a bad request a 400 that says which field was wrong.
 */
export function formatZodError(error: z.ZodError): string {
    return error.issues
        .map(issue => {
            const path = issue.path.join('.');
            return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join('; ');
}
