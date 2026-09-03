/**
 * Exactly what this layer needs from a broker, and nothing more.
 *
 * Carried forward from `archive/pre-rewrite` because the reasoning behind it is still right, and it
 * is the kind of reasoning that gets lost in a rewrite:
 *
 *   > `IServiceBroker.call` is generic over `keyof IServiceToolRegistry` — the global registry that
 *   > `mesh generate` populates so every call site is checked against a real contract. This layer
 *   > dispatches a tool key chosen at run time, so it cannot name a member of that registry at
 *   > compile time.
 *   >
 *   > The tempting fix is to augment `IServiceToolRegistry` globally with an index signature. **Do
 *   > not do that.** It is a declaration-merged global, so it applies in every project that imports
 *   > this package: `broker.call('kanban.card_craete', { nonsense: 1 })` would then type-check
 *   > everywhere, silently deleting the safety the generated registry exists to provide. It is an
 *   > `as any` with an unbounded blast radius, and it is harder to spot than one because it looks
 *   > like a declaration.
 *
 * That was not hypothetical: the first version of the old `rest.ts` did exactly that, and a
 * deliberately misspelled tool key with a nonsense payload compiled clean.
 *
 * So the dynamic call is confined to this one structural interface. A real `IServiceBroker`
 * satisfies it, the untyped edge is one declaration wide, and nothing outside this package sees it.
 */

export interface CallMeta {
    readonly user?: { readonly id: string; readonly tenant_id?: string };
    readonly correlationId?: string;
}

export interface ApiBroker {
    call(tool: string, params: unknown, options?: { meta?: CallMeta }): Promise<unknown>;
}
