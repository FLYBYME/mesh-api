# 13 — Applications, Extensions, and the view manager

Status: **design**. Nothing in this document is built yet except where it says otherwise.

This document introduces the split between an **Application** and an **Extension**, the capability
context that makes that split real, the platform services both rely on, and the view manager that
runs several Applications at once. It extends `03-runtime-model.md` and `04-lifecycle.md`; where it
revises them, it says so.

---

## Framing

The framework has to carry a blog, a landing page, an operator console and an IDE. Those differ in
almost everything visible and in almost nothing structural: each shows screens, each posts
notifications, each binds keys, each talks to a mesh node.

The previous model had one concept — the App — and one hosting mechanism. That was right about
mechanism and wrong about roles, because it left no way to say "this thing extends the framework
itself" as distinct from "this thing is a place you go". Auth is not a destination. The console is.
Calling both an App made the auth screens a peer of the console, and made the console's chrome the
framework's business.

So: **two contribution contracts, still one runtime.**

| | An **Application** | An **Extension** |
|---|---|---|
| is | a destination — the thing you are *in* | a capability available to whatever is running |
| declares | routes, screens, a shell profile | commands, keybindings, views, providers |
| owns | a workspace and its content region | nothing on screen of its own |
| examples | console, blog, landing page, the IDE | auth, logging, telemetry, source control, a language service |
| lifetime | loaded and switchable; several at once | activated once, spans every Application |

`03-runtime-model.md` says there is exactly one hosting mechanism and no separate plugin concept
underneath a separate app concept. **That remains true.** Applications nest recursively through the
same compositor, and an Extension is not hosted in a surface at all — it contributes capabilities.
The two are different contracts over one runtime, not two runtimes.

---

## Application

```ts
defineApplication({
    id: 'surfdns.console',
    title: 'Console',
    shell: 'document',              // which shell profile it needs
    needs: ['net', 'notifications', 'commands'] as const,
    surfaces: [
        { role: 'page', route: '/organizations', mount },
        { role: 'panel', slot: 'header.user', mount },
    ],
});
```

An Application:

- knows nothing about any other Application;
- owns its state entirely (`04-lifecycle.md`);
- requests surfaces, never positions itself;
- names the **shell profile** it needs, and fails to load under a shell that cannot provide it.

Several Applications are loaded at once and exactly one is foreground. That is the view manager,
below.

## Extension

```ts
defineExtension({
    id: 'identity.auth',
    title: 'Authentication',
    needs: ['net', 'commands', 'notifications', 'storage'] as const,
    activate(cx) {
        cx.commands.register({
            id: 'auth.signOut',
            label: 'Sign out',
            run: () => { ... },
        });
        return {
            session: cx.state.signal<Session | null>(null),
        };
    },
});
```

An Extension:

- has no route and no page surface — it cannot be navigated to;
- may contribute commands, keybindings, panel views, and **providers** other code consumes;
- activates once for the whole session and survives every Application switch;
- may be depended on by name: an Application declares `uses: ['identity.auth']` and receives its
  exported providers, typed.

An Extension that wants a screen contributes a **view** into a region the shell profile offers, and
the shell decides whether that region exists. This is the same refusal-is-normal rule surfaces
already follow (`03-runtime-model.md`).

---

## The capability context

This is the mechanism that makes the split worth having, and it is the specific thing the previous
generation got wrong.

In `mesh-ui`, `Extension.activate(shell: Shell)` received an object holding `layout, commands,
extensions, views, activityBar, tabs, theme, shortcuts, dnd, app, logger, transport, nodeID`. Every
extension could reach the activity bar and the tab service, so every extension was implicitly an
extension *of an IDE*. A blog written against that interface would still be handed a docking system.
That single design choice is why the framework could only ever produce one kind of application.

Here, `activate` receives **only what was declared**:

```ts
needs: ['net', 'commands'] as const
//   → cx: { net: Net; commands: Commands; state: AppState; log: Logger }
//   → cx.notifications is a compile error, not undefined at runtime
```

`needs` is a const tuple and `cx` is derived from it. Asking for a capability you did not declare
fails at build time. Requesting a capability the running shell cannot provide fails at load, named,
before any code runs.

Baseline capabilities, always present regardless of shell:

| capability | what it is |
|---|---|
| `net` | contract-addressed calls and subscriptions (below) |
| `notifications` | post, update and dismiss notifications |
| `commands` | register and execute commands |
| `keys` | bind keys to commands |
| `state` | scoped signals, computeds, resources, persisted values |
| `storage` | namespaced key/value |
| `log` | structured logging |

