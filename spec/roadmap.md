# Roadmap

Build order, open questions, and decisions already made. Same convention as `paas`: `[x]` closed items compress to one line, `[ ]` open items carry the context needed to act.

## Build order

Each phase produces something real and usable. Nothing is built on speculation about a later phase.

### Phase 1 — exposure (no UI yet)

- [ ] **Contract → REST.** Generic route mounting from `rest.method`/`rest.path` over `Registry.getTools()`. Merge params/query/body into one input; let `inputSchema` validate. `MeshError` → status codes.
- [ ] **Exposure policy.** `mountWeb({ expose: [...] })` with required per-entry `auth`. Nothing reachable unless listed; no wildcard.
- [ ] **Contract → MCP.** One MCP tool per exposed contract. Generic — no domain knowledge in the adapter. *(A working prototype of this exists in `/home/ubuntu/code/kanban/src/gateway/mcp.ts` — it iterates the registry, requires `z.object` inputs, and calls `broker.call`. Lift and generalise it rather than rewriting.)*
- [ ] **Typed client codegen.** Plain fetch + types, zero zod/mesh in the browser bundle.
- [ ] **Auth and session.** Cookie sessions, server-side records, CSRF, `meta.user` bridge, 401 handling.

Deliverable: any mesh service gets a real authenticated API and MCP surface. Kanban stops needing its hand-written gateway.

### Phase 2 — reactivity and components

- [ ] **Signals.** `signal`/`computed`/`effect`, automatic tracking, batching, glitch-free reads, disposal via `ctx.state`. Tests must prove fine-grained updates: assert that updating one bound value touches exactly one DOM node and does not recreate siblings — the specific defect being replaced.
- [ ] **`resource`.** Async signal with loading/error, refetch-on-dependency-change, in-flight dedupe.
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

### Phase 5 — live data

- [ ] **SSE bridge for mesh events.** Explicit exposure, server-side `scope` enforcement at fan-out.
- [ ] **Reconnect handling.** Backoff, refetch-on-reconnect, connection-state signal.
- [ ] **WebSocket transport** for genuinely bidirectional cases (terminal).

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

## Open questions

- [ ] **System caller pattern.** Backend services acting as themselves rather than as a user (paas B3). Explicitly *not* solved by minting a fake system user. Needs its own design with a real audit story.
- [ ] **Child app composition details.** Apps nest recursively, but the parent↔child surface protocol is unspecified: does a child request surfaces from its parent's granted region, or from the compositor with the parent as context? Resolve before building the first nested case (cart inside a storefront).
- [ ] **Cross-deployment clients.** A console at one origin talking to a *separately deployed* service at another (e.g. a standalone kanban). Different base URL, different session cookie, CORS, independently versioned schemas — the cross-origin auth story is the hard part. Deferred deliberately until a real consumer needs it, so it gets designed against a real requirement. **Not** the same as the single-deployment case, which is already settled below.

## Decisions already made

- [x] **One package, not two.** An earlier `mesh-api` + `mesh-web` split was scaffolded and deleted. UI is a feature you enable on the API, not a separate client architecture.
- [x] **The package is `mesh-api`** (2026-08-28). The name stays and its meaning broadens: the API package, of which web/UI is a feature. Not renamed to `mesh-app`/`mesh-web`.
- [x] **`mountWeb` lives in this package, not mesh core** (2026-08-28). A service imports `mesh-api` and mounts it explicitly. Mesh core stays free of express/MCP/bundler dependencies, so a headless service (a weather microservice, a reconciler) pays nothing for a UI it never serves. Cost is one import line.
- [x] **One client per deployment, namespaced by contract domain** (2026-08-28). Not a real decision so much as a consequence of how mesh already works: `Registry.getTools()` returns every contract on the broker, contracts are already namespaced (`dns.record_create`, `kanban.card_create`), and mesh forbids two `ServiceModule`s sharing a domain — so collisions are impossible. A single `mountWeb` on a process hosting many services exposes all of them under one client. Cross-*deployment* clients are a separate, deferred question (see above).
- [x] **The browser never joins the mesh.** Three concrete reasons in `00-overview.md`: total contract reachability, gossip leaking the full catalog, and node-vs-user trust mismatch. Not revisitable without solving all three.
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
