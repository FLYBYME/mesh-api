import { randomBytes, randomUUID } from 'node:crypto';
import type { SessionRecord, SessionStore, SessionUser } from './types.js';

/**
 * MemorySessionStore: sessions in a Map.
 *
 * Correct for a single process and for tests. Expired records are dropped lazily on read rather
 * than swept on a timer -- a timer would keep an otherwise-idle process awake, and a session that
 * is never read again does no harm by lingering until the process exits.
 */
export class MemorySessionStore implements SessionStore {
    private readonly sessions = new Map<string, SessionRecord>();

    public async get(id: string): Promise<SessionRecord | undefined> {
        const record = this.sessions.get(id);
        if (!record) return undefined;
        if (record.expiresAt <= Date.now()) {
            this.sessions.delete(id);
            return undefined;
        }
        return record;
    }

    public async create(user: SessionUser, ttlMs: number): Promise<SessionRecord> {
        const now = Date.now();
        const record: SessionRecord = {
            id: randomUUID(),
            user,
            csrfToken: randomBytes(32).toString('base64url'),
            createdAt: now,
            expiresAt: now + ttlMs,
        };
        this.sessions.set(record.id, record);
        return record;
    }

    public async rotate(id: string, user: SessionUser, ttlMs: number): Promise<SessionRecord> {
        this.sessions.delete(id);
        return this.create(user, ttlMs);
    }

    public async destroy(id: string): Promise<void> {
        this.sessions.delete(id);
    }

    /** Test/introspection helper. Not part of `SessionStore`. */
    public get size(): number {
        return this.sessions.size;
    }
}
