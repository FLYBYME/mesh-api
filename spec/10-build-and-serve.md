# 10 — Build and serve

How a mesh service turns into a running web application, and what the development loop feels like.

## Enabling the web feature

A service mounts it the same way it mounts anything else:

```ts
export class KanbanService extends ServiceModule {
  public readonly domain = 'kanban';

  constructor() {
    super();
    this.mountTool(cardCreateContract, card_create);
    // ... other tools

    this.mountWeb({
      manifest: './manifest.yaml',
      expose: [
        { contract: cardCreateContract, auth: 'user' },
        { contract: boardListContract,  auth: 'user' },
      ],
      events: [
        { event: 'card.updated', auth: 'user', scope: 'org' },
      ],
    });
  }
}
```

That single call gives the service: REST routes for the exposed contracts, MCP tools for the same set, a generated typed client, an SSE endpoint for the exposed events, the app shell, and the static bundle. This is what "the UI is built in and first class" means concretely — not a second package to wire up, not a separate deployment.

## Build

`esbuild`. Fast, already proven in this ecosystem, no plugin ecosystem to manage.

Three outputs:

1. **Shell bundle** — runtime, compositor, router, component library. Loaded once, cached hard.
2. **App bundles** — one per App, code-split, fetched on load (`04-lifecycle.md`).
3. **Generated client** — types and fetch wrappers derived from the exposed contracts.

Codegen runs before bundling. Changing a contract regenerates the client, and any App using a field that no longer exists fails to compile — the failure lands at build time, in the right place, rather than at runtime in a browser.

## Development

```
npm run dev
```

Starts the mesh service and the bundler in watch mode. Editing an App rebuilds just that App's bundle. **The runtime reloads the changed App in place** — its lifecycle hooks run (`onUnload`, then `onLoad`) rather than the page hard-reloading. Other Apps keep running with their state intact, which is what makes iterating on one panel of a console tolerable while a terminal session and live streams stay connected in the others.

No HMR framework, no custom module protocol: the App boundary already provides the unit of reload, so the mechanism is simply "unload it, fetch the new bundle, load it again."

## Serving

The exposure layer serves:

| Path | Serves |
|---|---|
| `/` and any unmatched path | App shell HTML (History API requires this — `07-routing.md`) |
| `/assets/*` | Bundles and static assets, content-hashed, immutable caching |
| `/api/*` | Exposed contracts as REST |
| `/api/events` | SSE stream for exposed events |
| `/mcp` | MCP endpoint |
| `/api/openapi.json` | Generated OpenAPI document |

The shell is small and cacheable; Apps stream in after.

## Production

- Content-hashed filenames, immutable `Cache-Control`, so a deploy never serves a stale mix.
- Shell HTML is never cached.
- Preload hints for `eager` Apps; everything else is fetched on demand.
- Compression handled at the proxy, which already exists in this platform.

## Version skew

A real problem with long-lived sessions and rolling deploys: a browser holds an old shell while the server moves on. An operator's console stays open for days, so this is not hypothetical.

The runtime handles it explicitly — the shell carries a build id, the API returns the current one, and on mismatch the runtime surfaces a "new version available, reload" prompt rather than reloading under the user's hands and discarding a half-written form. Reload timing is the user's choice; silently discarding their work is not acceptable.

## SSR

Not in the first version. The runtime renders client-side.

It is on the roadmap for public-facing sites where first paint and indexability genuinely matter (a storefront, a blog), and explicitly not needed for the console, which is behind auth and where nothing is indexed. Building it before there is a real SEO-bearing consumer would be scope taken on speculation — but the architecture is compatible: components produce real DOM from real data, so server-rendering the initial view and hydrating bindings is a natural extension rather than a rewrite.
