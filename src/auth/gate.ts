import { MeshError, toolKey, type ToolContract, type z } from '@flybyme/mesh';
import type { AuthLevel, ExposeEntry } from '../exposure/types.js';
import type { SessionRecord, AuthorizeHook, AuthorizeInput } from './types.js';

/** Role that satisfies `auth: 'admin'`. One name, checked in one place. */
export const ADMIN_ROLE = 'admin';

/**
 * checkAuth: the coarse gate at the public boundary.
 *
 * Throws rather than returning a boolean so a caller cannot forget to branch on the result -- the
 * failure mode of a boolean gate is an ignored return value, and that failure mode is a security
 * hole rather than a bug.
 *
 * A missing session means unauthenticated, always. It never means "trusted internal caller".
 */
export function checkAuth(required: AuthLevel, session: SessionRecord | undefined): void {
    if (required === 'public') return;

    if (!session) {
        throw new MeshError({ code: 'UNAUTHENTICATED', status: 401, message: 'Authentication required' });
    }
    if (required === 'user') return;

    const roles = session.user.roles ?? [];
    if (!roles.includes(ADMIN_ROLE)) {
        throw new MeshError({ code: 'FORBIDDEN', status: 403, message: 'Insufficient privileges' });
    }
}

/**
 * matchPermission: matches a permission glob pattern against a required permission key.
 *
 * Evaluates glob patterns such as '*', '*.*', 'domain.*' (e.g. 'dns.*' matches 'dns.write'),
 * prefix wildcards (e.g. 'dns.record_*'), and exact matches ('dns.write').
 */
export function matchPermission(pattern: string, requiredPermission: string): boolean {
    if (!pattern || !requiredPermission) return false;
    if (pattern === '*' || pattern === '*.*') return true;
    if (pattern === requiredPermission) return true;

    if (pattern.includes('*')) {
        const regexStr = '^' + pattern.split('*').map((s) => s.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')).join('.*') + '$';
        const regex = new RegExp(regexStr);
        return regex.test(requiredPermission);
    }

    return false;
}

/**
 * extractRequestedScope: extracts a requested scope identifier from request parameters.
 *
 * Scans path parameters, query parameters, request body, and merged input for standard
 * tenancy/scope parameter names ('orgId', 'tenantId', 'scope', 'organizationId').
 */
export function extractRequestedScope(
    rawInput: Record<string, unknown>,
    params?: Record<string, unknown>,
    query?: Record<string, unknown>,
    body?: Record<string, unknown>
): string | undefined {
    const candidate =
        params?.['orgId'] ??
        params?.['tenantId'] ??
        params?.['scope'] ??
        params?.['organizationId'] ??
        query?.['orgId'] ??
        query?.['tenantId'] ??
        query?.['scope'] ??
        query?.['organizationId'] ??
        body?.['orgId'] ??
        body?.['tenantId'] ??
        body?.['scope'] ??
        body?.['organizationId'] ??
        rawInput['orgId'] ??
        rawInput['tenantId'] ??
        rawInput['scope'] ??
        rawInput['organizationId'];

    if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
    }
    return undefined;
}

/**
 * validateExposeEntry: enforces at runtime that every exposed contract has an explicit gate.
 *
 * An entry with neither `auth` nor `permission` is refused at startup so an author cannot
 * accidentally leave a contract unguarded. An entry specifying both is refused as contradictory.
 */
export function validateExposeEntry(entry: {
    readonly contract: ToolContract<import('@flybyme/mesh').z.ZodTypeAny, import('@flybyme/mesh').z.ZodTypeAny>;
    readonly auth?: AuthLevel | string;
    readonly permission?: string;
}): void {
    const contract = entry.contract;
    const hasAuth = 'auth' in entry && typeof entry.auth === 'string' && entry.auth.length > 0;
    const hasPermission = 'permission' in entry && typeof entry.permission === 'string' && entry.permission.length > 0;

    if (!hasAuth && !hasPermission) {
        throw new Error(
            `Unguarded contract: entry for '${toolKey(contract)}' must declare either 'auth' or 'permission'. An unguarded contract is unrepresentable.`
        );
    }
    if (hasAuth && hasPermission) {
        throw new Error(
            `Invalid expose entry for '${toolKey(contract)}': cannot declare both 'auth' and 'permission'.`
        );
    }
}

export interface GateExecutionResult {
    readonly resolvedScope?: string;
    readonly extraMeta?: Record<string, unknown>;
}

/**
 * executeGate: runs the authorization gate before any request processing or broker dispatch.
 *
 * Sequences the check:
 * 1. If an application-supplied `authorize` hook exists, delegates to it with full caller context,
 *    requested scope, and contract requirements.
 * 2. If no hook exists, falls back to coarse `checkAuth` on `entry.auth`.
 * 3. If an entry requires a `permission` but no `authorize` hook was provided, refuses access (401
 *    if unauthenticated, 403 if authenticated) because permissions cannot be verified without a hook.
 */
export async function executeGate(
    entry: ExposeEntry,
    session: SessionRecord | undefined,
    rawInput: Record<string, unknown>,
    authorize?: AuthorizeHook
): Promise<GateExecutionResult> {
    validateExposeEntry(entry);

    if (authorize) {
        const requestedScope = extractRequestedScope(rawInput);
        const user = session?.user;
        const permission = 'permission' in entry ? entry.permission : undefined;
        const auth = 'auth' in entry ? entry.auth : undefined;

        const input: AuthorizeInput = {
            user,
            principal: user?.id,
            userScope: user?.tenant_id,
            requestedScope,
            permission,
            auth,
            contract: entry.contract,
            input: rawInput,
        };

        const result = await authorize(input);

        if (typeof result === 'boolean') {
            if (!result) {
                if (!session) {
                    throw new MeshError({
                        code: 'UNAUTHENTICATED',
                        status: 401,
                        message: 'Authentication required',
                    });
                }
                throw new MeshError({
                    code: 'FORBIDDEN',
                    status: 403,
                    message: 'Insufficient privileges',
                });
            }
            return {};
        }

        if (!result.authorized) {
            const status = result.status ?? (session ? 403 : 401);
            let code = result.code;
            if (!code) {
                if (status === 401) code = 'UNAUTHENTICATED';
                else if (status === 403) code = 'FORBIDDEN';
                else if (status === 404) code = 'NOT_FOUND';
                else if (status === 400) code = 'BAD_REQUEST';
                else code = `HTTP_${status}`;
            }
            throw new MeshError({
                code,
                status,
                message: result.message,
            });
        }

        return {
            resolvedScope: result.resolvedScope,
            extraMeta: result.meta,
        };
    }

    if ('auth' in entry && entry.auth !== undefined) {
        checkAuth(entry.auth, session);
        return {};
    }

    if (!session) {
        throw new MeshError({
            code: 'UNAUTHENTICATED',
            status: 401,
            message: 'Authentication required',
        });
    }
    throw new MeshError({
        code: 'FORBIDDEN',
        status: 403,
        message: `Forbidden: No authorization hook configured to evaluate required permission '${entry.permission}'`,
    });
}
