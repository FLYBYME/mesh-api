/**
 * May this subscriber see this event?
 *
 * mesh-web spec/network.md §5.1. `archive/pre-rewrite` answered this by guessing at the payload's
 * field names and delivering to **everyone** when the guess came back empty, so an event declared
 * `scope: 'org'` whose payload named its organization anything unexpected reached every connected
 * browser in every organization.
 *
 * The first describe block is that leak, written as the thing that must not happen again. The rest
 * is the rule it was replaced with: an event that cannot be scoped is delivered to nobody.
 */

import { describe, expect, it } from 'vitest';

import { decideDelivery, describeEvent, readScope, type EventExposeEntry, type Subscriber } from '../src/index.js';

const scoped = describeEvent({
    event: 'credential.created',
    permission: 'credential.read',
    scope: { field: 'organizationId' },
});

const nested = describeEvent({
    event: 'data.created',
    permission: 'credential.read',
    // A CRUD event nests the record under `item`, so the declared path does too.
    scope: { field: 'item.organizationId' },
});

const global = describeEvent({ event: 'mesh.started', auth: 'public', scope: 'global' });

const alice: Subscriber = { userId: 'u-alice', scope: 'org-a', operator: false };
const bob: Subscriber = { userId: 'u-bob', scope: 'org-b', operator: false };
const operator: Subscriber = { userId: 'u-ops', scope: undefined, operator: true };

describe('the leak that must not come back', () => {
    it('does not deliver an event whose declared scope field is missing', () => {
        // The exact shape that leaked: an event declared as org-scoped, with a payload that names
        // its organization something the old guesser did not recognise.
        const payload = { id: 'c1', org: 'org-a', name: 'prod' };

        expect(decideDelivery(scoped, payload, alice)).toEqual({ deliver: false, reason: 'unscopable' });
        expect(decideDelivery(scoped, payload, bob)).toEqual({ deliver: false, reason: 'unscopable' });

        // Not even to the subscriber it actually belongs to. That is the point: the system cannot
        // tell, and "cannot tell" resolves to nobody rather than to everybody.
    });

    it('does not deliver when the scope field holds something that is not a string', () => {
        for (const value of [null, undefined, 42, {}, [], '', '   ']) {
            expect(decideDelivery(scoped, { organizationId: value }, alice).deliver).toBe(false);
        }
    });

    it('does not deliver an unscopable event to an operator either', () => {
        // An operator seeing across organizations is a decision about *which* organizations, not a
        // licence to receive events nobody can place. A broken payload must not be broken only for
        // other people.
        expect(decideDelivery(scoped, { org: 'org-a' }, operator))
            .toEqual({ deliver: false, reason: 'unscopable' });
    });
});

describe('a scoped event goes to its organization', () => {
    it('delivers to a subscriber in the same organization', () => {
        expect(decideDelivery(scoped, { organizationId: 'org-a' }, alice)).toEqual({ deliver: true });
    });

    it('withholds from a subscriber in another organization', () => {
        expect(decideDelivery(scoped, { organizationId: 'org-a' }, bob))
            .toEqual({ deliver: false, reason: 'out-of-scope' });
    });

    it('withholds from an authenticated subscriber acting in no organization', () => {
        const scopeless: Subscriber = { userId: 'u-c', scope: undefined, operator: false };
        expect(decideDelivery(scoped, { organizationId: 'org-a' }, scopeless))
            .toEqual({ deliver: false, reason: 'no-subscriber-scope' });
    });

    it('delivers a well-scoped event to an operator regardless of organization', () => {
        expect(decideDelivery(scoped, { organizationId: 'org-a' }, operator)).toEqual({ deliver: true });
    });

    it('reads a dotted path, for a CRUD payload that nests the record', () => {
        expect(decideDelivery(nested, { domain: 'credential', id: 'c1', item: { organizationId: 'org-a' } }, alice))
            .toEqual({ deliver: true });

        expect(decideDelivery(nested, { domain: 'credential', id: 'c1', item: { organizationId: 'org-b' } }, alice))
            .toEqual({ deliver: false, reason: 'out-of-scope' });

        // The record is there but the field is not: still nobody.
        expect(decideDelivery(nested, { domain: 'credential', id: 'c1', item: { name: 'prod' } }, alice))
            .toEqual({ deliver: false, reason: 'unscopable' });
    });
});

describe("'global' is something someone typed", () => {
    it('delivers to everyone, including a subscriber with no scope', () => {
        expect(decideDelivery(global, { nodeID: 'n1' }, alice)).toEqual({ deliver: true });
        expect(decideDelivery(global, { nodeID: 'n1' }, { userId: 'x', scope: undefined, operator: false }))
            .toEqual({ deliver: true });
    });

    it('is the only route to everyone — there is no inferred global', () => {
        // An entry must declare `scope`; the type has no member without it, so "unscoped" is not a
        // state the system can be in by omission.
        // @ts-expect-error an exposed event must declare a scope
        const _unscoped: EventExposeEntry = { event: 'x.y', auth: 'public' };

        // And it must be 'global' or a field — there is no third value meaning "work it out".
        // @ts-expect-error 'auto' is not an EventScope
        const _auto: EventExposeEntry = { event: 'x.y', auth: 'public', scope: 'auto' };
    });
});

describe('reading a scope', () => {
    it('returns undefined rather than throwing on a hostile payload', () => {
        expect(readScope(null, { field: 'a.b' })).toBeUndefined();
        expect(readScope('a string', { field: 'a' })).toBeUndefined();
        expect(readScope([1, 2], { field: 'a' })).toBeUndefined();
        expect(readScope({ a: [1] }, { field: 'a.b' })).toBeUndefined();
    });

    it('is undefined for a global event, because there is nothing to read', () => {
        expect(readScope({ organizationId: 'org-a' }, 'global')).toBeUndefined();
    });
});

describe('what an exposed event must declare', () => {
    it('refuses an event with no gate', () => {
        const ungated = { event: 'x.y', scope: 'global' } as never;
        expect(() => describeEvent(ungated)).toThrow(/no gate/);
    });

    it('refuses an event with two gates', () => {
        const both = { event: 'x.y', auth: 'public', permission: 'p', scope: 'global' } as never;
        expect(() => describeEvent(both)).toThrow(/both auth and permission/);
    });

    it('refuses an empty scope field', () => {
        expect(() => describeEvent({ event: 'x.y', auth: 'user', scope: { field: '  ' } }))
            .toThrow(/empty scope field/);
    });

    it('takes the name from an event contract', () => {
        expect(describeEvent({
            event: { name: 'identity.ticket_revoked', schema: undefined as never },
            auth: 'user',
            scope: 'global',
        }).name).toBe('identity.ticket_revoked');
    });
});
