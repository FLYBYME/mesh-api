/**
 * The revocation poller — mesh-web roadmap C1.9a, auth §3.1.
 *
 * This is the piece that makes revocation *correct* rather than likely, so the tests are about the
 * cases the event cannot cover: an instance that was not listening, one that has fallen too far
 * behind to catch up, and one that cannot reach identity at all.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    createTicketCache, revocationPoller,
    type Caller, type RevocationBroker, type RevocationsSince, type TicketCache,
} from '../src/index.js';

const alice: Caller = { userId: 'u-alice', roles: [] };
const bob: Caller = { userId: 'u-bob', roles: [] };

const known: Record<string, Caller> = { 'alice-1': alice, 'alice-2': alice, 'bob-1': bob };

/**
 * A cache with three live tickets, and an identity that honours revocations.
 *
 * The `revoked` set matters: dropping a cache entry only removes the *memory* of a validation, and
 * `resolve` will happily ask again. Whether the answer is then no depends on identity, and a fake
 * that kept saying yes would make this file assert that the cache forgets rather than that the
 * ticket stops working.
 */
const warmCache = async (): Promise<{ cache: TicketCache; revoked: Set<string> }> => {
    const revoked = new Set<string>();

    const cache = createTicketCache({
        validate: async (ticket) => {
            const caller = known[ticket];
            if (caller === undefined || revoked.has(ticket) || revoked.has(caller.userId)) {
                return { valid: false };
            }
            return { valid: true, caller };
        },
    });

    for (const ticket of Object.keys(known)) await cache.resolve(ticket);
    return { cache, revoked };
};

const brokerAnswering = (...answers: RevocationsSince[]): RevocationBroker & { asked: unknown[] } => {
    const asked: unknown[] = [];
    let next = 0;
    return {
        asked,
        async call(_tool, params) {
            asked.push(params);
            return answers[Math.min(next++, answers.length - 1)] ?? { epoch: 0, revocations: [], truncated: false };
        },
    };
};

describe('an instance that missed the event still finds out', () => {
    it('applies a revocation it was never told about', async () => {
        const { cache } = await warmCache();
        expect(cache.size).toBe(3);

        // Nothing was emitted to this instance — it was down. The poll is the only way it learns.
        const broker = brokerAnswering({
            epoch: 7,
            revocations: [{ epoch: 7, kind: 'ticket', subject: 'alice-1', at: 0 }],
            truncated: false,
        });

        const poller = revocationPoller({ broker, cache });
        await poller.poll();

        expect(cache.size).toBe(2);
        expect(poller.epoch).toBe(7);
    });

    it('drops every ticket a principal holds, from one row', async () => {
        const { cache, revoked } = await warmCache();
        revoked.add('u-alice');

        // identity records a revocation by user as *one* row rather than one per ticket. This is
        // the consumer side: both of alice's tickets go, and bob's stays.
        const broker = brokerAnswering({
            epoch: 3,
            revocations: [{ epoch: 3, kind: 'principal', subject: 'u-alice', at: 0 }],
            truncated: false,
        });

        await revocationPoller({ broker, cache }).poll();

        expect(await cache.resolve('alice-1')).toBeUndefined();
        expect(await cache.resolve('alice-2')).toBeUndefined();
        expect((await cache.resolve('bob-1'))?.userId).toBe('u-bob');
    });

    it('asks only for what it has not seen', async () => {
        const { cache } = await warmCache();
        const broker = brokerAnswering(
            { epoch: 5, revocations: [], truncated: false },
            { epoch: 9, revocations: [], truncated: false },
        );

        const poller = revocationPoller({ broker, cache });
        await poller.poll();
        await poller.poll();

        // The cursor advances, so a poller does not re-process its own history on every poll.
        expect(broker.asked).toEqual([{ epoch: 0 }, { epoch: 5 }]);
        expect(poller.epoch).toBe(9);
    });

    it('starts from the epoch a validation already reported, not from zero', async () => {
        const { cache } = await warmCache();
        const broker = brokerAnswering({ epoch: 42, revocations: [], truncated: false });

        // A fresh instance holds nothing to invalidate, so replaying history would be work with no
        // effect. `ticket_validate` returns the epoch with every answer, so the cursor is free.
        await revocationPoller({ broker, cache, startEpoch: 41 }).poll();

        expect(broker.asked).toEqual([{ epoch: 41 }]);
    });
});