Shell-specific capabilities (`panels`, `tabs`, `activityBar`, `docking`, `editors`) exist only under
the shells that provide them, and are declared the same way.

---

## Platform services

The rule: **one API everywhere, presentation owned by the shell.**

### Notifications

Notifications are framework-level, not application-level. A blog, the console and the IDE all write:

```ts
const n = cx.notifications.progress('Deploying…');
n.update({ detail: '3 of 7 nodes' });
n.done('Deployed');

cx.notifications.error('Save failed', {
    actions: [{ label: 'Retry', run: () => save() }],
});
```

The call is identical. The rendering is not: the `document` shell paints a banner in its notification
region, the `workbench` shell a toast above the status bar. An Application never chooses, which is
what makes a screen portable between them.

Three properties that have to hold, and are the reason this cannot be a component library import:

1. **A notification outlives its poster's foreground state.** Backgrounding an Application does not
   dismiss its notifications; a deploy started in one app and finished while another was showing
   still reports. Notifications belong to the session, tagged with their origin.
2. **A notification is addressable.** `progress()` returns a handle with `update`, `done` and
   `dismiss`. Fire-and-forget toasts cannot express a long operation.
3. **A backgrounded Application can request attention** — the switcher shows a badge. This is where
   notifications and the view manager meet, and it is why they are specified together.

### Commands and keybindings

Carried over from `mesh-ui` largely intact — `CommandRegistry` and `ShortcutManager` are the two
pieces of that codebase most worth keeping. Keybinding normalisation there already handles modifier
ordering, macOS Meta→Ctrl folding, and IME composition guards.

Commands are the single indirection between "a thing the product can do" and every way of invoking
it: a menu item, a keybinding, the command palette, a button, another extension. Nothing binds a key
to a function directly.

### Network

The call shape from `mesh-ui` is worth keeping; what it sat on is not.

```ts
await cx.net.call(resolverQueryContract, { name, type });
cx.net.subscribe(nodeStatusEvent, status => { ... });
```

Contract-addressed, typed, transport invisible to the caller. Underneath it is HTTP to a mesh node's
API — **not** a browser mesh transport. `00-overview.md` states the hard boundary: the browser never
joins the mesh. `mesh-ui` violated it by running a `MeshApp` with a `BrowserWebSocketTransport` in
the tab, making every browser a peer on the cluster network. That model does not return.

Transport selection is per contract, declared server-side in exposure policy, and invisible to the
caller:

| transport | for | status |
|---|---|---|
| REST | request/response | built (`src/exposure/rest.ts`) |
| SSE | server→client streams | built (`src/exposure/events.ts`, client with backoff and Last-Event-ID) |
| WebSocket | genuinely bidirectional — terminals, collaborative editing, language servers | **not built** |

WebSocket is one sibling file in `src/exposure/`, not a new architecture, and `12-network-and-federation.md`
already sets the policy: only where genuinely bidirectional. The IDE is the first thing that
qualifies.

---

## Shell profiles

A shell profile supplies the region vocabulary, the notification presenter, and the shell-specific
capabilities. It is what differs between a blog and an IDE, and isolating it here is what stops IDE
requirements leaking into the framework.

**`document`** — header, nav, content, footer. Routed pages, browser-shaped history, notification
banners. Blog, landing page, the console today. This is what `manifestToLayoutPolicy` builds now.

**`workbench`** — activity bar, dockable panels, editor groups, tabs, status bar, command palette,
toast notifications. The IDE.

An Application names its profile. A shell refusing a capability is a load-time failure with a
message naming both sides, not a runtime `undefined`.

The `document` profile is built first and stays in use, deliberately. A framework that only ever
runs the workbench will quietly acquire workbench assumptions, and the blog will stop being
possible without anyone deciding it should.

---

## The view manager

Several Applications are loaded; one is foreground; a hotkey switches. Backgrounding preserves the
outgoing Application rather than destroying it (`04-lifecycle.md`).

### What exists

`AppHostImpl` (`src/runtime/app/host.ts`) already tracks `foregroundAppId` and `loadedOrder`,
activates one app at a time (`activateApp` deactivates the outgoing one first), and installs a
keydown handler that cycles apps. The compositor's `detachAppSurfaces` / `restoreAppSurfaces`
(`src/runtime/app/compositor.ts:642,667`) remove and re-insert a backgrounded app's DOM **without
destroying it**, recording `parentElement` and `nextSibling` so it returns to its exact position.

