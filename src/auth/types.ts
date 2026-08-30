/**
 * SessionUser: exactly the shape mesh already defines for `meta.user` (`IMeshMeta`).
 *
 * Declared here rather than imported so the auth layer's contract with the rest of the system is
 * visible in one place, but the fields are mesh's, not ours -- this is the bridge between end-user
 * identity (this layer's job) and node identity (mesh's job), and the bridge only works if both
 * sides agree on the shape exactly.
 */
export interface SessionUser {
    readonly id: string;
    readonly tenant_id: string;
    readonly roles?: readonly string[];
    readonly [key: string]: unknown;
}

/**
 * SessionRecord: a session as the server holds it.
 *
 * Sessions are server-side records, not self-describing tokens, so logout, expiry and forced
 * revocation are real rather than advisory -- deleting the record ends the session immediately,
 * everywhere.
 */
export interface SessionRecord {
    readonly id: string;
    readonly user: SessionUser;
    readonly csrfToken: string;
    readonly createdAt: number;
    expiresAt: number;
}

/**
 * SessionStore: the persistence seam.
 *
 * The in-memory implementation is correct for a single process and for tests. A real deployment
 * swaps in a mesh CRUD-backed or Redis-backed store without anything else in this package changing.
 */
export interface SessionStore {
    get(id: string): Promise<SessionRecord | undefined>;
    create(user: SessionUser, ttlMs: number): Promise<SessionRecord>;
    /** Deletes and recreates under a fresh id, preserving nothing but the user. Used on privilege
     *  change (login, tenant switch, elevation) to close session fixation. */
    rotate(id: string, user: SessionUser, ttlMs: number): Promise<SessionRecord>;
    destroy(id: string): Promise<void>;
}

/**
 * AuthorizeInput: the complete context handed to an application-supplied authorization hook.
 *
 * The framework extracts the caller's authenticated identity and any requested scope parameters
 * from the request before invoking the hook. The framework owns this extraction and the boundary
 * sequencing; the application owns the meaning of what a principal is permitted to do in that scope.
 */
export interface AuthorizeInput {
    /** The authenticated caller's session user, or undefined if unauthenticated. */
    readonly user?: SessionUser;
    /** Shorthand for user?.id (the authenticated principal ID). */
    readonly principal?: string;
    /** Shorthand for user?.tenant_id (the user's home/credential scope). */
    readonly userScope?: string;
    /**
     * The scope requested by the caller (e.g. from path params, query params, or body:
     * orgId, tenantId, scope, organizationId). Undefined if caller supplied none.
     */
    readonly requestedScope?: string;
    /** The fine-grained permission required by the contract (e.g. 'dns.write'), if declared. */
    readonly permission?: string;
    /** The coarse auth level required by the contract ('public' | 'user' | 'admin'), if declared. */
    readonly auth?: import('../exposure/types.js').AuthLevel;
    /** The contract being accessed. */
    readonly contract: import('@flybyme/mesh').ToolContract<import('@flybyme/mesh').z.ZodTypeAny, import('@flybyme/mesh').z.ZodTypeAny>;
    /** Merged raw request input (path params, query string, and body). */
    readonly input: Record<string, unknown>;
}

/**
 * AuthorizeSuccess: decision granting access to the requested contract.
 */
export interface AuthorizeSuccess {
    readonly authorized: true;
    /**
     * The resolved scope (e.g. organization ID, tenant ID) to inject into call metadata.
     * Handlers receive this via `meta.user.tenant_id`, ensuring a caller-supplied org
     * in the body can never trick the handler.
     */
    readonly resolvedScope?: string;
    /**
     * Optional additional metadata to merge into `ctx.meta` for the downstream broker call.
     */
    readonly meta?: Record<string, unknown>;
}

/**
 * AuthorizeFailure: decision refusing access to the requested contract.
 *
 * Distinguishes unauthenticated (401), forbidden (403), scope not found (404),
 * and bad request (400) so refusal statuses are accurate and do not leak resource existence.
 */
export interface AuthorizeFailure {
    readonly authorized: false;
    /** HTTP status code (401, 403, 404, 400, etc.). Defaults to 403 when authenticated, 401 when unauthenticated. */
    readonly status?: 400 | 401 | 403 | 404 | number;
    /** Machine-readable error code (e.g. 'FORBIDDEN', 'NOT_FOUND', 'UNAUTHENTICATED', 'BAD_REQUEST'). */
    readonly code?: string;
    /** Human-readable explanation of why access was refused. */
    readonly message: string;
}

/**
 * AuthorizeResult: union of success and failure decisions.
 */
export type AuthorizeResult = AuthorizeSuccess | AuthorizeFailure;

/**
 * AuthorizeHook: application-supplied callback that decides whether a request is authorized.
 *
 * Returning boolean `true` is shorthand for `{ authorized: true }`.
 * Returning boolean `false` is shorthand for `{ authorized: false, message: 'Forbidden' }`.
 */
export type AuthorizeHook = (
    input: AuthorizeInput
) => Promise<AuthorizeResult | boolean> | AuthorizeResult | boolean;
