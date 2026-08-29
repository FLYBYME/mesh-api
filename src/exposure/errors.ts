import { MeshError } from '@flybyme/mesh';

/**
 * HttpErrorBody: the one error shape this layer ever returns.
 *
 * Consistent everywhere so a client can branch on `code` without string-matching messages.
 */
export interface HttpErrorBody {
    readonly error: {
        readonly code: string;
        readonly message: string;
    };
}

/**
 * toHttpError: maps a thrown value to a status code and a safe body.
 *
 * A `MeshError` already carries the right status and code -- the codebase sets them correctly via
 * `notFound`/`badRequest`/`conflict`, so honouring them is the whole mapping. Anything else is an
 * unexpected failure: it becomes a 500 with a generic message, because the thrown message may
 * contain internal detail (a Mongo error, a connection string) that must never reach a client.
 * The real error is returned separately so the caller can log it.
 */
export function toHttpError(err: unknown): { status: number; body: HttpErrorBody; logged: unknown } {
    if (err instanceof MeshError) {
        return {
            status: err.status,
            body: { error: { code: err.code, message: err.message } },
            logged: err,
        };
    }
    return {
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
        logged: err,
    };
}
