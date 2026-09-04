/**
 * The revocation poller — mesh-web roadmap C1.9a, and the consumer half of auth §3.1.
 *
 * ## Why this exists at all
 *
 * auth §3 assumed a revocation could ride on a mesh event. §3.1 recorded what `mesh` actually does:
 * `TCPTransport.publish` writes to peers connected *at that instant*, with no acknowledgement,
 * retry, queue or persistence. **At-most-once.** An API instance that was down, restarting or
 * partitioned when a ticket was revoked never hears about it — not late, never.
 *
 * So the event cannot be the mechanism. The mechanism is this:
 *
 *     pull for correctness, push for latency
 *
 * identity allocates a monotonic epoch per revocation. This asks `revocations_since(cursor)` on an
 * interval and on every reconnect, and applies what comes back. A poll cannot be missed, only
 * delayed — a guarantee the transport does not provide and does not have to.
 *
 * The event subscription stays, and is worth keeping: it makes the common case immediate. It is now
 * an optimisation rather than the thing correctness rests on, which is exactly the right job for a
 * best-effort broadcast.
 *
 * ## The interval is a correctness parameter
 *
 * Not tuning. It is the **worst-case window** in which a revoked ticket still works at an instance
 * that missed the event, so it is chosen deliberately and it belongs next to the cache TTL rather
 * than buried in a config default.
 */

import type { TicketCache } from './tickets.js';

/** What the poller needs from a broker. Narrow, so a test needs no mesh. */
export interface RevocationBroker {
    call(tool: string, params: unknown): Promise<unknown>;
}

export interface RevocationEntry {
    readonly epoch: number;
    readonly kind: 'ticket' | 'principal';
    readonly subject: string;
    readonly at: number;
}

export interface RevocationsSince {
    readonly epoch: number;
    readonly revocations: readonly RevocationEntry[];
    /**
     * The caller is further behind than identity still retains.
     *
     * It cannot be told what it missed, so it must not carry on as if current. The only honest
     * response is to drop the cache — which is §3's original "re-validate on reconnect", now
     * confined to the one case it is actually right for instead of every reconnect.
     */
    readonly truncated: boolean;
}

export interface PollerOptions {
    readonly broker: RevocationBroker;
    readonly cache: TicketCache;
    /** The contract identity answers on. */
    readonly tool?: string;
    /**
     * How often to ask.
     *
     * The worst-case window in which a revoked ticket still works here. Default thirty seconds:
     * short enough to bound the damage, long enough that a hundred instances are not a load problem
     * for identity. A deployment with a stricter requirement lowers it and pays for it.
     */
    readonly intervalMs?: number;
    /**
     * Where to start.
     *
     * A fresh instance holds no tickets, so it has nothing to invalidate and can start from
     * *identity's current epoch* rather than replaying history. `ticket_validate` returns the epoch
     * with every answer, so the cursor is set from the first validation for free.
     */
    readonly startEpoch?: number;
    readonly onError?: (error: unknown) => void;
    readonly onApplied?: (applied: number, epoch: number) => void;
}

export interface RevocationPoller {
    /** Ask now. Called on the interval, and worth calling on reconnect. */
    poll(): Promise<void>;
    start(): void;
    stop(): void;
    /** Where this instance has caught up to. */
    readonly epoch: number;
}

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_REVOCATIONS_TOOL = 'identity.revocations_since';

export function revocationPoller(options: PollerOptions): RevocationPoller {
    const tool = options.tool ?? DEFAULT_REVOCATIONS_TOOL;
    const interval = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const onError = options.onError ?? (() => {});

    let cursor = options.startEpoch ?? 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    let inFlight: Promise<void> | undefined;

    const apply = (result: RevocationsSince): number => {
        if (result.truncated) {
            // Cannot know what was missed. Everything held here is suspect, so none of it is kept.
            options.cache.clear();
            return -1;
        }

        let applied = 0;
        for (const revocation of result.revocations) {
            applied += revocation.kind === 'principal'
                ? options.cache.revokePrincipal(revocation.subject)
                : (options.cache.revoke(revocation.subject), 1);
        }
        return applied;
    };

    const poll = async (): Promise<void> => {
        // One in flight at a time. A slow identity would otherwise stack polls, and each would ask
        // from the same cursor and apply the same revocations.
        if (inFlight !== undefined) return inFlight;

        inFlight = (async () => {
            try {
                const result = await options.broker.call(tool, { epoch: cursor }) as RevocationsSince;

                if (typeof result?.epoch !== 'number' || !Array.isArray(result.revocations)) {
                    // identity answered in a shape this does not understand — a version skew. The
                    // cursor is *not* advanced, so nothing is silently skipped, and the next poll
                    // asks the same question.
                    onError(new Error(`${tool} answered in an unexpected shape`));
                    return;
                }

                const applied = apply(result);
                cursor = result.epoch;
                options.onApplied?.(applied, cursor);
            } catch (error) {
                // Identity is unreachable. The cursor stays where it is, so the next successful poll
                // covers the gap — which is the whole reason this is a pull.
                onError(error);
            } finally {
                inFlight = undefined;
            }
        })();

        return inFlight;
    };

    return {
        poll,

        start() {
            if (timer !== undefined) return;
            timer = setInterval(() => void poll(), interval);
            timer.unref?.();
            // Immediately as well as on the interval: an instance that has just started is exactly
            // the one most likely to have missed something.
            void poll();
        },

        stop() {
            if (timer !== undefined) clearInterval(timer);
            timer = undefined;
        },

        get epoch() { return cursor; },
    };
}
