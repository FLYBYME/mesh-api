# Roadmap

Build order, open questions, and decisions already made. Same convention as `paas`: `[x]` closed items compress to one line, `[ ]` open items carry the context needed to act.

## Build order

Each phase produces something real and usable. Nothing is built on speculation about a later phase.

### Phase 1 — exposure (no UI yet) — **built** (2026-08-29)

- [x] **Contract → REST.** `mountRest` derives every route from `rest.method`/`rest.path`; params/query/body merge into one input; `MeshError` maps to status codes.
- [x] **Exposure policy.** `WebServiceModule.mountWeb({ expose })` with required per-entry `auth`. Nothing reachable unless listed; no wildcard. Route collisions throw at mount time.
- [x] **Contract → MCP.** One MCP tool per exposed contract, gated by the same `checkAuth`, so MCP is a second encoding of the `expose` list rather than a second reachability.
- [x] **Typed client codegen.** Self-contained emitter; the generated file carries zero zod and zero mesh imports, verified by compiling the output in a test.
- [x] **Auth and session.** Cookie sessions (HttpOnly/Secure/SameSite=Lax), server-side records, id rotation on login, CSRF on state-changing calls, the `meta.user` bridge, 401/403 handling.
- [x] **OpenAPI document**, generated from the same schemas.

Built by agy dispatches 1 and 2 (`agent-runs/`), then verified independently. What that verification caught, since none of it appeared in either dispatch's self-report:

- **A global type leak.** `rest.ts` augmented `IServiceToolRegistry` with an index signature to make a runtime-chosen tool key type-check. That is a declaration-merged global, so it applied to *every project importing this package*: `broker.call('kanban.card_craete', { nonsense: 1 })` compiled clean. An `as any` with unbounded blast radius, and harder to spot because it reads as a declaration. Replaced with `ExposureBroker` in `src/exposure/broker.ts` — one structural interface, package-local, which a real `IServiceBroker` satisfies.
- **Tests were never type-checked.** `tsconfig.json` covers only `src/**/*`, and vitest transpiles without type-checking, so a type error in a test could not fail anything. Three test files imported `../exposure/types.js` (a path that does not exist) and several unchecked `unknown` accesses sat behind casts. Added `tsconfig.check.json` + `npm run typecheck` covering `src` and `test`; fixed what it surfaced.
- **A vacuous test.** "a registered but NOT exposed contract is 404" asserted only the 404 — which a route that was never defined also returns, so deleting the contract entirely would have kept it green. It now asserts the contract is present in `registry.getTools()` *and* unreachable over HTTP. That gap is the exposure policy, and it is the one property this package exists to guarantee.

Still open in this area: SSE event exposure (`events` in `WebConfig` is declared but not yet served) — Phase 5.

### Phase 2 — reactivity and components

- [x] **Signals** (2026-08-29). `signal`/`computed`/`effect`, automatic tracking, dynamic dependencies, batching, glitch-free diamonds, lazy computeds, purity enforcement, `createScope` disposal. `src/runtime/reactivity/`, no dependencies — not zod, not mesh — so it costs a browser bundle nothing but itself.
- [x] **`resource`** (2026-08-29). Async signal with loading/error, refetch on dependency change, in-flight dedupe, out-of-order response discard, last-good-data retained on error.

**Effects are scheduled on a microtask, not run synchronously on write.** Writes in one tick coalesce into one flush; `flushSync()` forces it, and is what tests use. Worth stating plainly because a write followed immediately by an assertion reads as a bug and is not one.

Verified with an independent adversarial suite (`test/reactivity.adversarial.test.ts`) written against the properties that are easy to claim and hard to get right, rather than by re-reading the dispatch's own tests: the diamond running exactly once and never on a mixed pair, an effect unsubscribing from a branch it stopped reading, a nested effect being disposed instead of leaking one instance per outer run, a stale response losing to a newer one. All held.
- [ ] **`h()` and control flow.** Real DOM creation, function-as-binding, `When`, keyed `For` that moves rather than rebuilds nodes.
- [ ] **Core components.** Only what the kanban board needs. Grow on demand.
- [ ] **Tokens and theming.** Light/dark via CSS custom properties, explicit override.

### Phase 3 — runtime

- [ ] **Compositor, surfaces, roles.** Placement policy from the manifest; explicit grant/refusal.
- [ ] **App lifecycle.** Load/foreground/background/unload, hooks, dev-mode leak assertions.
- [ ] **Per-app state containers.** Isolated, disposed on unload; `persisted` namespaced per app.
- [ ] **Router.** History API, app-level then view-level, params/query as signals, scroll and focus restoration.
- [ ] **Manifest.** Zod-validated YAML, load strategies, auth gating, environment overlays.

