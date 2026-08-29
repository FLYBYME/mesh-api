# 11 — Worked example: kanban

The proof case. A real, existing mesh service (`/home/ubuntu/code/kanban`) that already has contracts, no database, and a JSON-file store — turned into a full application by adding `mountWeb`. Everything below is the intended end state; the service and its contracts already exist.

Its purpose is real: tracking what agy dispatches and Claude sessions are actually doing, replacing unstructured "waiting for tests…" narration with structured, queryable state.

## What already exists

Eight contracts on one `ServiceModule` — `card_create`, `card_claim`, `card_log`, `card_test_result`, `card_block`, `card_complete`, `card_get`, `board_list` — pure `defineContract`, no `defineCrud`, no Mongo. Their zod schemas are already the single source of truth, and their descriptions are already written for a tool-caller.

## Step 1 — expose

```ts
this.mountWeb({
  manifest: './manifest.yaml',
  expose: [
    { contract: boardListContract,      auth: 'user' },
    { contract: cardGetContract,        auth: 'user' },
    { contract: cardCreateContract,     auth: 'user' },
    { contract: cardClaimContract,      auth: 'user' },
    { contract: cardLogContract,        auth: 'user' },
    { contract: cardTestResultContract, auth: 'user' },
    { contract: cardBlockContract,      auth: 'user' },
    { contract: cardCompleteContract,   auth: 'user' },
  ],
  events: [
    { event: 'card.created', auth: 'user', scope: 'org' },
    { event: 'card.updated', auth: 'user', scope: 'org' },
  ],
});
```

This yields REST, MCP, the typed client, and an event stream. **The MCP half is the point of this project**: an agy dispatch calls `kanban.card_log` as a real tool instead of narrating prose, and the board shows what is actually happening.

## Step 2 — manifest

```yaml
site:
  id: kanban
  title: Kanban

layout:
  regions:
    header:  { slots: [nav, spacer, user] }
    content: {}
  banners: enabled

apps:
  - id: board
    module: ./apps/board.js
    load: eager
    auth: user
    surfaces:
      - { role: page, route: "/*" }
```

No sidebar: this deployment does not need one. The same App would run unchanged under the console's manifest, where its `panel` request would be granted instead of refused.

## Step 3 — the app

```ts
import './board.css';

defineApp({
  id: 'board',
  title: 'Kanban',

  async onLoad(ctx) {
    const repo = ctx.router.queryParam('repo', '');
    const board = resource(() => ctx.api.kanban.board_list({ repo: repo() || undefined }));

    // Live updates: patch in place, no refetch.
    ctx.api.events.on('card.updated', ({ card }) => {
      board.patch(cards => cards.map(c => (c.id === card.id ? card : c)));
    });
    ctx.api.events.on('card.created', ({ card }) => {
      board.patch(cards => [card, ...cards]);
    });

    ctx.state.set({ board, repo });
  },

  surfaces: [{
    role: 'page',
    route: '/*',
    views: [
      { path: '/',          view: BoardView },
      { path: '/card/:id',  view: CardDetailView },
    ],
  }],
});
```

Four columns, each a `For` over a filtered `computed`:

```ts
function BoardView(ctx: AppContext): HTMLElement {
  const { board } = ctx.state.get();
  const column = (key: CardColumn) => computed(() =>
    (board.data() ?? []).filter(c => c.column === key));

  return h('div', { class: 'board' },
    ...COLUMNS.map(col =>
      h('div', { class: 'column' },
        h('h2', {}, () => `${col.label} (${column(col.key)().length})`),
        For(column(col.key), card => CardTile({ card }), card => card.id),
      )),
  );
}
```

When a card moves column, one `card.updated` event patches one signal, and `For` moves that one DOM node between columns. Nothing else re-renders — no wiped subtree, no lost scroll position in the other three columns. That is the concrete difference from `mesh-ui`'s `updateProps()`.

## What this exercises

| Spec | Exercised by |
|---|---|
| 01 exposure | 8 contracts → REST + MCP + typed client |
| 02 auth | `auth: 'user'`, session-gated app load |
| 03 runtime | One `page` surface; same App portable to a console manifest |
| 04 lifecycle | `onLoad`, throttled polling when backgrounded |
| 05 reactivity | `resource`, `computed` per column, keyed `For` |
| 06 components | Real DOM, real CSS, no wipe-and-rebuild |
| 07 routing | `/card/:id` deep links, `?repo=` as shareable query state |
| 08 data | Live SSE patches instead of polling |
| 09 manifest | Minimal layout, no sidebar |
| 10 build/serve | `mountWeb` serves shell, bundle, API, MCP together |

## Why this example and not a bigger one

It is small enough to build in full, and real enough to be used daily rather than demoed once. If the framework cannot make this pleasant, no amount of console-scale complexity will rescue it — and every gap will be felt immediately, by us, because we will be the ones using it while building everything else.
