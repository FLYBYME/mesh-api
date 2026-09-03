/**
 * What a site exposes as an event stream, and to whom.
 *
 * mesh-web spec/network.md §5.1, decided: **scoping an event is a different problem from scoping a
 * call**, and the previous implementation solved it in a way that failed open.
 *
 * A call is confined by a query filter — mesh's `beforeCrud` narrows the query using
 * `meta.user.tenant_id` before the database sees it, and one request has one caller and one scope.
 * An event has neither. It is emitted once to the whole mesh by whatever caused it, and arrives at
 * an instance holding connections for many users in many organizations. There is no query to filter,
 * and the payload of a CRUD event is `{ domain, id, item }` — nothing in it is *declared* to be a
 * scope.
 *
 * `archive/pre-rewrite` guessed: it searched the payload, one level of nesting, and packet meta for
 * any of `orgId`, `tenantId`, `tenant_id`, `organizationId` or `scope`, and then delivered the event
 * to **everyone** when the guess came back empty. An event declared `scope: 'org'` whose payload
 * named its organization field anything else went to every connected browser in every organization.
 *
 * So here the scope is **declared**, and an event whose declared scope cannot be read is delivered to
 * nobody.
 */

import type { EventDefinition, z } from '@flybyme/mesh';

import type { AuthLevel, Gate } from './types.js';

/**
 * Where an event's scope lives, or a statement that it has none.
 *
 * `'global'` is a decision someone typed, not a default reached by failing to find anything. There
 * is deliberately no third option meaning "work it out" — that is the mistake this replaces.
 */
export type EventScope =
    | 'global'
    | { readonly field: string };

interface EventExposeBase {
    /** The event, as a contract or a name. A contract also carries the payload schema. */
    readonly event: EventDefinition<z.ZodTypeAny> | string;
    /**
     * How to find the organization this event belongs to.
     *
     * Required, with no default. An event stream where nobody stated the scope is the exact
     * condition that caused the leak, so it is not expressible.
     */
    readonly scope: EventScope;
}

export interface AuthEventExposeEntry extends EventExposeBase {
    readonly auth: AuthLevel;
    readonly permission?: never;
}

export interface PermissionEventExposeEntry extends EventExposeBase {
    readonly permission: string;
    readonly auth?: never;
}

export type EventExposeEntry = AuthEventExposeEntry | PermissionEventExposeEntry;

export interface DescribedEvent {
    readonly name: string;
    readonly gate: Gate;
    readonly scope: EventScope;
}

/** The event's name, whether it was given as a contract or a string. */
export const eventNameOf = (entry: EventExposeEntry): string =>
    typeof entry.event === 'string' ? entry.event : entry.event.name;

/**
 * Validate one exposed event.
 *
 * Runs at mount time. Every failure here is a misconfiguration that would otherwise become a
 * disclosure at run time, so all of them stop the process from starting.
 */
export function describeEvent(entry: EventExposeEntry): DescribedEvent {
    const name = eventNameOf(entry);

    if (name.trim() === '') {
        throw new Error('An exposed event has no name.');
    }

    if (entry.auth !== undefined && entry.permission !== undefined) {
        throw new Error(`Event ${name} declares both auth and permission. One gate per entry.`);
    }

    const gate: Gate | undefined =
        entry.auth !== undefined ? { kind: 'auth', level: entry.auth }
            : entry.permission !== undefined ? { kind: 'permission', permission: entry.permission }
                : undefined;

    if (gate === undefined) {
        throw new Error(
            `Event ${name} is exposed with no gate. Declare auth or a permission — an omitted gate ` +
            `must never mean open, and an event stream is a firehose rather than a single record.`,
        );
    }

    if (entry.scope !== 'global' && entry.scope.field.trim() === '') {
        throw new Error(`Event ${name} declares an empty scope field.`);
    }

    return { name, gate, scope: entry.scope };
}

/**
 * Read the scope out of an event payload.
 *
 * Returns `undefined` when the declared field is absent or is not a string — and **every caller must
 * treat that as "deliver to nobody"**. That is the inversion of the old behaviour and the reason
 * this function exists separately from the delivery decision: it reports what it found, and the
 * caller is not given the option of reading silence as permission.
 *
 * The field may be a dotted path, because a CRUD event nests the record under `item`.
 */
export function readScope(payload: unknown, scope: EventScope): string | undefined {
    if (scope === 'global') return undefined;

    let current: unknown = payload;
    for (const segment of scope.field.split('.')) {
        if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
        current = (current as Record<string, unknown>)[segment];
    }

    return typeof current === 'string' && current.trim() !== '' ? current.trim() : undefined;
}
