/**
 * What the `api` module answers over the mesh.
 *
 * mesh-web spec/service-modules.md §2: `api_routes` (what this instance serves) and `api_status`.
 * Both are `internal` — they describe an instance to the cluster, not to the internet, and exposing
 * them would let anyone enumerate a site's whole surface and its gates. If a site wants them public
 * it can say so in its exposure list, deliberately, which is the point of `visibility` defaulting
 * closed.
 */

import { defineContract, z } from '@flybyme/mesh';

export const apiStatusContract = defineContract({
    domain: 'api',
    action: 'status',
    description: 'What this API instance is serving, and how much of it is cached.',
    inputSchema: z.object({}),
    outputSchema: z.object({
        application: z.string(),
        exposure: z.string(),
        base: z.string(),
        calls: z.number(),
        events: z.number(),
        tickets: z.number(),
        listening: z.number().nullable(),
        nodeID: z.string(),
    }),
    rest: { method: 'GET', path: '/api/status' },
    print: (o) => `${o.application} @ ${o.exposure} — ${String(o.calls)} calls, ${String(o.events)} events`,
});

export const apiRoutesContract = defineContract({
    domain: 'api',
    action: 'routes',
    description: 'Every route this API instance serves, with the gate on each.',
    inputSchema: z.object({}),
    outputSchema: z.object({
        exposure: z.string(),
        routes: z.array(z.object({
            key: z.string(),
            method: z.string(),
            path: z.string(),
            gate: z.string(),
        })),
    }),
    rest: { method: 'GET', path: '/api/routes' },
    print: (o) => o.routes.map((r) => `${r.method} ${r.path} → ${r.key} (${r.gate})`).join('\n'),
});
