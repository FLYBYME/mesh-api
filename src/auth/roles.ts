/**
 * Role names shared by the server gate and the browser runtime.
 *
 * This module imports nothing, and that is its whole purpose.
 *
 * `ADMIN_ROLE` used to live in `auth/gate.ts`. The manifest loader — browser code, reached through
 * `@flybyme/mesh-api/runtime` — needs it to decide whether an `auth: 'admin'` app may load, so it
 * imported it from there. That is a *value* import, so bundling the browser entry pulled in
 * `gate.ts`, and with it `@flybyme/mesh`, express, and the rest of the server half:
 *
 *     ✘ Could not resolve "node:http"   node_modules/express/lib/application.js
 *     ✘ Could not resolve "crypto"      node_modules/cookie-signature/index.js
 *
 * `src/index.ts` already carries the warning for the other direction — a single entry re-exporting
 * both halves crashes a Node consumer at startup. This was the same mistake pointing the other way,
 * costing a browser bundle the entire server.
 *
 * A constant shared across that boundary belongs in a module with no imports at all.
 */

/** Role that satisfies `auth: 'admin'`. One name, checked in one place. */
export const ADMIN_ROLE = 'admin';
