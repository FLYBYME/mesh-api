import type { Signal, ISource, ISubscriber } from './types.js';
import { assertNotInComputed, recordDependency } from './context.js';

/**
 * SignalNode: the leaf state primitive.
 *
 * Holds a value and an incrementing version counter. Writes notify subscribers
 * only when the new value differs from the current value under Object.is equality.
 */
class SignalNode<T> implements ISource {
    private value: T;
    private subscribers: Set<ISubscriber> = new Set();
    public version = 1;

    constructor(initialValue: T) {
        this.value = initialValue;
    }

    read(): T {
        recordDependency(this);
        return this.value;
    }

    peek(): T {
        return this.value;
    }

    set(nextValue: T): void {
        assertNotInComputed();
        if (Object.is(this.value, nextValue)) {
            return;
        }
        this.value = nextValue;
        this.version++;
        this.notifySubscribers();
    }

    update(fn: (prev: T) => T): void {
        this.set(fn(this.value));
    }

    addSubscriber(sub: ISubscriber): void {
        this.subscribers.add(sub);
    }

    removeSubscriber(sub: ISubscriber): void {
        this.subscribers.delete(sub);
    }

    private notifySubscribers(): void {
        if (this.subscribers.size === 0) return;
        const subs = Array.from(this.subscribers);
        for (const sub of subs) {
            sub.notifyDirty();
        }
    }
}

/**
 * Creates a reactive signal holding state `T`.
 *
 * Calling the signal reads its value and tracks subscriptions.
 * `.set(val)` writes a new value, notifying dependents only if changed.
 * `.update(fn)` applies a transformation function to the current value.
 */
export function signal<T>(initialValue: T): Signal<T> {
    const node = new SignalNode(initialValue);
    const getter = () => node.read();
    const sig: Signal<T> = Object.assign(getter, {
        set: (v: T) => node.set(v),
        update: (fn: (prev: T) => T) => node.update(fn),
        peek: () => node.peek(),
    });
    return sig;
}
