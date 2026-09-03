# @flybyme/mesh-api

The `api` ServiceModule: a **listener and a cache**. It binds a port, turns exposed mesh contracts
into REST, SSE and WebSockets, and holds exactly two things across requests — the exposure map and
the ticket cache.

Per request it is stateless. Nothing may assume sticky routing: a dropped connection reconnects
anywhere and re-subscribes.

**The design lives in [mesh-web's spec](https://github.com/FLYBYME/mesh-web/tree/master/spec).** This
repository implements it and does not re-argue it — [service-modules §2](https://github.com/FLYBYME/mesh-web/blob/master/spec/service-modules.md)
for what this module is, [hosting §4](https://github.com/FLYBYME/mesh-web/blob/master/spec/hosting.md)
for addressing, [auth §3](https://github.com/FLYBYME/mesh-web/blob/master/spec/auth.md) for the ticket
cache, and [network](https://github.com/FLYBYME/mesh-web/blob/master/spec/network.md) for the typed
client this feeds.

## This is a rewrite, not a port

The previous tree is tagged **`archive/pre-rewrite`** (`9a9e193`) — 168 files, including a browser
runtime that is now mesh-web's entire subject. It was deleted rather than ported because it was never
a fixed point: mesh-web leads and mesh-api adapts.

Worth reading there before changing anything here: `src/exposure/types.ts`. Its central property is
the one thing that survives unchanged —

> `auth` has no default. Making the author type `'public'` deliberately is the point — an omitted
> gate must never quietly mean "open".

## What exists

**The exposure descriptor.** A site's exposure list — TypeScript holding live zod schemas — becomes
plain JSON that a build can read with no cluster running:

```ts
const descriptor = describeExposure(expose, { application: 'surfdns.console' });
// { application, base, exposure: 'sha256:…', calls: [{ key, method, path, gate, input, output }] }
```

Input and output are emitted as JSON Schema — **structurally**, never as a reference to the zod object
that produced them. That is [network §3.1](https://github.com/FLYBYME/mesh-web/blob/master/spec/network.md),
and it is what surfdns #15 actually was: a `z.infer` reaching across a package boundary, breaking on a
version bump.

The `exposure` hash identifies an exposure rather than a file. Reordering the list does not change it;
loosening a gate does. CI regenerates and diffs; the API reports its own so a deployed client can be
checked against a running server.

**Six things fail the build rather than reaching production:** an ungated entry, an entry with two
gates, a contract its own domain marks `internal`, one contract exposed twice, a route collision, and
a schema that cannot be described (the converter returns `{"$schema":…}` for a non-schema rather than
throwing, which would generate a client typing the call as `unknown`).

## What does not exist yet

REST mounting, SSE, WebSockets, the ticket cache, the `api` ServiceModule itself, and the client
emitter. Tracked as C3 in [mesh-web's roadmap](https://github.com/FLYBYME/mesh-web/blob/master/spec/roadmap.md).

## Where exposure lives

**In the site's repository**, not here — decided as C3.2. The `exposure` collection, if this module
keeps one, is a resolved cache filled at boot and never the thing anyone edits.

The argument is drift rather than storage: the people writing the screens know which calls those
screens make, and a list beside the screens gets reviewed when a screen changes. A list owned
elsewhere only ever grows, and an exposure list that only grows is a security boundary that only
widens.

Two consequences, both intended. The client generator reads a file and needs no running cluster — so
it works in CI before anything is deployed. And changing what the outside world can reach is a deploy,
not a live toggle.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
```
