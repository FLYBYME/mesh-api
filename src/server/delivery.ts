/**
 * May this subscriber see this event?
 *
 * A pure function, deliberately separated from everything about SSE, WebSockets, buffers and
 * connections. This is the decision that leaked in `archive/pre-rewrite`
 * (mesh-web spec/network.md §5.1), and a decision that has leaked once should be the kind of thing
 * that can be exhaustively tested without opening a socket.
 *
 * The rule, in one line: **an event that cannot be scoped is delivered to nobody.**
 */

import { readScope, type DescribedEvent } from '../exposure/events.js';

export interface Subscriber {
    readonly userId: string;
    /** The scope the gate resolved from this subscriber's memberships. Never from a query param. */
    readonly scope: string | undefined;
    /**
     * A platform operator, who sees across organizations.
     *
     * Narrow and explicit. It is not "admin" by accident: it is granted by the coarse gate having
     * admitted them to an `auth: 'admin'` stream, which is itself a decision in the exposure list.
     */
    readonly operator: boolean;
}

export type Delivery =
    | { readonly deliver: true }
    | { readonly deliver: false; readonly reason: 'out-of-scope' | 'unscopable' | 'no-subscriber-scope' };

export function decideDelivery(
    event: DescribedEvent,
    payload: unknown,
    subscriber: Subscriber,
): Delivery {
    // Someone typed 'global'. That is the only way an event reaches everyone.
    if (event.scope === 'global') return { deliver: true };

    const eventScope = readScope(payload, event.scope);

    if (eventScope === undefined) {
        // The declared field is absent or not a string: the contract and the payload disagree. The
        // old code read this as "unscoped, send to everybody", which is how an organization's data
        // reached every connected browser. The safe reading of a disagreement is nobody.
        return { deliver: false, reason: 'unscopable' };
    }

    // An operator sees across organizations, but only for an event that *had* a scope — the check
    // above still applies to them, so a broken payload is not a broken payload only for other people.
    if (subscriber.operator) return { deliver: true };

    if (subscriber.scope === undefined) {
        // Authenticated, but acting in no organization. A scoped event belongs to one, so there is
        // nothing here that is theirs.
        return { deliver: false, reason: 'no-subscriber-scope' };
    }

    return eventScope === subscriber.scope
        ? { deliver: true }
        : { deliver: false, reason: 'out-of-scope' };
}
