import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import { toolKey, type IMeshApp, type IServiceBroker, type ServiceModule } from '@flybyme/mesh';
import type { ExposeEntry } from '../exposure/types.js';
import { WebServiceModule } from '../exposure/WebServiceModule.js';
import { mountRest } from '../exposure/rest.js';
import type { SessionStore, SessionUser, AuthorizeHook } from '../auth/types.js';
import { MemorySessionStore } from '../auth/MemorySessionStore.js';
import { readSessionId, type CookieOptions } from '../auth/session.js';
import { mountAuthRoutes } from './authRoutes.js';
import { DEFAULT_BASE_PATH } from '../exposure/paths.js';

export interface CreateWebServerOptions {
    readonly app: IMeshApp;
    readonly modules: readonly ServiceModule[];
    readonly sessionStore?: SessionStore;
    readonly authenticate?: (credentials: Record<string, unknown>) => Promise<SessionUser | null>;
    readonly authorize?: AuthorizeHook;
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
 * composes module and server authorization hooks, and mounts the resulting API endpoints under `basePath`.
 */
export function createWebServer(options: CreateWebServerOptions): CreateWebServerResult {
    const exposed: ExposeEntry[] = [];
    const seenToolKeys = new Map<string, string>();
    const moduleAuthorizers = new Map<string, AuthorizeHook>();

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
                    if (config.authorize) {
                        moduleAuthorizers.set(key, config.authorize);
                    }
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

    // Build composite authorizer: module authorizer takes precedence for its own contracts, falling back to server authorizer
    const compositeAuthorize: AuthorizeHook | undefined = (moduleAuthorizers.size > 0 || options.authorize !== undefined)
        ? async (input) => {
            const key = toolKey(input.contract);
            const moduleAuth = moduleAuthorizers.get(key);
            if (moduleAuth) {
                return moduleAuth(input);
            }
            if (options.authorize) {
                return options.authorize(input);
            }
            return true;
        }
        : undefined;

    // Mount contract REST endpoints
    mountRest(apiRouter, {
        broker,
        expose: exposed,
        authorize: compositeAuthorize,
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
