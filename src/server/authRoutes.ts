import type { Router, Request, Response } from 'express';
import { MeshError, type ILogger } from '@flybyme/mesh';
import type { SessionRecord, SessionStore, SessionUser } from '../auth/types.js';
import { clearSessionCookie, readSessionId, setSessionCookie, type CookieOptions } from '../auth/session.js';
import { toHttpError } from '../exposure/errors.js';

export interface AuthRoutesOptions {
    readonly sessionStore: SessionStore;
    readonly authenticate?: (credentials: Record<string, unknown>) => Promise<SessionUser | null>;
    readonly cookie: CookieOptions;
    readonly logger?: ILogger;
}

/**
 * mountAuthRoutes: mounts the standard session management routes on a router.
 *
 * Provides login, logout, and session inspection endpoints. This layer owns the session,
 * while credential verification is delegated to the caller-provided `authenticate` hook.
 */
export function mountAuthRoutes(router: Router, options: AuthRoutesOptions): void {
    const { sessionStore, authenticate, cookie, logger } = options;

    router.post('/auth/login', async (req: Request, res: Response): Promise<void> => {
        try {
            if (!authenticate) {
                throw new MeshError({
                    code: 'NOT_IMPLEMENTED',
                    status: 501,
                    message: 'Authentication is not configured',
                });
            }

            const rawBody = req.body;
            const credentials: Record<string, unknown> = typeof rawBody === 'object' && rawBody !== null
                ? { ...rawBody }
                : {};
            const user = await authenticate(credentials);
            if (!user) {
                // Deliberately non-specific message, taking the same code path for non-existent user and wrong password
                throw new MeshError({
                    code: 'UNAUTHENTICATED',
                    status: 401,
                    message: 'Invalid credentials',
                });
            }

            // Rotate session id on login to close session fixation (spec/02)
            const existingSessionId = req.session?.id ?? readSessionId(req);
            let session: SessionRecord;
            if (existingSessionId) {
                session = await sessionStore.rotate(existingSessionId, user, cookie.ttlMs);
            } else {
                session = await sessionStore.create(user, cookie.ttlMs);
            }

            req.session = session;
            setSessionCookie(res, session, cookie);
            res.status(200).json({
                user: session.user,
                csrfToken: session.csrfToken,
            });
        } catch (err) {
            const { status, body, logged } = toHttpError(err);
            if (logger) {
                if (status >= 500) {
                    logger.error('[auth] Login internal error:', logged);
                } else {
                    logger.warn('[auth] Login failed:', logged);
                }
            }
            res.status(status).json(body);
        }
    });

    router.post('/auth/logout', async (req: Request, res: Response): Promise<void> => {
        try {
            const sessionId = req.session?.id ?? readSessionId(req);
            if (sessionId) {
                await sessionStore.destroy(sessionId);
            }
            req.session = undefined;
            clearSessionCookie(res, cookie);
            res.status(200).json({ ok: true });
        } catch (err) {
            const { status, body, logged } = toHttpError(err);
            if (logger) {
                logger.error('[auth] Logout error:', logged);
            }
            res.status(status).json(body);
        }
    });

    router.get('/session', async (req: Request, res: Response): Promise<void> => {
        try {
            if (req.session) {
                res.status(200).json({
                    user: req.session.user,
                    csrfToken: req.session.csrfToken,
                });
            } else {
                res.status(200).json({
                    user: null,
                });
            }
        } catch (err) {
            const { status, body, logged } = toHttpError(err);
            if (logger) {
                logger.error('[auth] Get session error:', logged);
            }
            res.status(status).json(body);
        }
    });
}
