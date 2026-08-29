# 04 — App lifecycle and state ownership

The lifecycle is the reason this is an OS model and not a router. A router knows *mounted* and *not mounted*. That is not enough for a live terminal you tab away from, or a cart that must survive navigation.

## States

```
        load()                activate()              deactivate()
registered ──────▶ loaded ──────────────▶ foreground ──────────────▶ background
                     │                         │                          │
                     │                         └──────── activate() ◀──────┘
                     │                                                     │
                     └──────────────── unload() ◀──────────────────────────┘
                                          │
                                      unloaded
```

**registered** — `defineApp()` has run. The module is imported, the App is known, nothing is instantiated. Costs nothing.

**loaded** — instantiated, state container created, `onLoad` run. May hold `background` surfaces and live connections. Not necessarily visible.

**foreground** — visible and active. Its `page` surface owns the content region; its `panel` surfaces are placed.

**background** — task-switched away. **Not torn down.** State intact, sockets open, terminal session alive, subscriptions still receiving. Visible surfaces are detached from the DOM; `background`-role surfaces keep running. Returning is instant and lossless.

**unloaded** — genuinely torn down. `onUnload` has run, subscriptions closed, timers cleared, DOM removed, state container destroyed.

## Hooks

```ts
defineApp({
  id: 'kanban',
  async onLoad(ctx)     { /* create state, open long-lived connections */ },
  async onActivate(ctx) { /* becoming visible: resume polling, focus */ },
  async onDeactivate(ctx){ /* backgrounded: throttle, but do not tear down */ },
  async onUnload(ctx)   { /* release everything; must leave nothing behind */ },
});
```

`onUnload` **must** fully release. An App that leaks a socket or an interval is a bug, and the runtime will say so: in development it asserts that every subscription and timer created through `ctx` was disposed, and logs the ones that were not. Leaked resources in a long-running console are not a theoretical concern — a leak per app-switch compounds over an operator's whole working day.

## Deactivate vs. unload — the distinction that matters

`onDeactivate` is not a lightweight `onUnload`. The correct behaviour is usually **throttle, not stop**:

- A metrics dashboard drops its refresh from 2s to 60s. It does not unsubscribe.
- A terminal keeps its session open and buffers output. Killing it would end the user's shell.
- A cart changes nothing. It holds no live connection and its state must survive regardless.

The runtime cannot infer which of these applies, so it does not try — it reports the state change and each App decides.

## State ownership

**Each App owns its state entirely. There is no global store, and the framework will not add one.**

Every App gets an isolated container built on the signal primitives in `05-reactivity.md`:

```ts
const cards = ctx.state.signal<Card[]>([]);
const filter = ctx.state.signal<string>('');
const visible = ctx.state.computed(() => cards().filter(c => c.title.includes(filter())));
```

Created through `ctx.state` so the runtime can dispose the whole container on unload without each App tracking its own cleanup.

The console holding twenty concurrent live streams and a storefront holding two local signals are **the same primitive used a different number of times**, not different architectures. There is no "advanced state management" tier to graduate into. Each incoming stream is simply a signal that updates over time.

Apps cannot read each other's state. Communication is via the backend, or via the runtime's own explicit surfaces — never by reaching across.

## Persistence

State is destroyed on unload by default. An App that wants continuity says so explicitly:

```ts
const cart = ctx.state.persisted<CartLine[]>('cart', []);   // survives unload
```

Persisted state is namespaced per App (an App cannot read another's persisted keys) and is stored client-side. Anything that must be durable, shared between users, or authoritative belongs in the backend behind a contract — not here. A cart that only exists in one browser's storage is a cart that vanishes on a new device, and that is a product decision, not a storage detail to be made accidentally.

## Loading

Apps come from the manifest (`09-manifest.md`). Loading is dynamic — an App's code is fetched on demand, not bundled into one monolith — so a deployment loading a dozen Apps does not pay for all of them on first paint.

Load triggers:
- **eager** — at startup, from the manifest.
- **on-route** — when a URL matching its `page` surface is first visited.
- **on-demand** — `ctx.apps.load('deployment-spec')`, e.g. from a command palette.

Unload is explicit (`ctx.apps.unload(id)`) or at session end. **The runtime does not unload Apps automatically under memory pressure** — silently discarding a backgrounded terminal session would be worse than the memory it reclaims. If eviction ever becomes necessary it will be an explicit, visible policy, not an invisible heuristic.

## Failure isolation

An App that throws during any lifecycle hook is marked failed, its surfaces are removed, and the rest of the runtime continues. One broken App must never take down a console that an operator is depending on. The failure is surfaced in the UI and logged with the App id — not swallowed.