So the substrate is right. What is missing is everything that makes it usable.

### Gaps, specifically

1. **The hotkey is not configurable, though it looks it.** `setupTaskSwitcher` compares the
   configured hotkey against the literal `'ctrl+\`'` and hard-codes the matching event test. Any
   other value in `taskSwitcher.hotkey` is silently ignored — the switcher simply never fires. Needs
   the real parser; `ShortcutManager`'s normaliser already exists and should be the one used.

2. **Cycle order is load order, not recency.** `cycleToNextApp` walks `loadedOrder`, so the hotkey
   marches through a fixed list. Every switcher users know — alt-tab, Ctrl+Tab — is
   most-recently-used, where a repeated press returns you to where you were. Load order makes
   flipping between two apps out of five impossible.

3. **No reverse cycle.** Shift+hotkey should walk back.

4. **No switcher UI.** There is no way to see what is loaded or to jump to a non-adjacent
   Application. A quick-pick overlay listing loaded apps, MRU-ordered, with attention badges, held
   open while the modifier is held.

5. **No per-Application route memory.** Each Application has a scoped router, but the URL is global
   and switching does not restore the outgoing app's last route. Switching away from
   `/organizations/abc` and back should return there. The foreground Application's route is the
   browser URL; a backgrounded one's is remembered.

6. **Focus is lost on switch.** Detach/restore preserves the DOM but removing an element from the
   document blurs it. The restoring Application should return focus to where it was.

7. **Nothing on screen says which Application is foreground**, or that others exist.

### Target behaviour

- The loaded set is explicit and inspectable; the foreground is exactly one.
- Cycling is MRU. The switcher overlay is the discoverable form of the same thing.
- Backgrounding preserves DOM, state, subscriptions, in-flight work, focus and route.
- A backgrounded Application may raise attention; the switcher shows it.
- Unloading is separate from backgrounding and is the only thing that destroys state
  (`04-lifecycle.md` already draws this line).

---

## Distribution: built-in and external

**Built-in** — compiled into the framework bundle, always present, versioned with the framework.
These are the things every deployment has and none should install:

- the command palette
- the notification centre
- the app switcher
- settings
- the process manager
- the Application/Extension manager

**External** — its own repository, its own build, its own release cadence. This is the default for
anything a product adds: the console, a blog, auth, a language service. The framework must not need
to know an external Application exists at build time; that is the entire purpose of the manifest
(`09-manifest.md`).

An external repo publishes a bundle plus a declaration. It is loaded through a manifest entry
naming its URL, its integrity hash, and the auth level required to fetch it — the auth check
happens **before the module is imported**, so a bundle a visitor may not use never reaches their
browser. `mesh-ui` imported extension bundles from `/s/<id>?t=<Date.now()>` with no check at all;
that is not carried forward.

Version skew between an external Application and the framework is the failure this arrangement
invites. `10-build-and-serve.md` covers the stamping; the addition here is that an Application
declares the framework range it was built against, and a mismatch is refused loudly at load rather
than surfacing as a missing export three screens in.

---

## The builder belongs in mesh-api

Every consumer is currently rewriting the same esbuild script — surfdns has 150 lines of it,
`mesh-ui` has the same thing wrapped in a service. The part they will each get wrong is the shared
module set: the runtime, `zod` and the API client must exist exactly once on the page, the import
map and the externals list must agree, and when they disagree the failure is silent. A duplicated
`zod` makes `instanceof z.ZodObject` fail inside the form generator, which renders a submit button
and no fields, with nothing in the console.

That is framework knowledge and it should not be rediscovered by re-suffering it. `mesh-api build`
owns the import map, the shared-module set, the per-app bundle convention and the cache stamp. The
watch/rebuild service is separate and optional.

---

## Open questions

- **Can two Applications be visible at once?** The model says one foreground. A split view is the
  obvious IDE request. Deferred — it is a shell-profile concern, and `workbench` can answer it
  without changing the host.
- **Do Extensions have a foreground concept at all?** Currently no: they activate once and persist.
  A heavy Extension that wants to idle while unused would need one.
- **Does an Extension's contribution survive an Application it was contributing into?** Assumed yes
  — Extensions outlive Applications — but the compositor currently keys surfaces by app id.
- **What does the process manager actually manage?** Named as built-in; its scope is not specified
  here.
