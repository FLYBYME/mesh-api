/**
 * The `exposure` collection.
 *
 * mesh-web roadmap C3.1c, which only makes sense beside C3.2: the site's repository is the source of
 * truth for what it exposes, so this collection is not a declaration. It is a cache of *observed
 * reality* — what each instance actually loaded — and the one design question is what a row is
 * about.
 *
 * It is about a process, not about an application. These tests are mostly that claim: a rolling
 * deploy has to be visible, and it is only visible if instances do not overwrite each other.
 */

import { describe, expect, it } from 'vitest';

import { exposureConsensus, type ExposureRecord } from '../src/index.js';

const NOW = new Date('2026-09-03T22:00:00Z').getTime();

const row = (over: Partial<ExposureRecord> & Pick<ExposureRecord, 'nodeID' | 'exposure'>): ExposureRecord => ({
    application: 'surfdns.console',
    base: '/api',
    calls: 12,
    events: 2,
    heartbeatAt: new Date(NOW - 5_000),
    startedAt: new Date(NOW - 600_000),
    ...over,
});

describe('a finished deploy looks different from one in progress', () => {
    it('agrees when every live instance loaded the same exposure', () => {
        const consensus = exposureConsensus([
            row({ nodeID: 'n1', exposure: 'sha256:aaa' }),
            row({ nodeID: 'n2', exposure: 'sha256:aaa' }),
            row({ nodeID: 'n3', exposure: 'sha256:aaa' }),
        ], { now: NOW });

        expect(consensus.agreed).toBe(true);
        expect(consensus.exposure).toBe('sha256:aaa');
        expect(consensus.instances).toBe(3);
    });

    it('shows a rollout in progress instead of hiding it', () => {
        // The reason a row is per-instance. Keyed by application, whichever instance booted last
        // would have overwritten the others and the collection would confidently describe a state
        // half the cluster is not in — while the proxy serves browsers from either half.
        const consensus = exposureConsensus([
            row({ nodeID: 'n1', exposure: 'sha256:new' }),
            row({ nodeID: 'n2', exposure: 'sha256:old' }),
            row({ nodeID: 'n3', exposure: 'sha256:old' }),
        ], { now: NOW });

        expect(consensus.agreed).toBe(false);
        expect(consensus.exposure).toBeUndefined();
        expect(consensus.serving.get('sha256:old')).toEqual(['n2', 'n3']);
        expect(consensus.serving.get('sha256:new')).toEqual(['n1']);
    });

    it('does not call an application with nothing running "agreed"', () => {
        // Answering "is the deploy finished?" with yes when nothing is serving would be the worst
        // possible answer, because it is the one that stops someone looking.
        expect(exposureConsensus([], { now: NOW })).toMatchObject({ agreed: false, instances: 0 });
    });
});

describe('a row outlives the process that wrote it', () => {
    it('excludes a stale row from the agreement but still reports it', () => {
        const consensus = exposureConsensus([
            row({ nodeID: 'n1', exposure: 'sha256:new' }),
            row({ nodeID: 'n2', exposure: 'sha256:new' }),
            // Died mid-deploy, three hours ago.
            row({ nodeID: 'n-dead', exposure: 'sha256:old', heartbeatAt: new Date(NOW - 10_800_000) }),
        ], { now: NOW });

        // An instance that died should not make a finished rollout look unfinished forever.
        expect(consensus.agreed).toBe(true);
        expect(consensus.exposure).toBe('sha256:new');

        // But it is still reported, because a row that never goes away is also how a wedged
        // process looks, and those two need telling apart by a human.
        expect(consensus.stale.map((r) => r.nodeID)).toEqual(['n-dead']);
    });

    it('uses the heartbeat, not the start time', () => {
        // A long-lived healthy instance is not stale.
        const old = row({
            nodeID: 'n1',
            exposure: 'sha256:aaa',
            startedAt: new Date(NOW - 30 * 24 * 3_600_000),
            heartbeatAt: new Date(NOW - 1_000),
        });

        expect(exposureConsensus([old], { now: NOW }).stale).toEqual([]);
    });

    it('takes the staleness window from the caller', () => {
        const rows = [row({ nodeID: 'n1', exposure: 'sha256:aaa', heartbeatAt: new Date(NOW - 30_000) })];

        expect(exposureConsensus(rows, { now: NOW, staleAfterMs: 60_000 }).stale).toHaveLength(0);
        expect(exposureConsensus(rows, { now: NOW, staleAfterMs: 10_000 }).stale).toHaveLength(1);
    });

    it('reads a date that came back from JSON as a string', () => {
        // A row fetched over the mesh has been through JSON, so heartbeatAt is a string by the time
        // anyone asks this question. Getting that wrong would make every row look infinitely stale.
        const fromJson = JSON.parse(JSON.stringify([
            row({ nodeID: 'n1', exposure: 'sha256:aaa' }),
        ])) as ExposureRecord[];

        expect(exposureConsensus(fromJson, { now: NOW }).stale).toEqual([]);
        expect(exposureConsensus(fromJson, { now: NOW }).agreed).toBe(true);
    });
});
