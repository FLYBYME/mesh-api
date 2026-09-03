/**
 * The real ticket validator: a mesh call to identity.
 *
 * mesh-web spec/auth.md §3. Everything the ticket cache does — caching, the TTL backstop, negative
 * caching, single-flight — sits in front of *this*, which is the only thing that actually knows
 * whether a ticket is any good.
 *
 * Kept separate from the cache so the cache can be tested without a mesh and this can be swapped for
 * a site that identifies people some other way.
 */

import type { Validator, TicketValidation } from '../auth/tickets.js';

/** What this layer needs from a broker in order to validate. Narrow, for the reason in broker.ts. */
export interface IdentityBroker {
    call(tool: string, params: unknown): Promise<unknown>;
}

export interface IdentityValidatorOptions {
    readonly broker: IdentityBroker;
    /** The contract that answers "is this ticket valid, and who is it". */
    readonly tool?: string;
    /**
     * Told when identity answers in a shape this does not understand.
     *
     * Not a debug hook. A validator that cannot read the answer returns "invalid", which is the safe
     * outcome and is indistinguishable from a genuinely bad ticket — so an upgrade that changed the
     * response shape would look like every ticket suddenly being rejected, with nothing saying why.
     */
    readonly onUnreadable?: (response: unknown) => void;
}

export const DEFAULT_VALIDATE_TOOL = 'identity.ticket_validate';

/**
 * Build the validator.
 *
 * The response is read defensively and **never trusted to be well-formed**: identity is another
 * process, possibly a different version, and this is the one call whose answer decides whether
 * someone is authenticated. A malformed response resolves to "not valid" rather than to a caller
 * with an undefined id.
 */
export function identityValidator(options: IdentityValidatorOptions): Validator {
    const tool = options.tool ?? DEFAULT_VALIDATE_TOOL;

    return async (ticket: string): Promise<TicketValidation> => {
        const response = await options.broker.call(tool, { ticket });

        if (typeof response !== 'object' || response === null) {
            options.onUnreadable?.(response);
            return { valid: false };
        }

        const record = response as Record<string, unknown>;

        // An explicit `valid: false` is a clear answer and needs no further reading.
        if (record['valid'] === false) return { valid: false };

        const userId = record['userId'] ?? record['id'];
        if (typeof userId !== 'string' || userId.trim() === '') {
            // Identity said something, but not who. Treated as invalid: a caller with no id would
            // be an authenticated nobody, which every downstream check would then have to guard.
            options.onUnreadable?.(response);
            return { valid: false };
        }

        const roles = Array.isArray(record['roles'])
            ? record['roles'].filter((r): r is string => typeof r === 'string')
            : [];

        const expiresAt = typeof record['expiresAt'] === 'number' ? record['expiresAt'] : undefined;

        return {
            valid: true,
            caller: { userId: userId.trim(), roles },
            ...(expiresAt === undefined ? {} : { expiresAt }),
        };
    };
}
