/**
 * The exposure row, against a real database.
 *
 * mesh-web roadmap C3.1c. `exposure-collection.test.ts` covers the decision — what a row means and
 * how a rolling deploy reads — as a pure function over rows. This covers the part that can only be
 * wrong in contact with something: that a running api module actually writes a row, that a second
 * boot updates it rather than adding a duplicate, and that two instances produce two rows.
 *
 * Skipped when there is no mongo, because a test that needs a database should say so rather than
 * failing as if the code were broken.
 */

import { MeshApp, BrokerModule, DatabaseModule, RegistryModule, defineContract, z } from '@flybyme/mesh';
import type { IServiceBroker, IServiceContext, IServiceModule, ToolContract } from '@flybyme/mesh';
import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';

import {
    createApiModule, exposureCrud, exposureConsensus,
    type ApiModule, type ExposeEntry, type ExposureRecord,
} from '../src/index.js';

const MONGO = process.env['MONGODB_URI'] ?? 'mongodb://127.0.0.1:27017';

/** Is anything listening on mongo's port? Cheaper and clearer than waiting for a connect timeout. */
const mongoReachable = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: 27017 });
    const done = (answer: boolean): void => { socket.destroy(); resolve(answer); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 1_000);
});

const whoami = defineContract({
    domain: 'session',
    action: 'whoami',
    description: 'who',
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    rest: { method: 'GET', path: '/session/whoami' },
    visibility: 'public',
    print: String,
});

const expose: readonly ExposeEntry[] = [
    { contract: whoami as unknown as ExposeEntry['contract'], auth: 'public' },
];

/** A module that owns the exposure collection, which is how a real deployment would have it. */
function exposureModule(): IServiceModule {
    const contracts = Object.values(exposureCrud) as unknown as ToolContract<z.ZodTypeAny, z.ZodTypeAny>[];

    return {
        domain: 'exposure',
        getContracts: () => contracts.filter((c) => typeof c?.domain === 'string'),
        // The database middleware handles every action itself; `execute` is never reached for CRUD.
        isCrud: () => true,
        getEventHandlers: () => new Map(),
        async beforeCrud(_d, _a, input) { return input; },
        async afterCrud(_d, _a, output) { return output; },
        async execute(_d: string, action: string, _i: unknown, _c: IServiceContext): Promise<unknown> {
            throw new Error(`exposure has no non-CRUD action ${action}`);
        },
    };
}

interface Node { app: MeshApp; module: ApiModule; stop(): Promise<void> }

let nodes: Node[] = [];

afterEach(async () => {
    for (const node of nodes) await node.stop();
    nodes = [];
});

async function boot(nodeID: string): Promise<Node> {
    const app = new MeshApp({ nodeID, namespace: 'mesh-api-exposure-test' });
    app.use(new RegistryModule());
    app.use(new DatabaseModule({ uri: MONGO, dbName: 'mesh_api_exposure_test' }));
    app.use(new BrokerModule());

    await app.start();
    await app.registerModule(exposureModule());

    const module = createApiModule({
        application: 'surfdns.console',
        expose,
        port: 0,
        host: '127.0.0.1',
        recordExposure: true,
        // Long enough that no heartbeat fires during a test — the write under test is the one at boot.
        heartbeatMs: 600_000,
        onError: () => {},
    });

    await app.registerModule(module);

    const node: Node = {
        app,
        module,
        async stop() {
            await module.onStop?.(undefined as unknown as IServiceBroker);
            await app.stop();
        },
    };
    nodes.push(node);
    return node;
}

const rowsFor = async (app: MeshApp): Promise<ExposureRecord[]> =>
    await (app as unknown as { call(t: string, p: unknown): Promise<ExposureRecord[]> })
        .call('exposure.find', { query: { application: 'surfdns.console' } });

describe.skipIf(!mongoReachable)('an instance records what it serves', () => {
    it('writes a row at boot, with the hash it actually loaded', async () => {
        const node = await boot(`api-${String(Date.now())}-a`);

        const rows = (await rowsFor(node.app)).filter((r) => r.nodeID === node.app.nodeID);
        expect(rows).toHaveLength(1);

        const written = rows[0]!;
        expect(written.exposure).toBe(node.module.api!.descriptor.exposure);
        expect(written.calls).toBe(1);
        expect(written.base).toBe('/api');
    }, 30_000);

    it('updates its own row rather than adding another', async () => {
        const nodeID = `api-${String(Date.now())}-b`;

        const first = await boot(nodeID);
        const after = await first.module.onStart!(
            (first.app as unknown as { getProvider(n: string): IServiceBroker }).getProvider('broker'),
        ).then(() => rowsFor(first.app));

        // A row is a fact about a process, so a process that restarts has one row, not two.
        expect(after.filter((r) => r.nodeID === nodeID)).toHaveLength(1);
    }, 30_000);

    it('two instances make two rows, and that is what shows a deploy in progress', async () => {
        const a = await boot(`api-${String(Date.now())}-c1`);
        const b = await boot(`api-${String(Date.now())}-c2`);

        const rows = await rowsFor(a.app);
        const mine = rows.filter((r) => r.nodeID === a.app.nodeID || r.nodeID === b.app.nodeID);

        expect(mine).toHaveLength(2);

        // Both loaded the same exposure, so the deploy reads as finished.
        const consensus = exposureConsensus(mine);
        expect(consensus.agreed).toBe(true);
        expect(consensus.instances).toBe(2);
    }, 30_000);

    it('serves requests even when the collection is missing', async () => {
        // The row is bookkeeping. An API that refused to serve because it could not write one would
        // be trading the thing that matters for the thing that describes it.
        const app = new MeshApp({ nodeID: `api-${String(Date.now())}-d`, namespace: 'mesh-api-exposure-test' });
        app.use(new RegistryModule());
        app.use(new BrokerModule());
        await app.start();

        // A real handler behind the exposed contract, so a 500 here would mean the missing
        // collection broke serving — which is the claim — rather than that nothing implements it.
        await app.registerModule({
            domain: 'session',
            getContracts: () => [whoami as unknown as ToolContract<z.ZodTypeAny, z.ZodTypeAny>],
            isCrud: () => false,
            getEventHandlers: () => new Map(),
            async beforeCrud(_d, _a, i) { return i; },
            async afterCrud(_d, _a, o) { return o; },
            async execute() { return { ok: true }; },
        });

        const module = createApiModule({
            application: 'surfdns.console',
            expose,
            port: 0,
            host: '127.0.0.1',
            recordExposure: true,   // …and there is no exposure collection registered at all
            heartbeatMs: 600_000,
            onError: () => {},
        });

        await app.registerModule(module);

        const address = module.listener!.address() as { port: number };
        const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/session/whoami`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });

        await module.onStop?.(undefined as unknown as IServiceBroker);
        await app.stop();
    }, 30_000);
});
