/**
 * The ticket cache.
 *
 * mesh-web spec/auth.md §3. The cache is correctness-critical — a stale entry serves a revoked
 * ticket — so the four failure modes the spec names each have a test here rather than a comment.
 */

import { describe, expect, it, vi } from 'vitest';

import { createTicketCache, type Caller, type TicketValidation } from '../src/index.js';

const caller: Caller = { userId: 'u1', roles: [] };

/** A clock the test moves by hand, so nothing here waits on real time. */
function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const valid = (over: Partial<TicketValidation> = {}): TicketValidation =>
    ({ valid: true, caller, ...over });

describe('one mesh call per ticket, not per request', () => {
    it('validates on first sight and caches the answer', async () => {
        const validate = vi.fn(async () => valid());
        const cache = createTicketCache({ validate });

        expect(await cache.resolve('t1')).toEqual(caller);
        expect(await cache.resolve('t1')).toEqual(caller);
        expect(await cache.resolve('t1')).toEqual(caller);

        expect(validate).toHaveBeenCalledTimes(1);
    });

    it('collapses a burst of concurrent requests into one call', async () => {
        // The case the cache is least helpful in and most needed for: a cold instance taking a burst
        // of requests carrying the same fresh ticket. Without single-flight this is one mesh call
        // per request, at the busiest moment.
        let release: (v: TicketValidation) => void = () => {};
        const validate = vi.fn(() => new Promise<TicketValidation>((resolve) => { release = resolve; }));
        const cache = createTicketCache({ validate });

        const all = Promise.all([cache.resolve('t1'), cache.resolve('t1'), cache.resolve('t1')]);
        release(valid());

        expect(await all).toEqual([caller, caller, caller]);
        expect(validate).toHaveBeenCalledTimes(1);
    });

    it('treats a missing or empty ticket as anonymous without calling identity', async () => {
        const validate = vi.fn(async () => valid());
        const cache = createTicketCache({ validate });

        expect(await cache.resolve(undefined)).toBeUndefined();
        expect(await cache.resolve('')).toBeUndefined();
        expect(validate).not.toHaveBeenCalled();
    });
});

describe('revocation is the mechanism', () => {
    it('drops a ticket when the event says so', async () => {
        const validate = vi.fn(async () => valid());
        const cache = createTicketCache({ validate });

        await cache.resolve('t1');
        cache.revoke('t1');

        // Revalidated rather than served from cache — and identity is now free to reject it.
        validate.mockResolvedValueOnce({ valid: false });
        expect(await cache.resolve('t1')).toBeUndefined();
        expect(validate).toHaveBeenCalledTimes(2);
    });

    it('drops everything after a reconnect, because it cannot vouch for any of it', async () => {
        const validate = vi.fn(async () => valid());
        const cache = createTicketCache({ validate });

        await cache.resolve('t1');
        await cache.resolve('t2');
        expect(cache.size).toBe(2);

        // An instance that missed an unknown number of revocations knows nothing about what it
        // holds. Re-validating is the cost of having been disconnected, paid once.
        cache.resubscribed();
        expect(cache.size).toBe(0);
    });
});

describe('the TTL is the backstop, not the mechanism', () => {
    it('revalidates after the TTL, so a missed event is bounded', async () => {
        const time = clock();
        const validate = vi.fn(async () => valid());
        const cache = createTicketCache({ validate, ttlMs: 60_000, now: time.now });

        await cache.resolve('t1');
        time.advance(59_000);
        await cache.resolve('t1');
        expect(validate).toHaveBeenCalledTimes(1);

        time.advance(2_000);
        await cache.resolve('t1');
        expect(validate).toHaveBeenCalledTimes(2);
    });

    it('will not outlive the ticket, whatever the TTL says', async () => {
        const time = clock();
        const validate = vi.fn(async () => valid({ expiresAt: time.now() + 5_000 }));
        const cache = createTicketCache({ validate, ttlMs: 600_000, now: time.now });

        await cache.resolve('t1');
        time.advance(6_000);

        // The TTL would have kept this for another ten minutes. The ticket's own expiry wins.
        validate.mockResolvedValueOnce({ valid: false });
        expect(await cache.resolve('t1')).toBeUndefined();
        expect(validate).toHaveBeenCalledTimes(2);
    });
});

describe('the failure modes that are not about revocation', () => {
    it('caches a rejection, so a bad ticket in a loop is not a mesh call per request', async () => {
        const validate = vi.fn(async () => ({ valid: false }));
        const cache = createTicketCache({ validate });

        for (let i = 0; i < 50; i++) expect(await cache.resolve('bad')).toBeUndefined();

        // Otherwise this loop is a denial of service against identity, written by the attacker.
        expect(validate).toHaveBeenCalledTimes(1);
    });

    it('forgets a rejection sooner than it forgets a grant', async () => {
        const time = clock();
        const validate = vi.fn(async () => ({ valid: false }));
        const cache = createTicketCache({ validate, ttlMs: 120_000, negativeTtlMs: 5_000, now: time.now });

        await cache.resolve('bad');
        time.advance(6_000);
        await cache.resolve('bad');

        expect(validate).toHaveBeenCalledTimes(2);
    });

    it('does not cache an outage', async () => {
        const validate = vi.fn(async () => { throw new Error('identity unreachable'); });
        const cache = createTicketCache({ validate });

        // Unreachable identity reads as "not authenticated" — but caching it would turn a blip into
        // minutes of failed sign-ins, and the negative entry would be a lie about the ticket rather
        // than about the cluster.
        expect(await cache.resolve('t1')).toBeUndefined();
        expect(await cache.resolve('t1')).toBeUndefined();
        expect(validate).toHaveBeenCalledTimes(2);
        expect(cache.size).toBe(0);
    });

    it('is bounded, so endless distinct tickets cannot exhaust memory', async () => {
        const cache = createTicketCache({ validate: async () => valid(), maxEntries: 10 });

        for (let i = 0; i < 100; i++) await cache.resolve(`t${i}`);

        expect(cache.size).toBeLessThanOrEqual(10);
        // And the cache still works after evicting.
        expect(await cache.resolve('t99')).toEqual(caller);
    });
});
