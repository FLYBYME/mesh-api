# 03 — Runtime model: apps, surfaces, roles, compositor

This is the core abstraction. Everything else in the runtime is downstream of it.

## Framing

The browser is the hardware. The runtime is the OS. Apps are processes.

The framing is architectural — isolation, lifecycle, composition — and never literal. **This is a real browser page with first-class HTML5.** Real DOM, real History API, real forms, real links, real accessibility. Nothing is simulated in canvas, and no part of this pretends the browser is not the browser.

The specific model borrowed is Wayland's client/compositor split, because it solves a real problem observed in `mesh-ui`: extensions showing up in unexpected places. In Wayland, a client never positions itself on screen — it requests a surface with a role, and the compositor decides placement by its own policy. The client cannot misbehave into the wrong spot because it never had that power. That is the property worth stealing.

## App

The unit of functionality. A cart. A promo banner. A live node terminal. A deployment-spec editor. A kanban board. An admin console.

An App:
- is self-contained and knows nothing about any other App;
- owns its own state, entirely (`04-lifecycle.md`);
- declares what it wants to show by requesting surfaces;
- never positions itself, never writes page chrome, never reaches into another App.

**Apps nest, recursively.** A top-level App (the console, a storefront) can host child Apps using the identical machinery the runtime uses to host top-level ones. There is exactly one hosting mechanism, not a separate "plugin" concept underneath a separate "app" concept. This is what makes "a cart running inside the doctor's site, alongside a promo banner, alongside a live terminal" fall out of the model rather than being a special case.

```ts
defineApp({
  id: 'kanban',
  title: 'Kanban',
  surfaces: [ ... ],
});
```

`defineApp` self-registers on import, mirroring how `defineContract` already self-registers into mesh's global contract registry. Adding an App means writing its file and listing it in the manifest — nothing else in the system changes. That is the "just load in the deployment spec UI and it runs alongside the other random shit" requirement, made structural.

## Surface

What an App asks for when it wants to be on screen. An App may request several, at different times, and may run with none at all.

A surface request declares **what kind of thing this is**, never **where it goes**:

```ts
{ role: 'page', route: '/kanban/*', mount(el, ctx) { ... } }
```

## Roles

The complete set. Adding a role is a framework decision, not an app-level one — an open-ended role vocabulary would reintroduce the placement free-for-all this design exists to prevent.

| Role | Meaning | Typical placement |
|---|---|---|
| `page` | Routed primary content. Owns the content region when its route matches. | Content region |
| `panel` | Persistent chrome content, tied to the App not the route. | Sidebar / header / footer |
| `popup` | Transient, anchored to a trigger element. Dismissed on outside click/Escape. | Floating, anchored |
| `banner` | Dismissible strip, usually announcements or warnings. | Above content |
| `overlay` | Modal, focus-trapped, blocks interaction beneath. | Centered, on top |
| `background` | No visual placement. Runs, holds connections, keeps state warm. | None |

`background` is the role that makes the OS framing earn its keep: a live terminal, a subscription feed, or a long poll keeps running while its App is not visible, and can be brought forward without reconnecting. A plain router cannot express that — it only knows "mounted" and "not mounted."

## Compositor

The runtime component that owns the screen. Apps request; the compositor decides.

Its responsibilities:
- resolve each surface request against the current **layout policy**;
- decide placement, ordering, and stacking;
- decide whether a surface is shown at all;
- enforce that no App can draw outside the region it was granted.

Layout policy is per-deployment, not per-App. A console's policy maps `panel` surfaces into a persistent left sidebar; a storefront's policy might have no sidebar at all and drop or relocate the same request. **The App is identical in both cases.** This is exactly the property `mesh-ui` lacked.

## Placement conflicts

Previously flagged as an open question; resolved here.

Every surface request is **advisory, and can be refused.** The App is told the outcome and must handle it — there is no guarantee of placement, and an App that assumes one is broken.

```ts
const surface = await ctx.requestSurface({ role: 'banner', ... });
if (!surface.granted) return;   // policy said no; carry on without it
```

Resolution rules per role:

- `page` — exactly one active at a time; the router decides which (`07-routing.md`). Not contended: route matching is deterministic.
- `panel` — many allowed, ordered by manifest order. If the layout has no matching region, the request is **refused**, not silently dropped into an arbitrary spot.
- `banner` — many allowed; the compositor queues them and shows them one at a time, oldest first. Refused if policy disables banners entirely.
- `popup` / `overlay` — one at a time; a new one supersedes the current, which is dismissed and told so.
- `background` — never refused (nothing to place).

Refusal is a normal outcome, not an error. Making it explicit in the API is what stops apps from being written against an assumption that only holds in one deployment.

## What the runtime owns vs. the App

| Runtime | App |
|---|---|
| Header, sidebar, footer, layout regions | Content inside a granted surface |
| Placement, stacking, z-order | Requesting a role |
| URL, history, navigation | Views within its own page surface |
| Session, auth state | Its own data and state |
| App loading, backgrounding, teardown | Responding to its own lifecycle hooks |
| Task switching between top-level apps | Nothing — it cannot see other apps |

## Task switching

A hotkey switches between loaded top-level Apps, backgrounding the outgoing one rather than destroying it (`04-lifecycle.md`). This is a **real production feature of the console**, not a dev-only convenience: the console ships with the operational tooling its operator wants, and flipping to a running client site while a terminal session and live streams stay alive is part of that.

Whether an end-user-facing deployment exposes the switcher is layout policy. A storefront loading exactly one App has nothing to switch to, and the chrome is simply absent.

`13-applications-and-extensions.md` specifies the switcher properly — MRU ordering, a real hotkey parser, the overlay, per-app route memory — and names what the current implementation does not yet do. It also splits the "App" of this document into an **Application** and an **Extension**. The one-hosting-mechanism rule above is unchanged: Applications nest through the same compositor, and an Extension is not hosted in a surface at all.
