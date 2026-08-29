# 12 — Network layer, namespaces, and federation

The runtime has a real network layer, not a pile of fetch calls. It is built as a **custom mesh transport**, so one connection carries RPC, events, and streams, and one client can be connected to several sites at once.

## Why a transport, and why this does not break the boundary

`00-overview.md` states the browser never joins the mesh, for three reasons: total contract reachability, gossip leaking the full catalog, and node-vs-user trust mismatch.

Those are objections to the browser being a **peer**. None of them is an objection to it speaking mesh's **protocol**. The distinction matters because mesh's own structure keeps them separate:

- `ITransport` is five methods — `connect`, `disconnect`, `send`, `onMessage`, `onError`. It moves packets. It grants nothing.
- Gossip is not in the transport. `MeshOrchestrator.broadcastPresence()` runs on its own 15s interval and only reaches nodes in the orchestrator's peer set. A connection that is never added to that set never receives a catalog.
- Reachability is decided by whoever handles an inbound REQUEST, not by the wire format.

So: **the browser holds a client transport, not a peer connection.** It is terminated server-side by a gateway that authenticates the session, enforces exposure policy per packet, attaches `meta.user`, and calls the broker. The browser never enters the peer set, never receives presence or catalog packets, and can reach exactly the contracts `expose` lists — the same policy that governs REST (`01-exposure.md`), enforced at the same place.

The security properties are identical to the REST design. What changes is that one protocol now carries everything.

## What this buys

**One channel for RPC, events, and streams.** `IMeshPacket` already has `type` (`REQUEST`/`RESPONSE`/`EVENT`/…) and `streamID`. Request/response, event push, and streaming are already distinct packet shapes in the protocol — so the separate SSE-plus-WebSocket-plus-fetch arrangement in `08-data.md` collapses into one connection that already knows how to do all three.

**Correlation, tracing, and errors for free.** `correlationId`, `MeshError` payloads, and the `meta` tracing fields already travel in the packet. No re-invention at the HTTP layer.

**Multiple sites, natively.** `BasePacket.namespace` already exists, and `IMeshNetwork` already carries a `namespace`. Routing a call to the right site is a field that is already in the protocol.

## Namespaces

A **namespace** identifies one site's API surface. The runtime holds a connection per namespace and routes by it.

```
local   →  wss://a.example.com/mesh    (the site serving this page)
b       →  wss://b.example.com/mesh    (a remote site, aliased locally as `b`)
```

Calls are namespaced, and the typed client reflects it:

```ts
await ctx.api.kanban.card_create({ ... });      // local namespace
await ctx.api.b.shop.cart_add({ ... });         // remote site `b`
```

The alias is chosen by the **consuming** site in its manifest, not by the remote. Site A decides what to call site B locally, so two remotes can never collide in A's client regardless of what they call themselves.

Each namespace has its own connection, its own session/credential, and its own generated client types. Auth does not leak across namespaces — being signed in to A says nothing about B.

## Namespace-aware routing

The URL router is namespace-aware, and it is the same namespace. An app loaded from a remote site gets a URL prefix, so two sites' apps cannot collide in the address bar:

```
/kanban/card/abc          → local app
/b/shop/product/xyz       → app from namespace `b`
```

The manifest sets the mount point (`09-manifest.md`). Within its prefix an app routes exactly as before (`07-routing.md`) — it does not know or care that it is mounted under a prefix, and the same app code runs unprefixed on its own site.

**An app's namespace is its default API target.** An app loaded from `b` calls `b`'s backend by default without asking; that is the sane default, since an app shipped by a site expects to talk to that site. Reaching another namespace requires naming it explicitly.

This gives one coherent meaning to "namespace": *which site this came from, which backend it talks to, and where it lives in the URL* — one concept, three consequences.

## Federation: loading apps from another site

For site A to run site B's app, B must publish it and A must opt in.

**B publishes** an app catalog alongside its bundles (`10-build-and-serve.md`):

```
GET https://b.example.com/apps/catalog.json
{
  "site": "b",
  "apps": [
    { "id": "shop", "version": "1.4.2", "module": "/assets/shop-a91f3c.js",
      "integrity": "sha384-…", "surfaces": ["page", "panel"] }
  ]
}
```

**A opts in**, per app, in its own manifest:

```yaml
remotes:
  - namespace: b
    origin: https://b.example.com
    mount: /b
    apps:
      - id: shop
        integrity: "sha384-…"     # pinned; a changed bundle fails to load
```

Then B's `shop` app runs inside A's page: its surfaces go through A's compositor under A's layout policy, its routes live under `/b`, and its API calls go to B.

## Federation is a trust decision, and the spec says so plainly

**Loading another site's JavaScript gives that site complete control of this page.** Same origin, same DOM, same cookies for this origin, same session. There is no partial version of this.

Mitigations, all mandatory:

- **Explicit allowlist per app.** No wildcard remotes, no "load whatever B offers." Adding a remote app is a reviewed change to A's manifest.
- **Subresource Integrity, pinned.** The manifest pins a hash; a bundle that does not match does not execute. B cannot silently ship different code into A.
- **CSP** listing exactly the permitted remote origins.
- **Version pinning, with explicit upgrades.** Federation across an unannounced upgrade is how a working site breaks at 3am.

And the honest limit: these controls make the code *what you approved*; they do not make it *safe*. Federate with a site you actually control or genuinely trust. The realistic case here is one operator's own properties — a console embedding a client-site admin panel, a storefront embedding a shared cart — not third-party marketplaces.

An iframe or Worker would give real isolation, at the cost of DOM access and the composition model this framework is built on. If a genuinely untrusted federation case appears, that is the design to reach for — it is deliberately out of scope now rather than half-built.

## Connection management

Owned by the runtime, uniformly across namespaces:

- One multiplexed connection per namespace; all apps on that namespace share it.
- Exponential backoff with jitter on drop; per-namespace connection-state signal for chrome to display.
- On reconnect, resources on that namespace refetch — events missed while disconnected cannot be replayed.
- A namespace being down degrades only its apps. A remote site going away must never take down the local one.
- `background`-role apps (`03-runtime-model.md`) keep their subscriptions across backgrounding; the connection is not torn down on task switch.

## REST and MCP still exist

The transport is the **runtime's** channel. REST, MCP, and OpenAPI (`01-exposure.md`) remain the public, standards-facing surface: MCP clients, external integrations, `curl`, webhooks, anything that is not this framework.

Both encodings are fed by the same `expose` list and the same session auth. That is not duplication — it is one policy-gated surface with two encodings, and the policy is defined once.
