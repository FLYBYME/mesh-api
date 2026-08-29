# 02 — Auth and session

Two different identity problems live in this system, and conflating them is how security holes get built.

**Node identity** — already solved by mesh. `AuthInterceptorHMAC` and `AuthInterceptorEd25519` authenticate *peers*: a shared secret or a keypair proves "this node belongs to this mesh." Nothing shippable to a browser can hold that credential.

**End-user identity** — not solved by mesh, and the exposure layer's job. "Standard auth stuff," in the project owner's words: the boring, well-understood parts, done once, correctly, so no project reimplements them.

The exposure layer is the seam between the two. A request arrives with an end-user credential, is authenticated and authorized, and is then translated into a `broker.call` made *by the service's own node identity* on that user's behalf. The user's identity travels as call metadata, never as network trust.

## The bridge: `meta.user`

Mesh already defines the shape (`IMeshMeta`):

```ts
user?: { id: string; tenant_id: string; roles?: string[]; [key: string]: unknown }
```

This is the contract between the two worlds. The exposure layer resolves the session, populates `meta.user`, and calls:

```ts
broker.call(toolName, input, { meta: { user: session.user } });
```

Downstream, every handler reads `ctx.meta?.user` — which the PaaS codebase already does today. Nothing inside a service needs to know whether a call originated from a browser, an MCP client, another service, or the CLI. That is the correct invariant, and it is worth protecting: a handler that behaves differently depending on caller type is a handler with two behaviours to test and one of them will be wrong.

**A missing `meta.user` means unauthenticated, always.** It never means "trusted internal caller, allow everything." An internal service acting as itself is a distinct, explicit case (see "System callers" below), not an absence.

## Sessions

Opinionated, one way:

- **Cookie-based**, `HttpOnly` + `Secure` + `SameSite=Lax`. Not `localStorage` — a token readable by JavaScript is a token stealable by any injected script, and the runtime loads app code dynamically, which makes that risk concrete rather than theoretical.
- **Server-side session records**, so logout, expiry, and forced revocation are real rather than advisory.
- **Rotate on privilege change** (login, org switch, elevation) to close session-fixation.
- **CSRF**: `SameSite=Lax` plus an anti-CSRF token on state-changing requests. The exposure layer knows which contracts are state-changing without being told — `rest.method` and the existing `destructive` flag already say so.

## Authorization

Two layers, deliberately:

1. **Exposure gate** (`01-exposure.md`) — is this contract reachable at all, and does it need a user? Coarse, static, declared in code, checked before any call is made.
2. **Contract-level checks** — does *this* user have access to *this* record? Fine-grained, dynamic, and it belongs inside the handler where the data is, because only the handler knows that a card belongs to an org the user is not in.

The exposure gate cannot do (2), and pretending otherwise produces exactly the false confidence that makes systems get owned. It is a door, not a bodyguard.

`roles` on `meta.user` supports the coarse case (`auth: 'admin'`). Anything sharper is the handler's job.

## One sign-in, across origins

**No, an app does not log in on its own.** Stated plainly because the opposite is the obvious wrong
answer and it needs closing off.

Two cases, and only one of them is hard.

**Same origin — one session, no exception.** Every app the shell loads from its own site shares the
one cookie session: the console, its dev-tools app, a deployment panel, a terminal. They are the
same origin, so they are the same session by construction. Nothing per-app happens at all, and any
design where a same-origin app authenticates separately is a bug.

**Cross origin — one sign-in, one credential per namespace.** A federated app served by another
site (`12-network-and-federation.md`) calls that site's API, and a cookie for A is not sent to B.
The old answer would have been `Access-Control-Allow-Credentials` with a cross-origin cookie;
third-party cookie restrictions in current browsers make that genuinely unreliable, not merely
discouraged.

So: **token exchange, not a second sign-in.**

1. The user signs in once, at the site serving the shell. That produces the ordinary cookie session
   above.
2. When the runtime first needs namespace `b`, it asks its *own* origin — not B —
   `POST /api/auth/namespace-token { namespace: 'b' }`, over the existing cookie session.
3. A's server mints a short-lived, audience-scoped token for B: signed, `aud: b`, minutes not days,
   carrying the user's identity and nothing else.
4. The runtime attaches it as `Authorization: Bearer` on calls to B, per namespace, and refreshes it
   when it expires.

Why this shape:

- **The credential never crosses an origin as a cookie**, so nothing depends on third-party cookie
  policy — which is the whole reason the naive version fails.
- **`aud` is enforced.** A token for `b` is rejected by `c`. A compromised remote gets a token it
  can only spend where it was already allowed to.
- **Short-lived and revocable at the source.** The exchange endpoint checks the session record on
  every mint, so revoking the session kills every downstream token within one expiry window.
- **B stays in control.** B decides whether it trusts A as an issuer and what a user from A may do.
  Federation is already an explicit allowlist on both sides; this is the same trust decision
  expressed as a key.
- **The user signs in once.** Which is the actual requirement.

The realistic deployment is one operator's own properties — a console, a client site, a storefront —
so A and B share an operator and key distribution is an internal matter, not a public federation
protocol. This is deliberately *not* a general SSO product: no OIDC dance, no consent screens, no
third-party issuers. If a genuinely third-party consumer ever appears, that is the point at which
real OIDC earns its complexity, and it can be added under the same seam.

**Deferred honestly:** token signing and key rotation are not built in Phase 1. Same-origin cookie
sessions are, and they cover every consumer that exists today. The exchange endpoint lands with the
first real federated deployment, and the shape above is what it will be.

## System callers

Some backend work legitimately acts as the service itself, not as a user — a cron sweep, a reconciler, a pipeline stage writing storage. The PaaS codebase has this gap on record today: `email/receive` fabricates storage refs and discards real bytes because `s3.object_put` requires an end-user bearer token and no first-party caller pattern exists (`spec/roadmap/future.md` B3), and it is flagged there as likely to recur elsewhere.

`mesh-api` does not solve this, and must not paper over it: **there is no "system user" that the exposure layer will ever mint.** Any such pattern must be a deliberate framework-level construct with its own audit story, not an escape hatch bolted onto the public API surface. Until it exists, a service needing it says so explicitly rather than borrowing a user's credentials.

## In the browser

Session is a reactive signal (`05-reactivity.md`) the runtime owns:

```ts
ctx.session.user()      // null when signed out
ctx.session.isAuthed()  // computed
```

Consequences that fall out for free, rather than being features anyone implements per app:

- A header widget showing the current user just reads the signal and re-renders on change.
- Sign-out anywhere updates every subscriber at once.
- A 401 from any API call resets the session signal, and the runtime handles it centrally — no app writes its own 401 branch.
- Apps whose manifest marks them as requiring auth are not loaded at all for an anonymous visitor. Not hidden — not loaded. Same reasoning as exposure policy: the thing that was never launched cannot leak.
