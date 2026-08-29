# 05 — Reactivity

The substrate. Components, app state, session, routing, and live data are all built on it. Three primitives, no more.

## Why this is specified before components

`@flybyme/mesh-ui` has a `Signal.ts` and a `BaseComponent.ts`, and the component class does not use the signal for updates. The result is `updateProps()`:

```ts
public updateProps(newProps: Partial<TProps>): void {
    this._props = { ...this._props, ...newProps };
    this.element.innerHTML = '';   // ← discards the entire subtree
    this.render();                 // ← rebuilds it from scratch
}
```

Every prop change, however small, destroys and rebuilds everything below it. That loses focus mid-typing, resets scroll position, and destroys the internal state of every child. For a console streaming live data into many panels, this is not a performance nitpick — it is the difference between usable and not.

Getting the reactivity layer right first is what prevents the component layer from having that escape hatch available.

## The three primitives

```ts
const count = signal(0);              // readable + writable
count();                              // read  → 0
count.set(1);                         // write

const doubled = computed(() => count() * 2);   // derived, cached, read-only
doubled();                            // → 2

effect(() => console.log(count()));   // runs now, re-runs when dependencies change
```

**Automatic dependency tracking.** Reading a signal inside a `computed` or `effect` subscribes to it — no dependency arrays to declare and get wrong.

**Fine-grained by construction.** An `effect` re-runs only when something it actually read has changed. A component that binds one text node to one signal updates exactly that text node. There is no subtree rebuild anywhere in the design because nothing in the design ever has a reason to do one.

**Glitch-free, batched.** Synchronous writes in the same tick are coalesced into one flush; a `computed` never observes an inconsistent intermediate state. Writing to three signals runs dependent effects once, not three times.

**Disposal is owned by the runtime.** Effects created through `ctx.state` are torn down when the App unloads (`04-lifecycle.md`). Manual disposal exists (`effect(...)` returns a dispose function) but is the exception.

## Async and remote data

Remote data is a signal that changes over time, not a separate concept:

```ts
const cards = resource(() => api.kanban.board_list({ repo: repo() }));

cards.loading();   // boolean signal
cards.error();     // Error | null
cards.data();      // T | undefined
```

`resource` re-fetches when a signal it read changes — switching `repo` refetches automatically. Loading and error states are first-class rather than something each app re-invents, because the alternative is fifty different spinner conventions across fifty apps.

Live streams (`08-data.md`) are the same shape: a signal that updates when a message arrives. A component subscribing to a live log tail and one subscribing to a static value are written identically.

## Rules

- **No global mutable state outside signals.** If it changes and something displays it, it is a signal.
- **No manual subscription bookkeeping in app code.** Reading tracks; the runtime disposes.
- **`computed` must be pure** — no side effects, no writes. Side effects belong in `effect`.
- **Never write to a signal inside a `computed`.** This is enforced: it throws in development.
- **Prefer `computed` over syncing two signals with an `effect`.** Derived state that is stored is state that can be stale.

## Not included, deliberately

No time-travel debugging, no middleware, no action/reducer indirection, no store hierarchy. Those are answers to problems created by global stores, and this design does not have a global store — state is per-App and isolated (`04-lifecycle.md`).

Where debugging visibility matters, it comes from the runtime's dev tools reading the actual signal graph, not from an architectural tax paid by every app to make debugging possible.
