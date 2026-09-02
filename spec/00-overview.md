# 00 — Overview

`mesh-api` is the one package you add to a mesh service when you want it to face the outside world: a real HTTP/MCP API, and a real browser UI. Both halves, one package, one set of conventions.

## The rule this package exists to enforce

You do it one way, no questions asked. A contract is defined one way. View state is managed one way. An app is loaded one way. There is no configuration menu of competing approaches, no "or you could use X instead" — where a choice exists, this spec picks it and everything downstream assumes it.

This is deliberate and it is the whole point. The alternative — every project re-deriving its own frontend architecture, its own API conventions, its own state model — is what makes ten years of projects ten unrelated codebases instead of one accumulating body of work.

## Scope

Every future project is a mesh app: a kanban board, a trading bot, a store website, a blog with a forum, an admin console, a client site, a weather microservice that wants a UI. `mesh-api` must hold up as a genuinely general-purpose application framework, not as PaaS-specific infrastructure that happens to be reusable. Where a design choice would only make sense for the PaaS console, it is the wrong choice.

## The two halves

**Exposure** (`01-exposure.md`) — turns mesh contracts into a real outside-facing API. Thin by design: "the api is just a mesh translator with standard auth stuff." It does not add business logic, its own resource model, or a second schema language. It reads the `ToolContract`s already registered on the broker and projects them into REST, MCP, and a generated typed client.

**Runtime** (`03-runtime-model.md` onward) — the browser-side application framework: an OS-like host that loads, runs, backgrounds, and unloads independent Apps inside one real HTML5 page.

These are not two packages and not two products. The UI is **built in and first class**: a mesh service enables `web` the same way it mounts a tool or a CRUD collection today. An earlier iteration of this design split them into `mesh-api` (exposer) and `mesh-web` (separate UI framework consuming the exposed REST as an external client). That split was rejected: it forced every UI project to re-solve wiring the two together, and made the UI a second-class client of its own backend instead of a native feature of it.

**The package keeps the name `mesh-api`, with its meaning broadened**: the API package, of which web is a feature. And `mountWeb` lives here, not in `@flybyme/mesh` core — so mesh core stays free of express/MCP/bundler dependencies and a headless service (a reconciler, a weather microservice with no UI) pays nothing for a feature it never uses. The cost is one import line in a service that does want the web.

## Hard boundary: the browser never joins the mesh

`@flybyme/mesh` ships real browser transports (`BrowserWebSocketTransport`, `HTTPTransport`, `WebRTCTransport`). A browser page *could* join the mesh network directly as a peer. **It must not, and this framework will not offer it as an option.**

Three real reasons, not stylistic:

1. **Every contract would be reachable.** A mesh peer can call any tool the registry knows about. Today that includes every auto-generated CRUD action on every collection on every node. The PaaS codebase has already measured this problem from the inside: 1,130 cross-domain calls to raw `find`/`create`/`update`/`delete`, across 74 services, with no permission boundary of any kind (`spec/roadmap/future.md` B15). The per-contract `permissions` design exists in `docs/03-mesh-conventions.md` but has never been built. Handing that surface to a browser is handing it to the public.
2. **Gossip leaks the catalog.** The P2P layer broadcasts each node's full contract catalog — every tool, with `zodToJsonSchema`-rendered params and returns — to its peers on a timer. A browser peer receives a complete map of the internal system.
3. **Trust model mismatch.** Mesh's own auth interceptors (`AuthInterceptorHMAC`, `AuthInterceptorEd25519`) authenticate *nodes* with a shared secret or keypair — infrastructure identity. Nothing shippable to a browser can hold that secret. End-user identity is a different problem, solved at the exposure layer (`02-auth-and-session.md`).

So: the browser speaks **standard HTTP REST** to a gateway that authenticates the end user, checks what that user is allowed to reach, and translates into a `broker.call` on the user's behalf. That translation boundary is the only way in. This is what "not direct mesh access" means, and it is load-bearing.

**The API is REST, and there is no second protocol** (`12-network-and-federation.md`). The runtime uses the same API as every other client — no privileged channel for our own UI. Live updates are server-sent events, which are themselves standard HTTP; WebSocket appears only for genuinely bidirectional sessions such as a terminal, and carries no RPC. A custom mesh transport was considered and rejected: it would have made REST a second-class surface that drifts, and would have tunnelled past the platform's own proxy, access logging, and caching.

## What the framework owns vs. what an app owns

The framework owns: page chrome (header, sidebar, footer), routing and URL correctness, browser history, session, app lifecycle, placement of everything on screen, and the transport to the backend.

An app owns: its own views, its own state, its own contracts. It never positions itself on screen, never writes chrome, never reaches for another app's state.

## File map

| File | Covers |
|---|---|
| `01-exposure.md` | Contract → REST/MCP/typed client. Exposure policy. |
| `02-auth-and-session.md` | End-user identity, sessions, `meta.user`, authorization. |
| `03-runtime-model.md` | The OS model: App, Surface, Role, compositor, placement. |
| `04-lifecycle.md` | Load, foreground, background, unload. State ownership. |
| `05-reactivity.md` | Signals: the substrate everything reactive is built on. |
| `06-components.md` | Component model. Real HTML/TS/CSS. |
| `07-routing.md` | Router, URL structure, views inside a page surface. |
| `08-data.md` | Typed client, live data, streams, cache. |
| `09-manifest.md` | The YAML manifest: which apps load, and how. |
| `10-build-and-serve.md` | Bundling, dev loop, serving from a mesh service. |
| `11-example-kanban.md` | One worked example, end to end. |
| `12-network-and-federation.md` | REST as the one API, namespaces, multi-site federation. |
| `13-applications-and-extensions.md` | Application vs Extension, capability context, platform services, shell profiles, the view manager. |
| `roadmap.md` | Build order, open questions, decisions not yet made. |
