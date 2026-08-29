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
