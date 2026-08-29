import { describe, it, expect } from 'vitest';
import express from 'express';
import { z, defineContract, defaultPrint } from '@flybyme/mesh';
import { generateClient } from '../src/cli/generate-client.js';
import { DEFAULT_BASE_PATH } from '../src/exposure/paths.js';
import { mountMcpRoute } from '../src/server/mcpRoute.js';
import type { ExposeEntry } from '../src/exposure/types.js';

// Regressions found by mesh-api's first real consumer (the kanban port). Each of these was a
// defect that type-checked, passed the package's own tests, and still broke a caller.

const pingContract = defineContract({
    domain: 'demo',
    action: 'ping',
    description: 'Returns pong',
    inputSchema: z.object({}),
    outputSchema: z.object({ pong: z.boolean() }),
    rest: { method: 'GET', path: '/demo/ping' },
    print: defaultPrint,
});

const exposed: ExposeEntry[] = [{ contract: pingContract, auth: 'public' }];

describe('consumer regressions', () => {
    it('generates a client whose default baseUrl matches the server default basePath', () => {
        // These two defaults disagreed: the server mounted under /api while the generated client
        // defaulted to '', so a client generated without an explicit option 404'd against its own
        // server. Nothing in either file was wrong on its own, which is why this is pinned.
        const code = generateClient(exposed);
        expect(code).toContain(JSON.stringify(DEFAULT_BASE_PATH));
        expect(DEFAULT_BASE_PATH).toBe('/api');
    });

    it('serves MCP across more than one request', async () => {
        // The prototype built one stateless StreamableHTTPServerTransport at startup and reused
        // it. The SDK throws "Stateless transport cannot be reused across requests" on the SECOND
        // call -- so it passed every smoke test and 500'd in use. mountMcpRoute builds per request.
        const app = express();
        app.use(express.json());
        const broker = {
            call: async () => ({ pong: true }),
            logger: {
                info() {},
                warn() {},
                error() {},
                debug() {},
                child() { return this; },
                getLevel() { return 0; },
            },
        };
        mountMcpRoute(app, { broker, expose: exposed, info: { name: 'demo', version: '0.0.1' } });

        const server = app.listen(0);
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('expected a TCP address from listen(0)');
        }
        const url = `http://127.0.0.1:${address.port}/mcp`;
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        });
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

        const first = await fetch(url, { method: 'POST', headers, body });
        const second = await fetch(url, { method: 'POST', headers, body });

        // The second request is the whole point: with a reused transport it is a 500.
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);

        await new Promise<void>(resolve => server.close(() => resolve()));
    });
});
