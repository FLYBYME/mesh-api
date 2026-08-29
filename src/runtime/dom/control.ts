import type { ReactiveScope, Signal } from '../reactivity/types.js';
import { signal } from '../reactivity/signal.js';
import { effect } from '../reactivity/effect.js';
import { createScope } from '../reactivity/scope.js';
import { getActiveScopeContext, setActiveScopeContext } from '../reactivity/context.js';
import { registerCleanup } from './scope.js';

interface ForRecord<T> {
    key: string | number;
    item: T;
    node: HTMLElement;
    scope: ReactiveScope;
    indexSignal: Signal<number>;
}

/**
 * Conditionally mounts and unmounts DOM subtrees based on a reactive condition.
 *
 * When the condition transitions, the outgoing branch's ReactiveScope is disposed
 * immediately, tearing down all active effects and event listeners.
 */
export function When<T, R extends Node = HTMLElement>(
    condition: () => T,
    thenBranch: (value: NonNullable<T>) => R,
    elseBranch?: () => Node | null | undefined,
): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const startMarker = document.createComment('mesh-when-start');
    const endMarker = document.createComment('mesh-when-end');
    fragment.appendChild(startMarker);
    fragment.appendChild(endMarker);

    const outerScopeContext = getActiveScopeContext();
    let currentScope: ReactiveScope | null = null;
    let currentNodes: Node[] = [];
    let prevValue: unknown = undefined;
    let isInitial = true;

    registerCleanup(() => {
        if (currentScope !== null) {
            currentScope.dispose();
            currentScope = null;
        }
    });

    effect(() => {
        const val = condition();
        const truthy = Boolean(val);

        if (!isInitial && val === prevValue) {
            return;
        }
        prevValue = val;

        if (currentScope !== null) {
            currentScope.dispose();
            currentScope = null;
        }

        for (const node of currentNodes) {
            node.parentNode?.removeChild(node);
        }
        currentNodes = [];

        const prevScope = setActiveScopeContext(outerScopeContext);
        const scope = createScope();
        setActiveScopeContext(prevScope);

        currentScope = scope;

        let branchResult: Node | null = null;
        scope.run(() => {
            if (truthy) {
                const nonNullVal = val as NonNullable<T>;
                branchResult = thenBranch(nonNullVal);
            } else if (elseBranch !== undefined) {
                const res = elseBranch();
                if (res instanceof Node) {
                    branchResult = res;
                }
            }
        });

        if (branchResult !== null) {
            const resultNode: Node = branchResult;
            const nodesToAdd = resultNode instanceof DocumentFragment
                ? Array.from(resultNode.childNodes)
                : [resultNode];

            if (isInitial) {
                for (const node of nodesToAdd) {
                    fragment.insertBefore(node, endMarker);
                    currentNodes.push(node);
                }
            } else {
                const parent = endMarker.parentNode;
                if (parent !== null) {
                    for (const node of nodesToAdd) {
                        parent.insertBefore(node, endMarker);
                        currentNodes.push(node);
                    }
                }
            }
        }

        isInitial = false;
    });

    return fragment;
}

/**
 * Keyed list rendering that preserves DOM node identity across moves and reorders.
 *
 * Moving an item in the list moves its existing HTMLElement rather than reconstructing it,
 * preserving focus, text selection, scroll position, and local component state.
 * Throws when encountering duplicate keys to prevent silent DOM corruption.
 */
export function For<T>(
    items: (() => readonly T[]) | Signal<readonly T[]> | readonly T[],
    render: (item: T, index: () => number) => HTMLElement,
    keyFn: (item: T) => string | number,
): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const startMarker = document.createComment('mesh-for-start');
    const endMarker = document.createComment('mesh-for-end');
    fragment.appendChild(startMarker);
    fragment.appendChild(endMarker);

    const outerScopeContext = getActiveScopeContext();
    let prevRecords: ForRecord<T>[] = [];
    let isInitial = true;

    registerCleanup(() => {
        for (const rec of prevRecords) {
            rec.scope.dispose();
        }
        prevRecords = [];
    });

    effect(() => {
        const raw = typeof items === 'function' ? items() : items;
        const list: readonly T[] = Array.isArray(raw) ? raw : [];

        // Validate key uniqueness up front
        const nextKeys = new Set<string | number>();
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (item === undefined) continue;
            const key = keyFn(item);
            if (nextKeys.has(key)) {
                throw new Error(`Duplicate key "${key}" found in For() list`);
            }
            nextKeys.add(key);
        }

        const prevMap = new Map<string | number, ForRecord<T>>();
        for (const rec of prevRecords) {
            prevMap.set(rec.key, rec);
        }

        // Dispose and remove items that no longer exist
        for (const rec of prevRecords) {
            if (!nextKeys.has(rec.key)) {
                rec.node.parentNode?.removeChild(rec.node);
                rec.scope.dispose();
            }
        }

        // Build new records list, reusing existing nodes and scopes where available
        const nextRecords: ForRecord<T>[] = [];
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (item === undefined) continue;
            const key = keyFn(item);
            const existing = prevMap.get(key);

            if (existing !== undefined) {
                existing.indexSignal.set(i);
                existing.item = item;
                nextRecords.push(existing);
            } else {
                const prevScope = setActiveScopeContext(outerScopeContext);
                const itemScope = createScope();
                setActiveScopeContext(prevScope);

                const indexSignal = signal(i);
                let node: HTMLElement | null = null;
                itemScope.run(() => {
                    node = render(item, () => indexSignal());
                });

                if (node === null) {
                    throw new Error(`For() render callback must return an HTMLElement`);
                }

                nextRecords.push({
                    key,
                    item,
                    node,
                    scope: itemScope,
                    indexSignal,
                });
            }
        }

        // Place DOM nodes in target order
        if (isInitial) {
            for (const rec of nextRecords) {
                fragment.insertBefore(rec.node, endMarker);
            }
            isInitial = false;
        } else {
            const parent = endMarker.parentNode;
            if (parent !== null) {
                let anchor: Node = endMarker;
                for (let i = nextRecords.length - 1; i >= 0; i--) {
                    const rec = nextRecords[i];
                    if (rec === undefined) continue;
                    const node = rec.node;
                    if (node.nextSibling !== anchor) {
                        parent.insertBefore(node, anchor);
                    }
                    anchor = node;
                }
            }
        }

        prevRecords = nextRecords;
    });

    return fragment;
}
