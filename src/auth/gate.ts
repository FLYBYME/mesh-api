import { MeshError } from '@flybyme/mesh';
import type { AuthLevel } from '../exposure/types.js';
import type { SessionRecord } from './types.js';

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
