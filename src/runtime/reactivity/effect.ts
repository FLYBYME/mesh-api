import type { EffectFn, CleanupFn, DisposeFn, ISubscriber, ISource, IDisposableContainer } from './types.js';
import { NodeState } from './types.js';
import {
    type IEffectNode,
    scheduleEffect,
    getActiveScopeContext,
    setActiveScopeContext,
    getCurrentSubscriber,
    setCurrentSubscriber,
} from './context.js';

/**
 * EffectNode: a side-effect observer in the reactive graph.
 *
 * Runs immediately upon creation. Re-runs when read dependencies change.
 * Tracks dynamic dependencies, unregistering subscriptions that fall out of
 * scope after branch flips. Manages cleanup callbacks and nested effect disposal.
 */
class EffectNode implements ISubscriber, IEffectNode, IDisposableContainer {
    private effectFn: EffectFn;
    private state: NodeState = NodeState.DIRTY;
    private isDisposed = false;
    private isRunning = false;

    private cleanupFn: CleanupFn | undefined = undefined;
    private dependencies: Set<ISource> = new Set();
    private dependencyVersions: Map<ISource, number> = new Map();
    private currentRunDependencies: Set<ISource> | null = null;
    private childDisposables: Set<() => void> = new Set();
    private parentScope: IDisposableContainer | null = null;

    constructor(fn: EffectFn) {
        this.effectFn = fn;
        this.parentScope = getActiveScopeContext();
        if (this.parentScope !== null) {
            this.parentScope.addDisposable(() => this.dispose());
        }
        this.run();
    }

    addDisposable(dispose: () => void): void {
        if (this.isDisposed) {
            dispose();
            return;
        }
        this.childDisposables.add(dispose);
    }

    removeDisposable(dispose: () => void): void {
        this.childDisposables.delete(dispose);
    }

    private disposeChildren(): void {
        if (this.childDisposables.size === 0) return;
        const items = Array.from(this.childDisposables);
        this.childDisposables.clear();
        for (const item of items) {
            try {
                item();
            } catch {
                // Ignore child disposal errors to ensure all children are torn down
            }
        }
    }

    addDependency(source: ISource): void {
        if (this.currentRunDependencies !== null) {
            this.currentRunDependencies.add(source);
        }
    }

    notifyDirty(): void {
        if (this.isDisposed) return;
        if (this.state !== NodeState.DIRTY) {
            this.state = NodeState.DIRTY;
            scheduleEffect(this);
        }
    }

    notifyCheck(): void {
        if (this.isDisposed) return;
        if (this.state === NodeState.CLEAN) {
            this.state = NodeState.CHECK;
            scheduleEffect(this);
        }
    }

    runIfNeeded(): void {
        if (this.isDisposed || this.isRunning) return;
        if (this.state === NodeState.CLEAN) return;

        if (this.state === NodeState.CHECK) {
            for (const dep of this.dependencies) {
                if ('updateIfNecessary' in dep && typeof dep.updateIfNecessary === 'function') {
                    dep.updateIfNecessary();
                }
                const recorded = this.dependencyVersions.get(dep);
                if (recorded === undefined || recorded !== dep.version) {
                    this.state = NodeState.DIRTY;
                    break;
                }
            }
        }

        if (this.state === NodeState.DIRTY) {
            this.run();
        } else {
            this.state = NodeState.CLEAN;
        }
    }

    private run(): void {
        if (this.isDisposed || this.isRunning) return;
        this.isRunning = true;

        // Dispose nested effects created during the previous execution
        this.disposeChildren();

        // Run previous cleanup callback
        if (this.cleanupFn !== undefined) {
            try {
                this.cleanupFn();
            } catch {
                // Ensure effect still runs even if prior cleanup threw
            }
            this.cleanupFn = undefined;
        }

        const prevSubscriber = setCurrentSubscriber(this);
        const prevScope = setActiveScopeContext(this);
        const newDeps = new Set<ISource>();
        this.currentRunDependencies = newDeps;

        try {
            const cleanup = this.effectFn();
            if (typeof cleanup === 'function') {
                this.cleanupFn = cleanup;
            }

            for (const oldDep of this.dependencies) {
                if (!newDeps.has(oldDep)) {
                    oldDep.removeSubscriber(this);
                }
            }
            for (const newDep of newDeps) {
                if (!this.dependencies.has(newDep)) {
                    newDep.addSubscriber(this);
                }
            }
            this.dependencies = newDeps;

            this.dependencyVersions.clear();
            for (const dep of newDeps) {
                this.dependencyVersions.set(dep, dep.version);
            }
            this.state = NodeState.CLEAN;
        } finally {
            this.currentRunDependencies = null;
            setCurrentSubscriber(prevSubscriber);
            setActiveScopeContext(prevScope);
            this.isRunning = false;
        }
    }

    dispose(): void {
        if (this.isDisposed) return;
        this.isDisposed = true;
        this.state = NodeState.CLEAN;

        let cleanupErr: unknown = null;

        try {
            this.disposeChildren();
        } catch (err) {
            cleanupErr = err;
        }

        const cleanup = this.cleanupFn;
        this.cleanupFn = undefined;
        if (cleanup !== undefined) {
            try {
                cleanup();
            } catch (err) {
                if (cleanupErr === null) {
                    cleanupErr = err;
                }
            }
        }

        for (const dep of this.dependencies) {
            dep.removeSubscriber(this);
        }
        this.dependencies.clear();
        this.dependencyVersions.clear();

        if (cleanupErr !== null) {
            throw cleanupErr;
        }
    }
}

/**
 * Creates an active side-effect that runs immediately and re-runs on dependency changes.
 *
 * Returns a disposal function to cancel tracking and release all subscriptions.
 */
export function effect(fn: EffectFn): DisposeFn {
    const node = new EffectNode(fn);
    return () => node.dispose();
}
