import type { ReactiveScope, IDisposableContainer } from './types.js';
import { getActiveScopeContext, setActiveScopeContext } from './context.js';

/**
 * ReactiveScopeImpl: owns a collection of reactive effects and resources.
 *
 * When an App or component unloads, its entire scope is disposed at once,
 * freeing subscriptions and aborting in-flight work without manual bookkeeping.
 */
class ReactiveScopeImpl implements ReactiveScope, IDisposableContainer {
    private disposables: Set<() => void> = new Set();
    private isDisposed = false;
    private parentScope: IDisposableContainer | null = null;

    constructor() {
        this.parentScope = getActiveScopeContext();
        if (this.parentScope !== null) {
            this.parentScope.addDisposable(() => this.dispose());
        }
    }

    addDisposable(dispose: () => void): void {
        if (this.isDisposed) {
            try {
                dispose();
            } catch {
                // continue
            }
            return;
        }
        this.disposables.add(dispose);
    }

    removeDisposable(dispose: () => void): void {
        this.disposables.delete(dispose);
    }

    run<T>(fn: () => T): T {
        if (this.isDisposed) {
            throw new Error('Cannot run within a disposed ReactiveScope');
        }
        const prev = setActiveScopeContext(this);
        try {
            return fn();
        } finally {
            setActiveScopeContext(prev);
        }
    }

    dispose(): void {
        if (this.isDisposed) return;
        this.isDisposed = true;

        if (this.parentScope !== null) {
            this.parentScope.removeDisposable(() => this.dispose());
        }

        const items = Array.from(this.disposables);
        this.disposables.clear();

        let firstError: unknown = null;
        for (const item of items) {
            try {
                item();
            } catch (err) {
                if (firstError === null) {
                    firstError = err;
                }
            }
        }

        if (firstError !== null) {
            throw firstError;
        }
    }
}

/**
 * Creates an isolated ReactiveScope to manage ownership and cleanup of effects and resources.
 */
export function createScope(): ReactiveScope {
    return new ReactiveScopeImpl();
}
