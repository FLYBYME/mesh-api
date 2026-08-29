import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { SessionRecord } from './types.js';

/** The one cookie this layer sets. Named once, here, so nothing string-matches it elsewhere. */
export const SESSION_COOKIE = 'mesh_sid';

/** Header carrying the anti-CSRF token on state-changing requests. */
export const CSRF_HEADER = 'x-csrf-token';

export interface CookieOptions {
    /** Off only for local http development. Any real deployment leaves this true. */
    readonly secure: boolean;
    readonly ttlMs: number;
}

/**
 * setSessionCookie: HttpOnly + Secure + SameSite=Lax, always.
 *
 * HttpOnly is not negotiable here: the runtime loads app code dynamically (including, under
 * federation, code from another site), so "a token readable by JavaScript" is a concrete risk in
 * this architecture rather than a theoretical one. SameSite=Lax keeps top-level navigation working
 * while blocking the cross-site form POST that CSRF depends on.
 */
export function setSessionCookie(res: Response, record: SessionRecord, opts: CookieOptions): void {
    const parts = [
        `${SESSION_COOKIE}=${record.id}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(opts.ttlMs / 1000)}`,
    ];
    if (opts.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response, opts: CookieOptions): void {
    const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (opts.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
}

/**
 * readSessionId: pulls the session id out of the Cookie header.
 *
 * Done by hand rather than with cookie-parser: one cookie, one header, no dependency.
 */
export function readSessionId(req: Request): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const pair of header.split(';')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        if (pair.slice(0, eq).trim() !== SESSION_COOKIE) continue;
        const value = pair.slice(eq + 1).trim();
        return value.length > 0 ? value : undefined;
    }
    return undefined;
}

/**
 * csrfTokenMatches: constant-time comparison.
 *
 * `timingSafeEqual` throws on length mismatch, so lengths are checked first -- and a length
 * mismatch is not a timing leak worth caring about, since token length is fixed and public.
 */
export function csrfTokenMatches(expected: string, provided: string | undefined): boolean {
    if (typeof provided !== 'string') return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}