### Phase 4 — kanban, for real

- [ ] Rebuild the kanban UI on the framework per `11-example-kanban.md`, and **use it daily** to track agy dispatches. Gaps surface by being lived with, not by being reviewed.

### Phase 5 — the network layer

- [ ] **SSE event bridge.** `GET /api/events?topics=…` returning `text/event-stream`. Explicit topic exposure, server-side `scope` enforcement at fan-out. Plain HTTP throughout.
- [ ] **WebSocket, narrowly.** Only for genuinely bidirectional sessions (terminal). Carries no RPC; reaches no contract not already reachable over REST.
- [ ] **HTTP correctness.** `ETag`/`If-None-Match` on reads, correlation-id header end to end, consistent `{ error: { code, message } }` bodies from `MeshError`.
- [ ] **Namespaces as base URLs.** Per-namespace client, credential, and generated types. Router prefixes remote apps' URLs; an app's namespace is its default API target.
- [ ] **Per-namespace connection management.** SSE backoff with jitter, refetch-on-reconnect, per-namespace state signal, one namespace's outage degrading only its own apps.

### Phase 5b — federation

- [ ] **App catalog** published per site; bundles built to run under a foreign shell (host-provided runtime, not bundled).
- [ ] **`remotes` in the manifest** — explicit per-app allowlist, required SRI, pinned versions, consumer-chosen namespace alias.
- [ ] **Narrow CORS** for named consuming origins; never `*`.
- [ ] Real cross-site test: two services on two origins, one loading the other's app, with the remote's surfaces going through the host's compositor.

### Phase 6 — console-scale

- [ ] **Task switcher.** Hotkey, background preservation, URL correctness across switches.
- [ ] **Command palette.**
- [ ] **Dev tools app** — signal graph inspection, app states, API call log. Ships in production behind `auth: admin`.
- [ ] **Form generation from contracts** — one schema for client and server validation.
- [ ] **Virtualised table** for large data sets.

### Later, deliberately deferred

- [ ] **SSR.** Only when a real public-facing, indexable consumer exists (storefront, blog). Not needed for the console. Architecture is compatible; building it now would be speculative.
- [ ] **Offline / service worker.** No demonstrated need.
- [ ] **i18n.** Same.

### Phase 1 follow-up

- [ ] **Port `kanban` onto this package.** Its hand-written gateway (`/home/ubuntu/code/kanban/src/gateway/`) is now redundant, and it exposes every registered contract with no gate — exactly what the exposure policy forbids. First real consumer, and the honest test of whether `mountWeb` is pleasant to use.
- [ ] **`z.date()` across the JSON boundary.** The client emitter maps it to a TS type, but JSON has no date: what actually crosses the wire is a string, and nothing currently reconciles the two. Decide (ISO strings end to end, most likely) before a contract in production depends on the answer.
- [ ] **MCP transport auth.** `buildMcpServer` takes a session or a session accessor and applies the same gate as REST, which is right. How an MCP client *obtains* a session is unanswered — it carries no browser cookie. Needs deciding before MCP is exposed anywhere but locally.

## Open questions

- [ ] **System caller pattern.** Backend services acting as themselves rather than as a user (paas B3). Explicitly *not* solved by minting a fake system user. Needs its own design with a real audit story.
- [ ] **Child app composition details.** Apps nest recursively, but the parent↔child surface protocol is unspecified: does a child request surfaces from its parent's granted region, or from the compositor with the parent as context? Resolve before building the first nested case (cart inside a storefront).
- [ ] **Mesh swallows validation failures into 500s.** `ServiceBroker.call` parses params with the contract's `inputSchema` and, on failure, throws a plain `Error("[ServiceBroker] Invalid params for tool X: <ZodError>")` (`src/core/ServiceBroker.ts`). A plain `Error` has no `status`, so a caller's malformed input surfaces as a 500 with an opaque message — wrong status, and the message is unsafe to forward since it may carry internal detail. `mesh-api` works around it by validating at the boundary with the contract's own schema (not a second schema) to produce a real 400. The right fix is in mesh core: throw `ClientError` (which already exists, and already carries status 400) instead of `Error`. Raise against `mesh`, not this package.
- [ ] **Version skew across federation.** A pinned remote bundle expects a runtime API from the host shell. If the host upgrades its shell and the remote's pinned bundle expects the old one, what breaks and how loudly? Needs a compatibility contract between shell and app bundles — probably a declared runtime-API version in the catalog, checked at load.

## Decisions already made

