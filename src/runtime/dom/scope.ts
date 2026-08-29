import type { ReactiveScope } from '../reactivity/types.js';
import { getActiveScopeContext } from '../reactivity/context.js';

const nodeScopes = new WeakMap<Node, ReactiveScope>();

/**
 * Associates a ReactiveScope with a specific DOM Node.
 *
 * When the DOM tree containing this node is torn down, disposing the element
 * automatically cleans up all reactive subscriptions and event handlers attached
 * to this node or its descendants.
 */
export function attachScope(node: Node, scope: ReactiveScope): void {
    nodeScopes.set(node, scope);
}

/**
 * Retrieves the ReactiveScope associated with a DOM Node, if any.
 */
export function getScope(node: Node): ReactiveScope | undefined {
    return nodeScopes.get(node);
}

/**
 * Registers a cleanup callback with the currently active reactive scope, if one exists.
 *
 * Used by event listener bindings and custom observers to ensure resources are
 * freed when the containing component or branch unmounts.
 */
export function registerCleanup(cleanup: () => void): void {
    const active = getActiveScopeContext();
    if (active !== null) {
        active.addDisposable(cleanup);
    }
}

/**
 * Recursively disposes all reactive scopes associated with a DOM subtree.
 *
 * Walks the subtree starting from the given node to release memory and detach
 * signal subscriptions, preventing zombie effect runs after element removal.
 */
export function disposeElement(node: Node): void {
    if (node instanceof Element || node instanceof DocumentFragment) {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
        let current: Node | null = walker.currentNode;
        while (current !== null) {
            const scope = nodeScopes.get(current);
            if (scope !== undefined) {
                scope.dispose();
                nodeScopes.delete(current);
            }
            current = walker.nextNode();
        }
    }

    const selfScope = nodeScopes.get(node);
    if (selfScope !== undefined) {
        selfScope.dispose();
        nodeScopes.delete(node);
    }
}
