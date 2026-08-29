# 09 — The manifest

One YAML file per deployment. It declares which Apps load, how the screen is laid out, and how surfaces are placed. The same App code runs unchanged under different manifests — that is what makes an App genuinely portable between a console and a storefront.

## Example

```yaml
site:
  id: console
  title: SurfDNS Console
  theme: dark

layout:
  regions:
    header:  { slots: [nav, spacer, search, notifications, user] }
    sidebar: { slots: [primary, secondary], collapsible: true }
    content: {}
    footer:  { slots: [status] }
  banners: enabled
  taskSwitcher:
    enabled: true
    hotkey: "Ctrl+`"

apps:
  - id: dashboard
    module: ./apps/dashboard.js
    load: eager
    surfaces:
      - { role: page,  route: "/" }
      - { role: panel, slot: sidebar.primary, order: 10 }

  - id: kanban
    module: ./apps/kanban.js
    load: on-route
    auth: user
    surfaces:
      - { role: page,  route: "/kanban/*" }
      - { role: panel, slot: sidebar.primary, order: 20 }

  - id: node-terminal
    module: ./apps/node-terminal.js
    load: on-demand
    auth: admin
    surfaces:
      - { role: background }
      - { role: overlay }

  - id: deployment-spec
    module: ./apps/deployment-spec.js
    load: on-demand
    auth: admin
    surfaces:
      - { role: page,  route: "/deployments/*" }
      - { role: panel, slot: sidebar.secondary, order: 10 }
```

Adding the deployment-spec UI to a running console is those seven lines plus the App's own file. Nothing else changes — which is the requirement this design was built around.

## Layout and placement

`layout.regions` declares which regions exist and what named slots each offers. An App's `panel` request names a slot (`sidebar.primary`); if the manifest has no such slot, the request is **refused** and the App is told (`03-runtime-model.md`) — never silently relocated.

A storefront manifest declaring no sidebar at all runs the same Apps; their `panel` requests are simply refused, and their `page` surfaces work normally.

`order` sets deterministic ordering within a slot. Apps do not compete for position at runtime.

## Load strategies

- `eager` — at startup. For chrome that must be present immediately.
- `on-route` — first time a matching URL is visited. The default for routed Apps.
- `on-demand` — only via `ctx.apps.load(id)`, e.g. from a command palette.

An App's code is fetched only when it loads, so a manifest with many Apps does not inflate first paint.

## Auth

`auth` on an App is a **load gate**: `public` (always), `user`, or `admin`. An App the current session does not satisfy is **not loaded** — not loaded and hidden, not loaded at all. Its code is never fetched.

This is the client-side mirror of exposure policy (`01-exposure.md`), and it carries the same caveat: **it is not a security boundary.** It shapes the UI. Real enforcement is server-side, on every call, always. A user who forges a session state to load an admin App gets an App whose every backend call fails — annoying for them, harmless to the system. Anyone reasoning about this the other way round has built a hole.

## Validation

The manifest is parsed against a zod schema and validated at startup. Failures are loud and specific — an App referencing `sidebar.tertiary` when the layout defines `primary` and `secondary` fails immediately with that message, rather than silently rendering nothing and being debugged later.

The same schema generates the manifest's own reference documentation.

## Environment overlays

A base manifest with per-environment overlays, merged at build or serve time:

```yaml
# manifest.dev.yaml
apps:
  - id: dev-tools
    module: ./apps/dev-tools.js
    load: eager
```

Development gets extra Apps without a separate manifest to keep in sync. The console keeps its debugging tooling **in production deliberately** — it ships with the operational tools its operator wants, gated by `auth: admin` rather than stripped by build flags.
