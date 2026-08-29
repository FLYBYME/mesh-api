# 01 — Exposure: contract → REST, MCP, typed client

The exposure layer reads the `ToolContract`s already registered on a mesh broker and projects them outward. It is a translator. It adds no resource model of its own, no second schema language, no business logic.

## What a contract already gives us

Every `defineContract({...})` in the mesh framework already carries everything an API layer needs:

```ts
{
  domain: 'kanban',
  action: 'card_create',
  description: 'Create a new Kanban card...',   // human- and LLM-readable
  inputSchema: z.object({...}),                  // validation + types + JSON Schema
  outputSchema: z.object({...}),
  rest: { method: 'POST', path: '/kanban/cards' },
  print: defaultPrint,
  destructive?: boolean,
  timeout?: number,
}
```

`Registry.getTools(): ToolContract[]` returns every one of them at runtime. That is the entire input to this layer. **One zod schema is the single source of truth** for mesh's own validation, the REST route, the MCP tool, the generated client types, and the generated docs. There is never a second place to declare a shape.

## Three projections

### REST

One route per contract, derived from `rest.method` and `rest.path`. Path params (`:cardId`), query string, and JSON body are merged into one input object and handed to `inputSchema` — the contract's own schema decides what is valid, the HTTP layer never validates separately.

Errors map through `MeshError`'s existing `status`/`code` fields, which the codebase already uses consistently (`notFound` → 404, `badRequest` → 400, `conflict` → 409). A thrown `MeshError` becomes its own status code; anything else is a 500 and is logged, never leaked.

### MCP

One MCP tool per exposed contract, named `<domain>.<action>`, with `description` and `inputSchema` taken directly from the contract. Because contract descriptions are already written for tool-callers (the framework's convention is to write them for an LLM, not just for a human reading the file), MCP exposure requires no extra annotation.

This is generic: any mesh service that mounts `mesh-api` gets MCP for free. Nothing about the adapter knows what domain it is serving.

### Typed client

Codegen produces a browser-safe client from the same contracts:

```ts
const card = await api.kanban.card_create({ title, repo, agentType, agentId });
//    ^ fully typed from the contract's own zod schemas
```

The generated client contains **no zod, no mesh imports, and no schemas** — only plain `fetch` calls and TypeScript types. This matters: it is what keeps the browser bundle from pulling in the framework, and it is what makes "the browser never joins the mesh" true at the dependency level, not just by convention. It mirrors what mesh already does server-side with `mesh generate` writing `src/generated/api.ts` (a global `IServiceToolRegistry` augmentation), just aimed at the browser instead.

## Exposure policy — the part that is not automatic

**Contracts are not exposed by default.** Auto-exposing every registered contract would recreate exactly the problem that keeps the browser off the mesh in the first place: every CRUD action on every collection, reachable by anyone. Mounting the web feature must not silently publish a service's entire internal surface.

A service declares its public surface explicitly:

```ts
this.mountWeb({
  expose: [
    { contract: cardCreateContract, auth: 'user' },
    { contract: boardListContract,  auth: 'user' },
    { contract: plansListContract,  auth: 'public' },
  ],
});
```

Rules:

- Nothing is reachable that is not in this list. There is no wildcard, no `exposeAll`, no "expose all of domain X."
- The list is code, not config — it lives with the contracts it exposes, is type-checked, and changes to it show up in review as a diff touching the public API.
- `auth` is required per entry. There is no default. Making the author type `'public'` deliberately is the point.
- A CRUD-generated contract may be exposed, but each action individually. `card.find` being public says nothing about `card.delete`.

This is the enforcement point that `docs/03-mesh-conventions.md`'s designed-but-never-built per-contract `permissions` was meant to be — narrowed to the one boundary that actually faces untrusted callers, so it can ship now rather than waiting on a framework-wide authorization system.

## Read-only projections

Two derived outputs, both free once the above exists, both regenerated rather than maintained:

- **OpenAPI document** for the exposed set, from the same schemas.
- **API reference page**, served by the runtime itself as a built-in app, so any mesh service can show its own live, accurate API docs with no extra work.

## What this layer must never do

- No hand-written route handlers. If a route needs logic, that logic is a contract.
- No response reshaping. What the contract returns is what the API returns; a different shape means a different contract.
- No second validation layer. `inputSchema` is authoritative.
- No business logic. This layer only authenticates, authorizes, translates, and calls.
