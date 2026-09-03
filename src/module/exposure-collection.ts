/**
 * The `exposure` collection: what each API instance is actually serving.
 *
 * mesh-web roadmap C3.1c, and it only makes sense next to C3.2, which decided that **the site's
 * repository is the source of truth** for what a site exposes. So this collection is not where
 * anyone declares anything. It is a **cache of observed reality**: each API instance writes what it
 * loaded, at boot, and nothing else ever writes it.
 *
 * ## One row per instance, not per application
 *
 * The obvious design is one row per application — "here is surfdns.console's exposure". It is wrong,
 * and the reason is the only interesting thing about this file.
 *
 * Ten API instances roll out one at a time. For a few minutes, some are serving the old exposure and
 * some the new. A single row keyed by application would be overwritten by whichever instance booted
 * last, and would then confidently describe a state that half the cluster is not in — while a
 * browser holding a client generated against either hash gets served by whichever instance the
 * proxy picked.
 *
 * Keyed by instance, that same rollout is *visible*: rows disagree, and disagreeing rows are exactly
 * the question "is this deploy finished?" made answerable. `exposureConsensus` below is that
 * question, in one function.
 *
 * A row is therefore a fact about a process, and stale rows for processes that have gone away are
 * expected rather than a bug — see `heartbeatAt`.
 */

import { defineCrud, z } from '@flybyme/mesh';

export const ExposureRecordSchema = z.object({
    /** The site, e.g. `surfdns.console`. Several instances share this. */
    application: z.string().describe('The application this instance serves'),
    /** The mesh node. With `application`, this is what makes the row about a *process*. */
    nodeID: z.string().describe('The mesh node running this instance'),
    exposure: z.string().describe('The exposure hash this instance loaded'),
    base: z.string().describe('Where its routes are mounted'),
    calls: z.number().describe('How many contracts it serves'),
    events: z.number().describe('How many event streams it serves'),
    /** Refreshed while the instance lives, so a dead instance's row can be told from a live one. */
    heartbeatAt: z.date().describe('When this instance last confirmed it was serving'),
    startedAt: z.date().describe('When this instance loaded its exposure'),
});

export type ExposureRecord = z.infer<typeof ExposureRecordSchema>;

/**
 * The collection.
 *
 * Every action stays `internal` — the default, and correct here. This describes the cluster's own
 * shape, and publishing it would let anyone enumerate every site's surface, its routes and its
 * gates. A site that wants it public can expose one of these contracts deliberately, which is the
 * decision `visibility` exists to force.
 */
export const exposureCrud = defineCrud('exposure', ExposureRecordSchema, {
    pluralPath: 'exposures',
    dependencies: [],
});

// ---------------------------------------------------------------------------- reading the rows

export interface Consensus {
    /** True when every live instance of this application loaded the same exposure. */
    readonly agreed: boolean;
    /** The hash they agree on, when they do. */
    readonly exposure: string | undefined;
    /** Every distinct hash currently being served, with the nodes serving it. */
    readonly serving: ReadonlyMap<string, readonly string[]>;
    readonly instances: number;
    /** Rows whose heartbeat is older than the window — a process that went away, or is wedged. */
    readonly stale: readonly ExposureRecord[];
}

export const DEFAULT_STALE_AFTER_MS = 60_000;

/**
 * Is this application's deploy finished?
 *
 * A pure function over rows, so the question can be asked of a snapshot, a test fixture, or a live
 * query without either of them needing the others.
 *
 * Stale rows are excluded from the agreement rather than counted against it. An instance that died
 * mid-deploy should not make a finished rollout look unfinished forever — but it is still reported,
 * because a row that never goes away is also how a wedged process looks.
 */
export function exposureConsensus(
    rows: readonly ExposureRecord[],
    options: { readonly now?: number; readonly staleAfterMs?: number } = {},
): Consensus {
    const now = options.now ?? Date.now();
    const staleAfter = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

    const stale: ExposureRecord[] = [];
    const live: ExposureRecord[] = [];

    for (const row of rows) {
        const age = now - new Date(row.heartbeatAt).getTime();
        (age > staleAfter ? stale : live).push(row);
    }

    const serving = new Map<string, string[]>();
    for (const row of live) {
        const nodes = serving.get(row.exposure) ?? [];
        nodes.push(row.nodeID);
        serving.set(row.exposure, nodes);
    }

    const hashes = [...serving.keys()];

    return {
        // No live instance is not agreement. Reporting `agreed: true` for an application nobody is
        // serving would answer "is the deploy finished?" with yes when the answer is "there is
        // nothing running".
        agreed: hashes.length === 1,
        exposure: hashes.length === 1 ? hashes[0] : undefined,
        serving: new Map([...serving].map(([hash, nodes]) => [hash, [...nodes].sort()])),
        instances: live.length,
        stale,
    };
}