describe('when it cannot catch up', () => {
    it('drops everything rather than believing it is current', async () => {
        const { cache } = await warmCache();
        const broker = brokerAnswering({ epoch: 900, revocations: [], truncated: true });

        // Further behind than identity retains. It cannot be told what it missed, so nothing it
        // holds can be vouched for — this is the one case §3's "re-validate everything on
        // reconnect" is actually right for, now confined to it.
        const poller = revocationPoller({ broker, cache });
        await poller.poll();

        expect(cache.size).toBe(0);
        expect(poller.epoch).toBe(900);
    });
});

describe('when identity is unreachable', () => {
    it('keeps the cursor, so the next successful poll covers the gap', async () => {
        const { cache, revoked } = await warmCache();
        revoked.add('bob-1');
        const onError = vi.fn();

        let fail = true;
        const broker: RevocationBroker = {
            async call(_tool, params) {
                if (fail) throw new Error('identity unreachable');
                return { epoch: 12, revocations: [{ epoch: 12, kind: 'ticket', subject: 'bob-1', at: 0 }], truncated: false };
            },
        };

        const poller = revocationPoller({ broker, cache, onError });
        await poller.poll();

        expect(onError).toHaveBeenCalled();
        expect(poller.epoch).toBe(0);      // not advanced past something it never read
        expect(cache.size).toBe(3);        // and nothing dropped on a guess

        fail = false;
        await poller.poll();

        // The gap is covered by the next success. That is the whole reason this is a pull: a missed
        // poll is a delay, where a missed event is a loss.
        expect(await cache.resolve('bob-1')).toBeUndefined();
    });

    it('does not advance past an answer it does not understand', async () => {
        const { cache } = await warmCache();
        const onError = vi.fn();
        const broker: RevocationBroker = { async call() { return { unexpected: true }; } };

        const poller = revocationPoller({ broker, cache, onError });
        await poller.poll();

        // A version skew must not silently skip revocations. The cursor stays, so the next poll
        // asks the same question.
        expect(poller.epoch).toBe(0);
        expect(onError).toHaveBeenCalled();
        expect(cache.size).toBe(3);
    });

    it('runs one poll at a time', async () => {
        const { cache } = await warmCache();
        let release: (v: RevocationsSince) => void = () => {};
        let calls = 0;

        const broker: RevocationBroker = {
            call: () => {
                calls += 1;
                return new Promise<RevocationsSince>((resolve) => { release = resolve; }) as Promise<unknown>;
            },
        };

        const poller = revocationPoller({ broker, cache });
        const both = Promise.all([poller.poll(), poller.poll()]);
        release({ epoch: 1, revocations: [], truncated: false });
        await both;

        // A slow identity would otherwise stack polls, each asking from the same cursor and applying
        // the same revocations.
        expect(calls).toBe(1);
    });
});

describe('the cache’s own revocation surface', () => {
    it('leaves negative entries alone when a principal is revoked', async () => {
        const cache = createTicketCache({
            validate: async (ticket) => (ticket === 'good' ? { valid: true, caller: alice } : { valid: false }),
        });

        await cache.resolve('good');
        await cache.resolve('forged');
        expect(cache.size).toBe(2);

        // The negative entry belongs to nobody. Dropping it would make an attacker's invalid ticket
        // cost a mesh call again, which is the denial of service the negative cache exists to stop.
        expect(cache.revokePrincipal('u-alice')).toBe(1);
        expect(cache.size).toBe(1);
    });
});
