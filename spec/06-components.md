# 06 — Components: real HTML, TypeScript, CSS

No React. No JSX. No virtual DOM. Real DOM, real CSS files, real TypeScript.

The reason is not preference. A virtual DOM exists to make full re-renders cheap enough to be viable. With fine-grained reactivity (`05-reactivity.md`) there are no full re-renders to make cheap — a bound text node updates itself. Paying a diffing engine's complexity and bundle cost to solve a problem the architecture already removed is a bad trade.

## Component model

A component is a function that builds real DOM and wires bindings once:

```ts
export function Card(props: { card: Signal<KanbanCard> }): HTMLElement {
  const el = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, () => props.card().title),
    h('div', { class: 'card-meta'  }, () => `${props.card().repo} · ${props.card().agentId}`),
  );
  bindClass(el, 'blocked', () => props.card().column === 'blocked');
  return el;
}
```

`h()` creates real elements. A plain value is set once. **A function is a binding** — it is wrapped in an effect and updates only that node when its dependencies change. There is no `render()` to re-run and no `updateProps()` that wipes a subtree, because neither concept exists.

Returning `HTMLElement` is honest: it is what the function actually produces. Contrast `mesh-ui`'s `BaseComponent`:

```ts
public getChildren(): BaseComponent<any>[] {
    return this.element.children as unknown as BaseComponent<any>[];
}
```

`element.children` is an `HTMLCollection` of DOM `Element`s. It is not, and cannot become, an array of `BaseComponent` instances. Calling any `BaseComponent` method on the result throws. **Zero `as any` / `as unknown as` / `as never` in this framework** — not as a style rule, but because that cast is the exact bug class this replaces, and one such lie invites the next.

## Control flow

Structural changes need explicit helpers, since a binding updates a node rather than replacing structure:

```ts
When(() => card().blockedReason, reason => h('div', { class: 'blocked' }, reason))

For(cards, card => Card({ card }), card => card.id)   // keyed by id
```

`For` is keyed and does minimal DOM work: it moves existing nodes rather than rebuilding, so a card whose position changes keeps its DOM node, its focus, and its scroll position.

## Styling

Real `.css` files, one per component, imported by the component:

```ts
import './card.css';
```

The bundler collects them. No CSS-in-JS, no inline style objects, no runtime style injection — CSS is a real language with real tooling, and the build step already exists.

Scoping is by convention: a component's classes are prefixed with its name (`.card`, `.card-title`). Design tokens (colour, spacing, typography, radius) are CSS custom properties on `:root`, which is also what makes theming work without a JavaScript theme system.

## Theming and dark mode

Tokens are defined for light, redefined under `prefers-color-scheme: dark`, and redefined again under an explicit `[data-theme]` attribute so a user's choice overrides the system. Components reference tokens, never raw colours. An app that hardcodes a hex value is a bug in review.

## Accessibility

Non-negotiable, and cheap here because the output is real HTML:

- Real semantic elements. A clickable thing is a `<button>`; a navigation target is an `<a href>` — real links, so middle-click, copy-link, and open-in-new-tab all work without anyone implementing them.
- Focus management on overlays: trapped while open, restored on close.
- `Escape` closes `popup` and `overlay` surfaces — handled by the compositor, so every app gets it for free.
- Visible focus indicators are part of the token set, not per-app.

## The component set

Deliberately small. The framework ships primitives that page chrome and typical apps need; it does not ship a sixty-component catalogue up front.

**What ships today**, in `src/runtime/dom/components/`:

**Layout** — Stack, Row.
**Content** — Text, Heading, Badge.
**Controls** — Button, Input, Form (with real validation from the same zod schemas the contracts use).
**Structure** — Card, Table.
**Feedback** — Spinner, EmptyState, ErrorState.

Plus the control-flow helpers `For` and `When` from `src/runtime/dom/control.ts`, which are not components but are how structure changes.

**Not built.** Listed because the shape is known, not because it is pending: Grid, Spacer, Divider, Icon, Avatar, Code, Textarea, Select, Checkbox, Radio, Switch, List, Tabs, Accordion, Tree, ProgressBar, Toast, Skeleton, Modal, Drawer, Popover, ContextMenu, Tooltip, ConfirmDialog. `Table` is also **not virtualised** — that is Phase 6, and needed only for large sets.

An earlier version of this file listed the whole set as though it existed. That is the failure this section now avoids: a consumer reads the catalogue, writes `Select(...)`, and finds out at `tsc` time.

Forms deserve a specific note: because contracts already carry `inputSchema`, a form can be generated from a contract with correct types, correct required/optional handling, and validation that matches the server exactly — because it *is* the server's schema. Client and server validation cannot drift, since there is only one schema.

Anything beyond this set is an app's own component until three apps need it, at which point it moves into the framework. Growing the library on demonstrated demand keeps it from accumulating components nobody uses.
