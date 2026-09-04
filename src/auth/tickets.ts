/**
 * The ticket cache.
 *
 * mesh-web spec/auth.md §3, decided: an API instance seeing a ticket it does not recognise asks
 * mesh-identity over the mesh — is this valid, and who is it. It caches the answer. Revocation is an
 * event, so every instance drops it at once.
 *
 *     first request at instance N   →  mesh call to identity  →  cache
 *     later requests at instance N  →  cache hit, no call
 *     revocation anywhere           →  event  →  every instance drops it
 *
 * One mesh call per (ticket, instance), not per request. Tickets are opaque random strings — nothing
 * verifies them by signature — so **there is no signing key**, and therefore no key to distribute to
 * ten instances and no rotation to get wrong. That is the largest thing this design deletes rather
 * than solves.
 *
 * ## The four failure modes, named rather than discovered
 *
 * spec/auth.md §3 lists what has to be got right, and each one is a decision in this file:
 *
 * - **A missed event serves a revoked ticket.** An instance that was down, partitioned, or
 *   resubscribed late never saw the revocation. So an entry has a **TTL as a backstop** — the event
 *   is the mechanism, the TTL bounds the damage when the mechanism fails.
 * - **A reconnect must not resume a cache it cannot vouch for.** `resubscribed()` drops everything,
 *   because an instance that missed an unknown number of events knows nothing about what it holds.
 * - **Negative results need caching too**, or an invalid ticket presented in a loop is one mesh call
 *   per request — a denial of service against identity, written by the attacker. Cached briefly,
 *   because a rejection that becomes valid is a sign-in and a sign-in is a new ticket.
 * - **An entry must not outlive its ticket**, independent of the TTL — so a validation that reports
 *   an expiry is capped by it.
 */

import type { Caller } from './gate.js';

export interface TicketValidation {
    readonly valid: boolean;
    readonly caller?: Caller;
    /** When the ticket itself expires, in epoch milliseconds. Caps the cache entry. */
    readonly expiresAt?: number;
}

/** How a ticket is checked when it is not in the cache. The mesh call, injected. */
export type Validator = (ticket: string) => Promise<TicketValidation>;

export interface TicketCacheOptions {
    readonly validate: Validator;
    /** The backstop, not the mechanism. Default two minutes. */
    readonly ttlMs?: number;
    /** How long a rejection is remembered. Short, and shorter than `ttlMs`. Default ten seconds. */
    readonly negativeTtlMs?: number;
    readonly now?: () => number;
    /** Bounds memory against an attacker presenting endless distinct tickets. Default 10,000. */
    readonly maxEntries?: number;
}

interface Entry {
    readonly valid: boolean;
    readonly caller?: Caller;
    readonly expiresAt: number;
}

export interface TicketCache {
    /** Who is calling. `undefined` means no valid ticket — the caller is anonymous, not refused. */
    resolve(ticket: string | undefined): Promise<Caller | undefined>;
    /** A revocation arrived. Called from the event subscription, and from the poller. */
    revoke(ticket: string): void;
    /**
     * Everything belonging to a principal.
     *
     * identity records a revocation *by user* as one row rather than one per ticket, because a
     * consumer that drops everything for that user is correct and cheaper — and because a ticket
     * issued a moment later is covered by the same row. This is the consumer side of that.
     */
    revokePrincipal(userId: string): number;
    /** Identity says everything is suspect, or this instance cannot trust what it holds. */
    clear(): void;
    /**
     * The subscription reconnected after a gap.
     *
     * Drops the whole cache rather than resuming. spec/auth.md §3: an instance that missed an
     * unknown number of revocations cannot vouch for a single entry it holds, and re-validating is
     * one mesh call per active ticket — which is the cost of having been disconnected, paid once.
     */
    resubscribed(): void;
    readonly size: number;
}

export const DEFAULT_TTL_MS = 120_000;
export const DEFAULT_NEGATIVE_TTL_MS = 10_000;

export function createTicketCache(options: TicketCacheOptions): TicketCache {
    const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
    const negativeTtl = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    const now = options.now ?? Date.now;
    const max = options.maxEntries ?? 10_000;

    const entries = new Map<string, Entry>();

    /**
     * One in-flight validation per ticket.
     *
     * Without this, a cold instance taking a burst of requests carrying the same fresh ticket makes
     * one mesh call per request — precisely the thing the cache exists to avoid, occurring at the
     * one moment the system is busiest.
     */
    const inFlight = new Map<string, Promise<Caller | undefined>>();

    const store = (ticket: string, validation: TicketValidation): void => {
        const lifetime = validation.valid ? ttl : negativeTtl;
        let expiresAt = now() + lifetime;

        // An entry must not outlive its ticket, whatever the TTL says.
        if (validation.expiresAt !== undefined) expiresAt = Math.min(expiresAt, validation.expiresAt);

        if (entries.size >= max && !entries.has(ticket)) {
            // Oldest insertion first — Map preserves it. Crude, and the right kind of crude: this
            // bound exists to stop unbounded growth, not to be a good cache eviction policy.
            const oldest = entries.keys().next();
            if (!oldest.done) entries.delete(oldest.value);
        }

        entries.set(ticket, validation.valid
            ? { valid: true, caller: validation.caller, expiresAt }
            : { valid: false, expiresAt });
    };

    return {
        async resolve(ticket: string | undefined): Promise<Caller | undefined> {
            if (ticket === undefined || ticket === '') return undefined;

            const hit = entries.get(ticket);
            if (hit !== undefined) {
                if (hit.expiresAt > now()) return hit.valid ? hit.caller : undefined;
                entries.delete(ticket);
            }

            const existing = inFlight.get(ticket);
            if (existing !== undefined) return existing;

            const pending = (async (): Promise<Caller | undefined> => {
                try {
                    const validation = await options.validate(ticket);
                    store(ticket, validation);
                    return validation.valid ? validation.caller : undefined;
                } catch {
                    // Identity is unreachable. Treated as "not authenticated" and **not cached** —
                    // caching an outage would turn a blip into minutes of failed sign-ins, and a
                    // negative entry here would be a lie about the ticket rather than about the
                    // cluster.
                    return undefined;
                } finally {
                    inFlight.delete(ticket);
                }
            })();

            inFlight.set(ticket, pending);
            return pending;
        },

        revoke(ticket: string): void {
            entries.delete(ticket);
        },

        revokePrincipal(userId: string): number {
            let dropped = 0;
            for (const [ticket, entry] of entries) {
                // Negative entries have no caller and belong to nobody, so they are left alone —
                // dropping them would make an attacker's invalid ticket cost a mesh call again.
                if (entry.caller?.userId !== userId) continue;
                entries.delete(ticket);
                dropped += 1;
            }
            return dropped;
        },

        clear(): void {
            entries.clear();
        },

        resubscribed(): void {
            entries.clear();
        },

        get size(): number {
            return entries.size;
        },
    };
}
