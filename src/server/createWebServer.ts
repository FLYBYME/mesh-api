import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import { toolKey, type IMeshApp, type IServiceBroker, type ServiceModule } from '@flybyme/mesh';
import type { ExposeEntry } from '../exposure/types.js';
import { WebServiceModule } from '../exposure/WebServiceModule.js';
import { mountRest } from '../exposure/rest.js';
import type { SessionStore, SessionUser } from '../auth/types.js';
import { MemorySessionStore } from '../auth/MemorySessionStore.js';
import { readSessionId, type CookieOptions } from '../auth/session.js';
import { mountAuthRoutes } from './authRoutes.js';
import { DEFAULT_BASE_PATH } from '../exposure/paths.js';

export interface CreateWebServerOptions {
    readonly app: IMeshApp;
    readonly modules: readonly ServiceModule[];
    readonly sessionStore?: SessionStore;
    readonly authenticate?: (credentials: Record<string, unknown>) => Promise<SessionUser | null>;
    readonly cookie?: Partial<CookieOptions>;
    readonly basePath?: string;
}

export interface CreateWebServerResult {
    readonly router: Router;
    readonly exposed: readonly ExposeEntry[];
}

/**
 * createWebServer: assembles the REST API, session handling, and authentication routes.
 *
 * Scans the provided WebServiceModules for declared web configurations, validates that
 * no duplicate tool keys are exposed across modules, resolves sessions onto requests,
 * and mounts the resulting API endpoints under `basePath`.
 */
export function createWebServer(options: CreateWebServerOptions): CreateWebServerResult {
    const exposed: ExposeEntry[] = [];
    const seenToolKeys = new Map<string, string>();

    for (const module of options.modules) {
        if (module instanceof WebServiceModule) {
            const config = module.getWebConfig();
            if (config?.expose) {
                for (const entry of config.expose) {
                    const key = toolKey(entry.contract);
                    const existingDomain = seenToolKeys.get(key);
                    if (existingDomain !== undefined) {
                        throw new Error(`Duplicate exposed tool: contract '${key}' is exposed by multiple modules ('${existingDomain}' and '${module.domain}')`);
                    }
                    seenToolKeys.set(key, module.domain);
                    exposed.push(entry);
                }
            }
        }
    }

    const sessionStore = options.sessionStore ?? new MemorySessionStore();
    const cookie: CookieOptions = {
        secure: options.cookie?.secure ?? false,
        ttlMs: options.cookie?.ttlMs ?? 7 * 24 * 60 * 60 * 1000,
    };

    const broker = options.app.getProvider<IServiceBroker>('broker');

    const rootRouter = express.Router();
    const apiRouter = express.Router();

    // Body parsing for JSON payloads
    apiRouter.use(express.json());

    // Single per-request session resolution so gate, CSRF, and meta bridge share state
    apiRouter.use(async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
        try {
            const sessionId = readSessionId(req);
            if (sessionId) {
                req.session = await sessionStore.get(sessionId);
            }
        } catch (err) {
            broker.logger.warn('[session] Error retrieving session from store:', err);
        }
        next();
    });

    // Mount authentication endpoints (/auth/login, /auth/logout, /session)
    mountAuthRoutes(apiRouter, {
        sessionStore,
        authenticate: options.authenticate,
        cookie,
        logger: broker.logger,
    });

    // Mount contract REST endpoints
    mountRest(apiRouter, {
        broker,
        expose: exposed,
    });

    // Mount under basePath (default /api)
    const basePath = options.basePath ?? DEFAULT_BASE_PATH;
    if (basePath === '' || basePath === '/') {
        rootRouter.use(apiRouter);
    } else {
        const normalizedPath = basePath.startsWith('/') ? basePath : `/${basePath}`;
        rootRouter.use(normalizedPath, apiRouter);
    }

    return {
        router: rootRouter,
        exposed,
    };
}
