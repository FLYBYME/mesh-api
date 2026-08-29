# 08 — Data: typed client, live updates, streams

How an App talks to the backend. One way, generated, typed end to end.

## The client

Every App receives `ctx.api` — the generated typed client (`01-exposure.md`), scoped to what that App is allowed to call:

```ts
const { cards } = await ctx.api.kanban.board_list({ repo: 'paas' });
```

**One client per deployment, namespaced by contract domain.** This falls out of how mesh already works rather than being a design choice: `Registry.getTools()` returns every contract on the broker, contracts are already namespaced (`kanban.card_create`, `dns.record_create`), and mesh forbids two `ServiceModule`s sharing a domain — so a process hosting many services exposes all of them under one client with no possibility of collision. A console talking to a *separately deployed* service at another origin is a different, deferred problem (`roadmap.md`).

Types come from the contract's own zod schemas via codegen. Renaming a field in a contract breaks the build in every App that used it — which is the point, and is only possible because there is one schema rather than a server schema and a hand-maintained client type.

The generated client is plain `fetch` plus types. **No zod, no mesh imports in the browser bundle** — the boundary from `00-overview.md` holds at the dependency level, not just by convention.

## Reads

Almost always through `resource` (`05-reactivity.md`), which handles loading and error states and re-fetches when its inputs change:

```ts
const repo = ctx.state.signal('paas');
const board = resource(() => ctx.api.kanban.board_list({ repo: repo() }));

// board.loading() / board.error() / board.data()
```

Changing `repo` refetches. No manual invalidation, no dependency array.

## Writes

Direct calls. After a successful write, either refetch the affected resource or apply the returned entity locally — the contracts in this codebase already return the updated object, so a refetch is usually unnecessary:

```ts
const { card } = await ctx.api.kanban.card_claim({ cardId });
board.patch(cards => cards.map(c => c.id === card.id ? card : c));
```

**Optimistic updates are opt-in, never default.** They are correct for high-latency, low-stakes interactions (drag-and-drop reordering) and wrong for anything whose failure the user must see. The default is: call, await, apply the real result.

## Live updates

Three mechanisms, in order of preference. Use the simplest that fits — the console genuinely needs the heavier ones; a storefront genuinely does not, and should not pay for them.

**1. Polling.** A `resource` with an interval. Correct for slow-changing data. The kanban board polls every few seconds and that is the right answer for it. Backgrounded Apps throttle their polling (`04-lifecycle.md`).

**2. Server-sent events.** One-way server→client push over plain HTTP. The right default for log tails, metrics, status changes, and anything else where the client only listens. Reconnects automatically, works through proxies, needs no special infrastructure.

**3. WebSocket.** Bidirectional, for genuinely interactive sessions — a live terminal being the real case. Used only where two-way traffic is actually required.

All three surface identically to an App: a signal that updates over time.

```ts
const logs = ctx.api.stream.logs({ deploymentId });   // SSE under the hood
logs.data()       // Signal<LogLine[]>
logs.connected()  // Signal<boolean>
```

A component rendering a live log tail and one rendering a static list are written the same way.

## Mesh events → the browser

Mesh services already emit real per-domain events (`card.created`, `dnsRecord.updated`, and so on — the PaaS codebase completed its migration off the generic `data.*` bus, and every subscriber now uses specific named events). Those events are the natural source for live UI updates.

The exposure layer can bridge selected events to subscribed browser clients over SSE. **Selected, explicitly, exactly like contract exposure** — an event stream is a read API, and auto-bridging every internal event to browsers would leak the whole system's activity to anyone who connects:

```ts
this.mountWeb({
  expose: [ ... ],
  events: [
    { event: 'card.created', auth: 'user', scope: 'org' },
    { event: 'card.updated', auth: 'user', scope: 'org' },
  ],
});
```

`scope` decides who receives a given event. `org` means only clients whose session belongs to the event's org — enforced server-side at fan-out, never by filtering in the browser.

## Connection loss

Handled by the runtime, once, not per App:

- Streams reconnect with exponential backoff and jitter.
- On reconnect, affected resources refetch, because events missed while disconnected cannot be replayed.
- A global connection-state signal lets chrome show a real "reconnecting" indicator.
- A 401 anywhere resets session (`02-auth-and-session.md`).

## Caching

Deliberately minimal: `resource` caches its last value and dedupes concurrent identical in-flight requests. That is all.

No normalised entity cache, no query-key graph, no cross-App cache sharing — Apps are isolated, and a shared cache would be a global store reintroduced through the back door. When two views need the same data, they either share a signal within their App or each fetch it. The correctness and debuggability of that is worth far more than the saved request.
