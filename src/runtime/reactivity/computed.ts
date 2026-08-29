import type { ReadonlySignal, ISource, ISubscriber } from './types.js';
import { NodeState } from './types.js';
import {
    type IComputedNode,
    recordDependency,
    getActiveComputedStack,
    pushActiveComputed,
    popActiveComputed,
    getCurrentSubscriber,
    setCurrentSubscriber,
} from './context.js';

let computedCounter = 0;

type ValueContainer<T> = { hasValue: false } | { hasValue: true; value: T };

/**
 * ComputedNode: a derived, cached, lazy reactive value.
 *
 * Implements a 3-state push-pull invalidation model (CLEAN, CHECK, DIRTY).
 * Invalidation marks downstream nodes as CHECK/DIRTY without evaluating.
 * Recomputation happens lazily upon read, verifying dependency versions
 * to avoid spurious computations when upstream values did not change.
 */
class ComputedNode<T> implements IComputedNode {
    private computeFn: () => T;
    public readonly name: string;
    private valueContainer: ValueContainer<T> = { hasValue: false };
    public version = 0;
    public state: NodeState = NodeState.DIRTY;

    private subscribers: Set<ISubscriber> = new Set();
    private dependencies: Set<ISource> = new Set();
    private dependencyVersions: Map<ISource, number> = new Map();
    private currentRunDependencies: Set<ISource> | null = null;

    constructor(fn: () => T, name?: string) {
        this.computeFn = fn;
        this.name = name ?? `computed#${++computedCounter}`;
    }

    addSubscriber(sub: ISubscriber): void {
        this.subscribers.add(sub);
    }

    removeSubscriber(sub: ISubscriber): void {
        this.subscribers.delete(sub);
    }

    addDependency(source: ISource): void {
        if (this.currentRunDependencies !== null) {
            this.currentRunDependencies.add(source);
        }
    }

    notifyDirty(): void {
        if (this.state !== NodeState.DIRTY) {
            this.state = NodeState.DIRTY;
            this.notifySubscribersCheck();
        }
    }

    notifyCheck(): void {
        if (this.state === NodeState.CLEAN) {
            this.state = NodeState.CHECK;
            this.notifySubscribersCheck();
        }
    }

    private notifySubscribersCheck(): void {
        if (this.subscribers.size === 0) return;
        const subs = Array.from(this.subscribers);
        for (const sub of subs) {
            sub.notifyCheck();
        }
    }

    updateIfNecessary(): void {
        if (this.state === NodeState.CLEAN) {
            return;
        }

        if (this.state === NodeState.CHECK) {
            for (const dep of this.dependencies) {
                if ('updateIfNecessary' in dep && typeof dep.updateIfNecessary === 'function') {
                    dep.updateIfNecessary();
                }
                const recordedVersion = this.dependencyVersions.get(dep);
                if (recordedVersion === undefined || recordedVersion !== dep.version) {
                    this.state = NodeState.DIRTY;
                    break;
                }
            }
        }

        if (this.state === NodeState.DIRTY) {
            this.recompute();
        } else {
            this.state = NodeState.CLEAN;
        }
    }

    private recompute(): void {
        const stack = getActiveComputedStack();
        const cycleIndex = stack.indexOf(this);
        if (cycleIndex !== -1) {
            const cyclePath = stack
                .slice(cycleIndex)
                .map(c => c.name)
                .concat(this.name)
                .join(' -> ');
            throw new Error(`Cycle detected in computed: ${cyclePath}`);
        }

        pushActiveComputed(this);
        const prevSubscriber = setCurrentSubscriber(this);
        const newDeps = new Set<ISource>();
        this.currentRunDependencies = newDeps;

        try {
            const nextValue = this.computeFn();

            // Dynamic dependency tracking: unhook stale dependencies
            for (const oldDep of this.dependencies) {
                if (!newDeps.has(oldDep)) {
                    oldDep.removeSubscriber(this);
                }
            }
            // Subscribe to newly accessed dependencies
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

            if (!this.valueContainer.hasValue || !Object.is(this.valueContainer.value, nextValue)) {
                this.valueContainer = { hasValue: true, value: nextValue };
                this.version++;
            }
            this.state = NodeState.CLEAN;
        } finally {
            this.currentRunDependencies = null;
            setCurrentSubscriber(prevSubscriber);
            popActiveComputed();
        }
    }

    read(): T {
        this.updateIfNecessary();
        recordDependency(this);
        let container = this.valueContainer;
        if (container.hasValue) {
            return container.value;
        }
        this.recompute();
        container = this.valueContainer;
        if (container.hasValue) {
            return container.value;
        }
        throw new Error('Computed failed to produce a value');
    }

    peek(): T {
        this.updateIfNecessary();
        let container = this.valueContainer;
        if (container.hasValue) {
            return container.value;
        }
        this.recompute();
        container = this.valueContainer;
        if (container.hasValue) {
            return container.value;
        }
        throw new Error('Computed failed to produce a value');
    }
}

/**
 * Creates a derived reactive computed signal.
 *
 * Computeds are lazy (evaluated on read, not write), cached, glitch-free,
 * and pure (writes inside throw an error).
 */
export function computed<T>(fn: () => T, name?: string): ReadonlySignal<T> {
    const node = new ComputedNode(fn, name);
    const getter = () => node.read();
    const comp: ReadonlySignal<T> = Object.assign(getter, {
        peek: () => node.peek(),
    });
    return comp;
}
