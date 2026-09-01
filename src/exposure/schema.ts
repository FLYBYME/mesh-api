// zod directly, not the mesh root. This module is pure schema introspection and is imported by the
// browser `Form` component — a value import of `@flybyme/mesh` here reaches ContextStack, the
// Supervisor and express, and drags the whole server into every console bundle. Same instance.
import { z } from 'zod';

/**
 * Metadata produced by unwrapping Zod wrapper types (Optional, Nullable, Default, Effects, etc.).
 */
export interface UnwrappedSchema {
    readonly raw: z.ZodTypeAny;
    readonly inner: z.ZodTypeAny;
    readonly isOptional: boolean;
    readonly isNullable: boolean;
    readonly hasDefault: boolean;
    readonly defaultValue?: unknown;
    readonly description?: string;
}

export type FormFieldClassification =
    | { readonly kind: 'string'; readonly schema: z.ZodString; readonly unwrapped: UnwrappedSchema }
    | { readonly kind: 'number'; readonly schema: z.ZodNumber; readonly unwrapped: UnwrappedSchema }
    | { readonly kind: 'boolean'; readonly schema: z.ZodBoolean; readonly unwrapped: UnwrappedSchema }
    | { readonly kind: 'enum'; readonly options: readonly string[]; readonly unwrapped: UnwrappedSchema }
    | { readonly kind: 'date'; readonly schema: z.ZodDate; readonly unwrapped: UnwrappedSchema }
    | { readonly kind: 'array'; readonly element: z.ZodTypeAny; readonly unwrapped: UnwrappedSchema }
    | { readonly kind: 'object'; readonly shape: Record<string, z.ZodTypeAny>; readonly unwrapped: UnwrappedSchema }
    | { readonly kind: 'unsupported'; readonly typeName: string; readonly unwrapped: UnwrappedSchema };

/**
 * Peels wrapper schemas (Optional, Nullable, Default, Effects, Readonly, Branded, Catch, Pipeline)
 * to reveal the underlying base schema while accumulating wrapper metadata such as optionality,
 * default values, and help text descriptions.
 *
 * Traversal is bounded to prevent infinite loops on recursive schemas.
 */
export function unwrapSchema(schema: unknown): UnwrappedSchema | undefined {
    if (!(schema instanceof z.ZodType)) {
        return undefined;
    }

    const raw = schema;
    let current: z.ZodTypeAny = schema;
    let isOptional = false;
    let isNullable = false;
    let hasDefault = false;
    let defaultValue: unknown = undefined;
    let description: string | undefined = schema.description;

    for (let i = 0; i < 20; i++) {
        if (!description && current.description) {
            description = current.description;
        }

        if (current instanceof z.ZodOptional) {
            isOptional = true;
            current = current.unwrap();
        } else if (current instanceof z.ZodNullable) {
            isNullable = true;
            current = current.unwrap();
        } else if (current instanceof z.ZodDefault) {
            hasDefault = true;
            isOptional = true;
            defaultValue = current._def.defaultValue();
            current = current.removeDefault();
        } else if (current instanceof z.ZodEffects) {
            current = current.innerType();
        } else if (current instanceof z.ZodReadonly) {
            current = current.unwrap();
        } else if (current instanceof z.ZodBranded) {
            current = current.unwrap();
        } else if (current instanceof z.ZodCatch) {
            current = current.removeCatch();
        } else if (current instanceof z.ZodPipeline) {
            current = current._def.out;
        } else {
            break;
        }
    }

    if (!description && current.description) {
        description = current.description;
    }

    return {
        raw,
        inner: current,
        isOptional,
        isNullable,
        hasDefault,
        defaultValue,
        description,
    };
}

/**
 * Returns whether a schema is optional or carries a default value.
 */
export function isFieldOptional(schema: unknown): boolean {
    const unwrapped = unwrapSchema(schema);
    if (!unwrapped) return false;
    return unwrapped.isOptional;
}

/**
 * Returns whether a contract input schema has no required parameters (void, empty object, or all optional fields).
 */
