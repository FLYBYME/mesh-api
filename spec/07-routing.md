# 07 — Routing, URLs, and history

Correct URLs are a hard requirement, not a nicety. Every meaningful state of the application must be reachable by pasting a link, and every such link must survive a hard reload.

## Real URLs

**History API only.** No hash routing. `/kanban/card/abc123`, never `/#/kanban/card/abc123`.

This requires the server to serve the app shell for any unmatched path, which the exposure layer does (`10-build-and-serve.md`). Getting this right is what makes deep links, browser history, and bookmarks work — and what makes the page indexable when that matters (a storefront, a blog), which hash routing forecloses entirely.

## The router is namespace-aware

Apps can come from more than one site (`12-network-and-federation.md`). The router prefixes each remote namespace's apps so two sites' routes can never collide:

```
/kanban/card/abc      → local app
/b/shop/product/xyz   → app from namespace `b`, mounted at /b
```

The mount point is set by the *consuming* site's manifest, not the remote. An app does not know it is prefixed — it routes within its own subtree exactly as it would on its own site, and the same code runs unprefixed at home. The runtime strips the prefix before handing off and re-adds it when the app navigates.

Namespace means one thing with three consequences: which site an app came from, which backend it talks to by default, and where it lives in the URL.

## Three levels

**Namespace — the runtime.** Strips the namespace prefix, if any, and dispatches to that namespace's apps.

**Top level — the runtime's router.** Owns the URL, matches paths against the `page` surfaces registered by loaded Apps, decides which App is foreground, and triggers on-route loading for an App not yet loaded (`04-lifecycle.md`).

**Within an App — views.** An App's `page` surface owns a path subtree and routes within it. A view is a routing concept *inside* one App's page surface — not a peer of App or Surface.

```ts
defineApp({
  id: 'kanban',
  surfaces: [{
    role: 'page',
    route: '/kanban/*',              // this App owns the subtree
    views: [
      { path: '/',            view: BoardView },
      { path: '/card/:id',    view: CardDetailView },
      { path: '/settings',    view: SettingsView },
    ],
  }],
});
```

The runtime routes to the App; the App routes to the view. An App never sees paths outside its subtree, and cannot claim one.

This is what resolves the site/page/view confusion: **namespace** is which site an app came from, **site** is the deployment (its manifest and layout policy), **App** is the process, **page** is a surface role, **view** is routing inside one page surface.

## Navigation

```ts
ctx.router.navigate('/kanban/card/abc123');        // push
ctx.router.replace('/kanban');                      // replace
ctx.router.back();
ctx.router.params()  // Signal<{ id: string }>
ctx.router.query()   // Signal<URLSearchParams>
```

`params` and `query` are signals, so a view reading `params().id` re-fetches automatically when navigating between two cards — no remount, no manual change detection (`05-reactivity.md`).

Ordinary `<a href>` links are intercepted for same-origin paths and turned into pushes. External links, `target="_blank"`, and modified clicks (ctrl/cmd/middle) are left entirely alone — real links must keep behaving like real links.

## Query state

Query parameters are the right place for view state that should survive a reload and be shareable: filters, sort, pagination, selected tab. A helper binds a signal to a query param in both directions:

```ts
const filter = ctx.router.queryParam('filter', '');   // reads and writes ?filter=
```

Ephemeral UI state (an open dropdown, hover) stays in app state and out of the URL.

## Scroll and focus

- Scroll position is restored on back/forward, reset on a new push.
- Focus moves to the main content heading on navigation, so keyboard and screen-reader users are not stranded.
- A backgrounded App's scroll position is preserved (`04-lifecycle.md`); returning restores it.

## Not found and errors

- No matching App or view → the runtime's 404 view, with correct HTTP status on hard load.
- An App failing to load on-route → error view naming the App, other Apps unaffected (`04-lifecycle.md`).
- A view throwing during render → error boundary at the view level; the App's chrome and other surfaces survive.

## Task switching and history

Task switching between top-level Apps (`03-runtime-model.md`) **does** change the URL — the foreground App's current path is the page's path. Switching to a backgrounded console restores the exact route it was on, and back/forward traverse that history normally. Backgrounding preserves state; it does not create a hidden dimension outside the URL.
