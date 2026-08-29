import type { Router, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer, type McpServerInfo, type McpSessionAccessor } from '../exposure/mcp.js';
import type { ExposureBroker } from '../exposure/broker.js';
import type { ExposeEntry } from '../exposure/types.js';
import type { SessionRecord } from '../auth/types.js';
import { toHttpError } from '../exposure/errors.js';

export interface MountMcpRouteOptions {
    readonly broker: ExposureBroker;
    readonly expose: readonly ExposeEntry[];
    readonly info: McpServerInfo;
    /** Path to mount on. Defaults to `/mcp`. */
    readonly path?: string;
    readonly session?: SessionRecord | McpSessionAccessor;
}

/**
 * mountMcpRoute: serves the exposed contracts over MCP at one HTTP route.
 *
 * **A fresh server and transport are built per request, deliberately.** The obvious shape -- build
 * one `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` at startup and call
 * `handleRequest` on it forever -- is what the prototype did, and it is wrong: in stateless mode
 * the SDK throws "Stateless transport cannot be reused across requests. Create a new transport per
 * request." on the *second* call. So it works in a smoke test and 500s in use, which is the worst
 * possible failure shape. mesh-api's first real consumer hit exactly this, which is why the helper
 * exists rather than the pattern being left to each caller to rediscover.
 *
 * Building per request is cheap: `buildMcpServer` only walks the already-resolved expose list.
 */
export function mountMcpRoute(router: Router, options: MountMcpRouteOptions): void {
    const path = options.path ?? '/mcp';

    router.post(path, async (req: Request, res: Response): Promise<void> => {
        try {
            const server = buildMcpServer(options.broker, options.expose, options.info, {
                session: options.session,
            });
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            const { status, body, logged } = toHttpError(err);
            options.broker.logger.error('[mcp] error handling request:', logged);
            // The transport may already have written headers and begun streaming a response, in
            // which case anything further would corrupt the stream rather than report the error.
            if (!res.headersSent) {
                res.status(status).json(body);
            }
        }
    });
}
