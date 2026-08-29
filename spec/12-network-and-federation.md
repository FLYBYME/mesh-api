# 12 — Network layer, namespaces, and federation

The runtime has a real network layer: multiple namespaced backends, live updates, and cross-site federation. It is built on **standard HTTP REST**, and there is exactly one API.

## The API is standard HTTP REST. There is no second protocol.

One surface, standard in every respect: standard verbs, standard status codes, standard headers, standard content types, an OpenAPI document that describes all of it. Reachable with `curl`, a browser address bar, Postman, any HTTP client in any language.

**The runtime uses exactly the same API as everyone else.** No privileged channel for the framework's own UI. This is a deliberate constraint, and it is load-bearing for two reasons:

1. **It keeps REST honest.** A framework whose own UI speaks a private protocol inevitably lets the public API rot — under-tested, half a version behind, its gaps discovered by outsiders. If our UI is the heaviest REST consumer, drift is felt immediately, by us.
2. **It stays inside your own infrastructure.** The platform's proxy/edge terminates and logs real HTTP. A custom WebSocket protocol tunnels past access logging, caching, routing, and every standard debugging tool. Being ordinary HTTP means the existing infrastructure works, unchanged.

A previous revision of this spec proposed a custom mesh transport as the runtime's channel, with REST as a parallel public surface. **That is reversed.** The transport idea was technically elegant — `ITransport` is five methods, `IMeshPacket` already carries `type` and `streamID` — but elegance bought a private protocol, a second-class REST API, and infrastructure bypass. Not worth it. "One way, no questions asked" (`00-overview.md`) means one API, and the API is REST.

## Verbs, status, and shape

Contracts already declare `rest: { method, path }`, so routes come straight from them (`01-exposure.md`).

- `GET` for reads, safe and cacheable. Query params for filters.
- `POST` for actions and creates. `PUT`/`PATCH`/`DELETE` where a contract genuinely maps to them.
- Status codes from `MeshError`'s existing `status` field — 400, 401, 403, 404, 409, 500 — which the codebase already sets correctly via `notFound`/`badRequest`/`conflict`.
- Errors are a consistent JSON body: `{ error: { code, message } }`, with `code` from `MeshError`.
- `ETag`/`If-None-Match` on reads, so unchanged data costs a 304 and real HTTP caching does real work.
- `correlationId` travels as a request header and appears in logs on both sides — tracing without a bespoke envelope.

HTTP/2 multiplexes concurrent requests over one connection, which removes the main practical argument for a custom framed protocol.

## Live updates: SSE, and it is still standard HTTP

Server-sent events are plain HTTP — a `GET` returning `text/event-stream`. No protocol upgrade, no special infrastructure, works through ordinary proxies, reconnects natively.

```
GET /api/events?topics=card.created,card.updated
Accept: text/event-stream
```

The gateway authenticates the session, checks the requested topics against the explicitly exposed event list, enforces `scope` server-side at fan-out (`08-data.md`), and streams matching events. Same session, same auth, same origin as every other call.

Long-running one-way reads — a log tail, a metrics feed — are the same mechanism.

## WebSocket, only where genuinely bidirectional

One real case today: an interactive terminal, where the client sends keystrokes and resize events while the server streams output. SSE cannot do that, and pretending otherwise would mean inventing a side channel.

So WebSocket is used **only** for genuinely bidirectional sessions, declared per capability rather than offered as a general transport:

```
GET /api/ws/terminal   (Upgrade: websocket)
```

It authenticates with the same session, and it is not an alternative route to the REST API — no RPC is carried over it, and no contract is reachable there that is not reachable over REST.

## Namespaces

A **namespace** identifies one site's API. With REST this is simply a base URL:

```
local  →  /api                          (the site serving this page)
b      →  https://b.example.com/api     (a remote site, aliased locally as `b`)
```

The generated client is namespaced to match:

```ts
await ctx.api.kanban.card_create({ ... });      // local
await ctx.api.b.shop.cart_add({ ... });         // remote site `b`
```

The alias is chosen by the **consuming** site in its manifest, never by the remote, so two remotes cannot collide locally regardless of what they call themselves.

Each namespace has its own base URL, its own credential, and its own generated client types. Auth does not leak across namespaces — a session on A says nothing about B.

## Namespace-aware routing

Same namespace, applied to URLs. Remote apps are mounted under a prefix so two sites' routes cannot collide:

```
/kanban/card/abc      → local app
/b/shop/product/xyz   → app from namespace `b`
```

The mount point is set by the consuming site's manifest. An app does not know it is prefixed — it routes within its own subtree exactly as it would at home (`07-routing.md`).

**An app's namespace is its default API target.** An app served by `b` calls `b`'s API without asking. Reaching another namespace requires naming it.

One concept, three consequences: which site an app came from, which backend it talks to, and where it lives in the URL.

## Cross-origin

Talking to another origin's REST API needs CORS done properly, and this is where "standard HTTP" has to be paid for honestly rather than hand-waved:

- The remote allows the consuming origin explicitly. A **named list, never `*`** — consumers are declared in manifests, so the list is always known.
- `Access-Control-Allow-Credentials: true` with credentialed requests, if sessions are cookie-based across origins.
- Preflight caching (`Access-Control-Max-Age`) so `OPTIONS` is not paid per request.
- Third-party cookie restrictions in modern browsers make cross-origin cookie sessions genuinely unreliable. **A token-based credential per namespace is the realistic answer** for cross-origin, with cookies remaining correct for same-origin. Exactly how a user's session on A becomes a credential for B is an open question (`roadmap.md`) and must be settled before the first real federated deployment — not improvised at build time.

## Federation: loading apps from another site

For site A to run site B's app, B publishes and A opts in.

**B publishes** a catalog alongside its bundles (`10-build-and-serve.md`):

```
GET https://b.example.com/apps/catalog.json
{
  "site": "b",
  "runtimeApi": "1.x",
  "apps": [
    { "id": "shop", "version": "1.4.2", "module": "/assets/shop-a91f3c.js",
      "integrity": "sha384-…", "surfaces": ["page", "panel"] }
  ]
}
```

**A opts in**, per app, in its manifest (`09-manifest.md`) — explicit allowlist, pinned SRI, pinned version, locally chosen namespace alias.

B's `shop` app then runs inside A's page: its surfaces go through A's compositor under A's layout policy, its routes live under `/b`, and its API calls go to B's REST API.

## Federation is a trust decision, stated plainly

**Loading another site's JavaScript gives that site complete control of this page** — same origin, same DOM, same session, same everything. There is no partial version of this.

Mandatory mitigations: per-app allowlist (no wildcards), pinned Subresource Integrity (a changed bundle does not execute), CSP naming the permitted origins, pinned versions upgraded deliberately.

And the honest limit: these guarantee the code is *what was approved*. They do not make it *safe*. Federate with properties you actually control. The realistic case is one operator's own sites — a console embedding a client-site admin panel, a storefront embedding a shared cart — not a third-party marketplace.

Real isolation would mean an iframe or Worker, at the cost of DOM access and the composition model this framework is built on. That is deliberately out of scope until a genuinely untrusted case exists, rather than half-built now.

## Connection management

Owned by the runtime, per namespace:

- SSE reconnects with exponential backoff and jitter; on reconnect, affected resources refetch, since events missed while disconnected cannot be replayed.
- A per-namespace connection-state signal lets chrome show a real indicator, and lets one site's outage degrade only its own apps.
- A remote namespace being unreachable must never take down the local one.
- `background`-role apps (`03-runtime-model.md`) keep their subscriptions across task switching.
