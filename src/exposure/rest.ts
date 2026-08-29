import { randomUUID } from 'node:crypto';
import type { Router, Request, Response } from 'express';
import { MeshError, toolKey } from '@flybyme/mesh';
import type { ExposureBroker } from './broker.js';
import type { ExposeEntry } from './types.js';
import { coerceToSchema, formatZodError } from './input.js';
import { toHttpError } from './errors.js';
import { checkAuth } from '../auth/gate.js';
import { CSRF_HEADER, csrfTokenMatches } from '../auth/session.js';
import type { SessionRecord } from '../auth/types.js';

declare global {
    namespace Express {
        interface Request {
            session?: SessionRecord;
        }
    }
}

export interface MountRestOptions {
    readonly broker: ExposureBroker;
    readonly expose: readonly ExposeEntry[];
}

/**
 * mountRest: mounts one express route per exposed contract on the given router.
 *
 * Route path and method are derived directly from each contract's `rest` metadata.
 * Only contracts explicitly declared in `options.expose` receive routes.
 */
export function mountRest(router: Router, options: MountRestOptions): void {
    const registeredRoutes = new Map<string, string>();

    for (const entry of options.expose) {
        const contract = entry.contract;
        const key = toolKey(contract);
        const method = contract.rest.method.toUpperCase();
        const routeKey = `${method} ${contract.rest.path}`;

        const existingKey = registeredRoutes.get(routeKey);
        if (existingKey !== undefined) {
            throw new Error(`Route collision: ${routeKey} is declared by both '${existingKey}' and '${key}'`);
        }
        registeredRoutes.set(routeKey, key);

        const expressPath = contract.rest.path;
        const handler = async (req: Request, res: Response): Promise<void> => {
            const inboundCorrelationId = req.headers['x-correlation-id'];
            const correlationId = typeof inboundCorrelationId === 'string' && inboundCorrelationId.trim().length > 0
                ? inboundCorrelationId
                : randomUUID();
            res.setHeader('x-correlation-id', correlationId);

            try {
                // 1. Coarse exposure gate check before any processing or call
                checkAuth(entry.auth, req.session);

                // 2. Anti-CSRF verification on state-changing requests when a session exists
                const isStateChanging = contract.rest.method !== 'GET' || Boolean(contract.destructive);
                if (isStateChanging && req.session) {
                    const csrfHeader = req.headers[CSRF_HEADER];
                    const csrfToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
                    if (!csrfTokenMatches(req.session.csrfToken, csrfToken)) {
                        throw new MeshError({
                            code: 'FORBIDDEN',
                            status: 403,
                            message: 'Invalid or missing CSRF token',
                        });
                    }
                }
                // A public route with no session has no CSRF token to check against, so CSRF verification is skipped here.

                // 3. Merge path params, query string, and body into a single input object
                const rawInput: Record<string, unknown> = {
                    ...req.params,
                    ...req.query,
                    ...(req.body && typeof req.body === 'object' ? req.body : {}),
                };

                const coerced = coerceToSchema(contract.inputSchema, rawInput);
                const parsed = contract.inputSchema.safeParse(coerced);
                if (!parsed.success) {
                    throw new MeshError({
                        code: 'BAD_REQUEST',
                        status: 400,
                        message: formatZodError(parsed.error),
                    });
                }

                // 4. Populate call metadata -- unauthenticated calls carry no meta.user (spec/02)
                const user = req.session?.user;
                const meta = {
                    correlationId,
                    ...(user ? { user: { id: user.id, tenant_id: user.tenant_id, ...(user.roles ? { roles: [...user.roles] } : {}) } } : {}),
                };

                const result = await options.broker.call(
                    key,
                    parsed.data,
                    { meta }
                );

                res.status(200).json(result);
            } catch (err) {
                const { status, body, logged } = toHttpError(err);
                if (status >= 500) {
                    options.broker.logger.error(`[rest] Internal error on ${contract.rest.method} ${contract.rest.path}:`, logged);
                } else {
                    options.broker.logger.warn(`[rest] Request error (${status}) on ${contract.rest.method} ${contract.rest.path}:`, logged);
                }
                res.status(status).json(body);
            }
        };

        switch (contract.rest.method) {
            case 'GET':
                router.get(expressPath, handler);
                break;
            case 'POST':
                router.post(expressPath, handler);
                break;
            case 'PUT':
                router.put(expressPath, handler);
                break;
            case 'PATCH':
                router.patch(expressPath, handler);
                break;
            case 'DELETE':
                router.delete(expressPath, handler);
                break;
        }
    }
}