export function isInputEmptyOrAllOptional(schema: unknown): boolean {
    if (!(schema instanceof z.ZodType)) return true;
    if (schema instanceof z.ZodVoid || schema instanceof z.ZodUndefined) return true;
    const unwrapped = unwrapSchema(schema);
    if (!unwrapped) return true;
    if (unwrapped.isOptional) return true;
    if (unwrapped.inner instanceof z.ZodObject) {
        const entries = Object.entries(unwrapped.inner.shape);
        if (entries.length === 0) return true;
        return entries.every(([, field]) => isFieldOptional(field));
    }
    return false;
}

/**
 * Returns the object shape map if the schema describes an object, peeling any wrappers.
 */
export function getObjectShape(schema: unknown): Record<string, z.ZodTypeAny> | undefined {
    const unwrapped = unwrapSchema(schema);
    if (unwrapped && unwrapped.inner instanceof z.ZodObject) {
        return unwrapped.inner.shape;
    }
    return undefined;
}

/**
 * Extracts string options from ZodEnum, ZodNativeEnum, or ZodUnion of ZodLiterals.
 */
export function getEnumOptions(schema: unknown): string[] | undefined {
    const unwrapped = unwrapSchema(schema);
    if (!unwrapped) return undefined;
    const inner = unwrapped.inner;

    if (inner instanceof z.ZodEnum) {
        return [...inner.options];
    }

    if (inner instanceof z.ZodNativeEnum) {
        const values = Object.values(inner.enum);
        const filtered: string[] = [];
        for (const v of values) {
            if (typeof v === 'number') {
                filtered.push(String(v));
            } else if (typeof v === 'string') {
                // In TypeScript numeric enums, reverse mappings exist where key is numeric string
                if (!inner.enum[v] || typeof inner.enum[v] !== 'number') {
                    filtered.push(v);
                }
            }
        }
        return filtered;
    }

    if (inner instanceof z.ZodUnion) {
        const literalOptions: string[] = [];
        for (const opt of inner.options) {
            const optUnwrapped = unwrapSchema(opt);
            if (optUnwrapped && optUnwrapped.inner instanceof z.ZodLiteral) {
                const val = optUnwrapped.inner.value;
                if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
                    literalOptions.push(String(val));
                } else {
                    return undefined;
                }
            } else {
                return undefined;
            }
        }
        return literalOptions;
    }

    return undefined;
}

/**
 * Returns a human-readable Zod type name for error and warning messages.
 */
export function getZodTypeName(schema: unknown): string {
    if (schema instanceof z.ZodType) {
        return schema.constructor?.name || 'ZodType';
    }
    return 'Unknown';
}

/**
 * Classifies a schema into supported form input categories or marks it unsupported.
 */
export function classifyFormField(schema: unknown): FormFieldClassification {
    const unwrapped = unwrapSchema(schema);
    if (!unwrapped) {
        const dummy = z.unknown();
        return {
            kind: 'unsupported',
            typeName: 'Unknown',
            unwrapped: { raw: dummy, inner: dummy, isOptional: false, isNullable: false, hasDefault: false },
        };
    }

    const inner = unwrapped.inner;

    if (inner instanceof z.ZodString) {
        return { kind: 'string', schema: inner, unwrapped };
    }
    if (inner instanceof z.ZodNumber) {
        return { kind: 'number', schema: inner, unwrapped };
    }
    if (inner instanceof z.ZodBoolean) {
        return { kind: 'boolean', schema: inner, unwrapped };
    }
    const enumOpts = getEnumOptions(inner);
    if (enumOpts !== undefined) {
        return { kind: 'enum', options: enumOpts, unwrapped };
    }
    if (inner instanceof z.ZodDate) {
        return { kind: 'date', schema: inner, unwrapped };
    }
    if (inner instanceof z.ZodArray) {
        return { kind: 'array', element: inner.element, unwrapped };
    }
    if (inner instanceof z.ZodObject) {
        return { kind: 'object', shape: inner.shape, unwrapped };
    }

    const typeName = inner.constructor?.name || 'ZodType';
    return { kind: 'unsupported', typeName, unwrapped };
}
