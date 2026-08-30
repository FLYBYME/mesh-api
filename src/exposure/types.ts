import type { ToolContract, z } from '@flybyme/mesh';
import type { AuthorizeHook } from '../auth/types.js';

/**
 * AuthLevel: the coarse gate applied at the public boundary.
 *
 * This is deliberately a closed set of three. It answers "is this contract reachable at all, and
 * by whom" -- nothing sharper. Per-record authorization ("does this user own this card") belongs
 * inside the handler where the data is, because only the handler can know. See spec/02.
 */
export type AuthLevel = 'public' | 'user' | 'admin';

/**
 * AuthExposeEntry: one contract made reachable from outside the mesh with a coarse auth gate.
 *
 * `auth` has no default. Making the author type `'public'` deliberately is the point -- an
 * omitted gate must never quietly mean "open".
 */
export interface AuthExposeEntry {
    readonly contract: ToolContract<z.ZodTypeAny, z.ZodTypeAny>;
    readonly auth: AuthLevel;
    readonly permission?: never;
}

/**
 * PermissionExposeEntry: one contract made reachable from outside the mesh with a fine-grained permission requirement.
 *
 * The permission key (e.g. 'dns.write') is evaluated by the application-supplied `authorize` hook
 * within the caller's target scope (e.g. organization).
 */
export interface PermissionExposeEntry {
    readonly contract: ToolContract<z.ZodTypeAny, z.ZodTypeAny>;
    readonly permission: string;
    readonly auth?: never;
}

/**
 * ExposeEntry: one contract made reachable from outside the mesh.
 *
 * Must declare either coarse `auth` ('public' | 'user' | 'admin') or a fine-grained `permission`
 * (e.g. 'dns.write'). An entry with neither is a compile-time and runtime error: an unguarded
 * contract must remain unrepresentable.
 */
export type ExposeEntry = AuthExposeEntry | PermissionExposeEntry;

/**
 * EventExposeEntry: one mesh event bridged to browsers over SSE.
 *
 * An event stream is a read API, so it is exposed exactly as explicitly as a contract is.
 * `scope` decides who receives a given event and is enforced server-side at fan-out.
 */
export interface EventExposeEntry {
    readonly event: string;
    readonly auth: AuthLevel;
    readonly scope?: 'global' | 'tenant';
}

/**
 * WebConfig: what a service declares when it turns on the web feature.
 */
export interface WebConfig {
    readonly expose: readonly ExposeEntry[];
    readonly events?: readonly EventExposeEntry[];
    /** Manifest path for the UI runtime. Unused until the runtime phases land. */
    readonly manifest?: string;
    /**
     * Application-supplied authorization hook that resolves permissions within scopes.
     */
    readonly authorize?: AuthorizeHook;
}