- [x] **One package, not two.** An earlier `mesh-api` + `mesh-web` split was scaffolded and deleted. UI is a feature you enable on the API, not a separate client architecture.
- [x] **The package is `mesh-api`** (2026-08-28). The name stays and its meaning broadens: the API package, of which web/UI is a feature. Not renamed to `mesh-app`/`mesh-web`.
- [x] **`mountWeb` lives in this package, not mesh core** (2026-08-28). A service imports `mesh-api` and mounts it explicitly. Mesh core stays free of express/MCP/bundler dependencies, so a headless service (a weather microservice, a reconciler) pays nothing for a UI it never serves. Cost is one import line.
- [x] **One client per deployment, namespaced by contract domain** (2026-08-28). Not a real decision so much as a consequence of how mesh already works: `Registry.getTools()` returns every contract on the broker, contracts are already namespaced (`dns.record_create`, `kanban.card_create`), and mesh forbids two `ServiceModule`s sharing a domain — so collisions are impossible. A single `mountWeb` on a process hosting many services exposes all of them under one client. Cross-*deployment* clients are a separate, deferred question (see above).
- [x] **The browser never joins the mesh as a peer.** Three concrete reasons in `00-overview.md`: total contract reachability, gossip leaking the full catalog, and node-vs-user trust mismatch. Not revisitable without solving all three.
- [x] **The API is standard HTTP REST, and there is no second protocol** (2026-08-28, `12-network-and-federation.md`). A custom mesh client transport was specced and then **reversed the same day**. It was technically appealing — `ITransport` is five methods, `IMeshPacket` already carries `type` and `streamID` — but it bought a private protocol for our own UI, which makes REST the second-class surface nobody dogfoods, and it would have tunnelled past the platform's own proxy, access logging, and caching. The under-weighted fact that settles it: **SSE is already standard HTTP**, so server push needs no custom protocol at all; only genuinely bidirectional sessions (a terminal) need WebSocket. The runtime uses the same REST API as every other client.
- [x] **One sign-in; cross-origin credentials are exchanged tokens, not second logins** (2026-08-29, `02-auth-and-session.md`). Same-origin apps share the one cookie session by construction — an app authenticating separately there is a bug. Cross-origin, A's own server exchanges the user's session for a short-lived `aud`-scoped token for B, sent as `Authorization: Bearer` per namespace. Chosen because the credential never crosses an origin as a cookie (so third-party cookie policy is irrelevant), `aud` confines a leaked token to where it was already allowed, and revoking the session kills downstream tokens within one expiry. Deliberately not general SSO: A and B share an operator. Token signing and key rotation are Phase 5b work, not Phase 1.
- [x] **Namespaces are one concept with three consequences** (2026-08-28): which site an app came from, which backend it talks to by default, and where it lives in the URL. With REST a namespace is simply a base URL — it survived the transport reversal unchanged, which is a fair sign it was the right abstraction independent of the mechanism.
- [x] **Federation is explicit, pinned, and allowlisted** (2026-08-28). Per-app entries, required SRI, pinned versions, consumer-chosen namespace alias. Recorded plainly: loading a remote's JavaScript grants it full control of the page, and these controls guarantee the code is *what was approved*, not that it is *safe*. Real isolation (iframe/Worker) is deliberately out of scope until a genuinely untrusted case exists.
- [x] **No React, no JSX, no virtual DOM.** A vDOM makes full re-renders cheap; fine-grained reactivity removes full re-renders. Paying for the former to solve what the latter already fixed is a bad trade.
- [x] **Fine-grained reactivity, not re-render.** Directly replaces `mesh-ui`'s `updateProps()` `innerHTML` wipe.
- [x] **Zero `as any` / `as unknown as` / `as never`.** `mesh-ui`'s `getChildren()` returning `element.children` cast to `BaseComponent[]` is a real runtime bug, and the reason this rule is absolute.
- [x] **Apps never place themselves.** Wayland's client/compositor split, adopted specifically because extensions showing up in unexpected places was a real observed `mesh-ui` problem.
- [x] **Surface requests can be refused.** Previously an open question. Refusal is a normal, explicit outcome apps must handle.
- [x] **No global store.** State is per-app and isolated. Consequently no time-travel/middleware/reducer machinery either.
- [x] **Real URLs, History API only.** No hash routing.
- [x] **Nothing exposed by default.** Explicit `expose` lists with required per-entry `auth`.
- [x] **Client-side auth gating is UI shaping, never enforcement.** Real checks are server-side, on every call.
- [x] **Authorization scope: the public boundary only** (2026-08-28). `mesh-api` gates what is reachable from outside; per-record checks stay in handlers where the data is. The framework-wide `permissions: string[]` + role-glob + broker-gate design in `docs/03-mesh-conventions.md` (paas B15, 1,130 unguarded cross-domain raw CRUD calls) stays a separate mesh-core project — real, still open, but not blocking this package.
