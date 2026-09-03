/**
 * What a site exposes, and to whom.
 *
 * mesh-web spec/service-modules.md §2 and spec/hosting.md §5. This is the one piece of the previous
 * mesh-api that survives the rewrite unchanged in spirit, because it was already right:
 *
 *   > "`auth` has no default. Making the author type `'public'` deliberately is the point — an
 *   > omitted gate must never quietly mean 'open'."
 *
 * The union below is what enforces it. An entry with neither `auth` nor `permission` does not
 * satisfy either member, so it does not compile — an unguarded contract stays unrepresentable rather
 * than being caught by a review that might not happen.
 */

import type { ToolContract, z } from '@flybyme/mesh';

/**
 * The coarse gate: is this reachable at all, and by whom.
 *
 * Deliberately three values and no more. Per-record authorization — "does this user own this
 * credential" — belongs inside the handler, because only the handler has the record. A gate that
 * tried to express it would be a second, weaker copy of the same logic.
 */
export type AuthLevel = 'public' | 'user' | 'admin';

/**
 * Failures this call names, beyond the transport ones every call has.
 *
 * Carried into the descriptor and emitted into the generated client as a literal union, so a caller
 * switching on `error.name` is checked (mesh-web spec/type-safety.md §5, roadmap A3.1c). Declared
 * here rather than derived from the handler because a failure is part of a contract's public
 * surface: which errors a caller must handle should not change silently when a handler is edited.
 */
export type DeclaredErrors = readonly string[];

/** One contract reachable from outside the mesh, behind a coarse gate. */
export interface AuthExposeEntry {
    readonly contract: ToolContract<z.ZodTypeAny, z.ZodTypeAny>;
    readonly auth: AuthLevel;
    readonly permission?: never;
    readonly errors?: DeclaredErrors;
}

/**
 * One contract reachable from outside the mesh, behind a named permission.
 *
 * The permission key — `dns.write`, `identity.invite` — is evaluated by the site's `authorize` hook
 * in the caller's scope, because what an organization means is the site's business and not the
 * API's.
 */
export interface PermissionExposeEntry {
    readonly contract: ToolContract<z.ZodTypeAny, z.ZodTypeAny>;
    readonly permission: string;
    readonly auth?: never;
    readonly errors?: DeclaredErrors;
}

export type ExposeEntry = AuthExposeEntry | PermissionExposeEntry;

/** The gate an entry declares, in the one shape everything downstream reads. */
export type Gate =
    | { readonly kind: 'auth'; readonly level: AuthLevel }
    | { readonly kind: 'permission'; readonly permission: string };

/**
 * Read an entry's gate.
 *
 * Throws rather than defaulting. The types make an ungated entry unrepresentable in TypeScript, and
 * this is the second line of defence for a descriptor loaded from JSON or a package built elsewhere
 * — the same two-layer approach the kernel takes with capabilities.
 */
export function gateOf(entry: ExposeEntry): Gate {
    if (entry.auth !== undefined && entry.permission !== undefined) {
        throw new Error(
            `${keyOf(entry)} declares both auth and permission. ` +
            `One gate per entry: two would mean the narrower one is decorative.`,
        );
    }

    if (entry.auth !== undefined) return { kind: 'auth', level: entry.auth };
    if (entry.permission !== undefined) return { kind: 'permission', permission: entry.permission };

    throw new Error(
        `${keyOf(entry)} is exposed with no gate. ` +
        `Declare auth ('public' | 'user' | 'admin') or a permission — an omitted gate must never ` +
        `mean open.`,
    );
}

export const keyOf = (entry: ExposeEntry): string =>
    `${entry.contract.domain}.${entry.contract.action}`;
