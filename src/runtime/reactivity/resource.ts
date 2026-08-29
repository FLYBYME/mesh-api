import type { Resource, ReadonlySignal, Signal, IDisposableContainer } from './types.js';
import { signal } from './signal.js';
import { effect } from './effect.js';
import { getActiveScopeContext } from './context.js';

export type ResourceMutator<T> = (prev: T | undefined) => T | undefined;

function isResourceMutator<T>(val: T | undefined | ResourceMutator<T>): val is ResourceMutator<T> {
    return typeof val === 'function';
}

/**
 * ResourceImpl: manages async data fetching bound to the reactive graph.
 *
 * Features:
 * - Automatically refetches when signals read inside the fetcher change.
 * - Out-of-order response rejection: older requests never overwrite newer responses.
 * - In-flight deduplication for concurrent identical requests.
 * - Error preservation: failed refetches populate `error()` while leaving `data()` intact.
 */
class ResourceImpl<T> implements IDisposableContainer {
    private fetcher: () => Promise<T>;
    private _data: Signal<T | undefined>;
    private _loading: Signal<boolean>;
    private _error: Signal<Error | null>;

    private currentRequestId = 0;
    private currentInFlightPromise: Promise<T | undefined> | null = null;
    private isDisposed = false;
    private effectDispose: (() => void) | null = null;
    private childDisposables: Set<() => void> = new Set();
    private parentScope: IDisposableContainer | null = null;

    constructor(fetcher: () => Promise<T>) {
        this.fetcher = fetcher;
        this._data = signal<T | undefined>(undefined);
        this._loading = signal<boolean>(true);
        this._error = signal<Error | null>(null);

        this.parentScope = getActiveScopeContext();
        if (this.parentScope !== null) {
            this.parentScope.addDisposable(() => this.dispose());
        }

        this.effectDispose = effect(() => {
            this.triggerFetch();
        });
    }

    get data(): ReadonlySignal<T | undefined> {
        return this._data;
    }

    get loading(): ReadonlySignal<boolean> {
        return this._loading;
    }

    get error(): ReadonlySignal<Error | null> {
        return this._error;
    }

    patch(updater: (current: T) => T): void {
        const cur = this._data.peek();
        if (cur !== undefined) {
            this._data.set(updater(cur));
        }
    }

    mutate(value: T | undefined | ResourceMutator<T>): void {
        if (isResourceMutator(value)) {
            this._data.set(value(this._data.peek()));
        } else {
            this._data.set(value);
        }
    }

    private triggerFetch(): Promise<T | undefined> {
        if (this.isDisposed) {
            return Promise.resolve(undefined);
        }

        const requestId = ++this.currentRequestId;
        this._loading.set(true);

        let fetchPromise: Promise<T>;
        try {
            fetchPromise = this.fetcher();
        } catch (syncErr) {
            if (requestId === this.currentRequestId && !this.isDisposed) {
                const err = syncErr instanceof Error ? syncErr : new Error(String(syncErr));
                this._error.set(err);
                this._loading.set(false);
                this.currentInFlightPromise = null;
            }
            return Promise.resolve(undefined);
        }

        const resultPromise = fetchPromise.then(
            (result) => {
                if (this.isDisposed || requestId !== this.currentRequestId) {
                    return undefined;
                }
                this._data.set(result);
                this._error.set(null);
                this._loading.set(false);
                this.currentInFlightPromise = null;
                return result;
            },
            (rejection: unknown) => {
                if (this.isDisposed || requestId !== this.currentRequestId) {
                    return undefined;
                }
                const err = rejection instanceof Error ? rejection : new Error(String(rejection));
                this._error.set(err);
                this._loading.set(false);
                this.currentInFlightPromise = null;
                return undefined;
            }
        );

        this.currentInFlightPromise = resultPromise;
        return resultPromise;
    }

    refetch(): Promise<T | undefined> {
        if (this.isDisposed) {
            return Promise.resolve(undefined);
        }
        if (this.currentInFlightPromise !== null) {
            return this.currentInFlightPromise;
        }
        return this.triggerFetch();
    }

    addDisposable(dispose: () => void): void {
        this.childDisposables.add(dispose);
    }

    removeDisposable(dispose: () => void): void {
        this.childDisposables.delete(dispose);
    }

    dispose(): void {
        if (this.isDisposed) return;
        this.isDisposed = true;
        this.currentRequestId++;
        this.currentInFlightPromise = null;

        if (this.effectDispose !== null) {
            this.effectDispose();
            this.effectDispose = null;
        }

        for (const d of this.childDisposables) {
            try {
                d();
            } catch {
                // continue
            }
        }
        this.childDisposables.clear();
    }
}

/**
 * Creates a reactive Resource that asynchronously loads data and automatically
 * refetches when tracked signal dependencies change.
 */
export function resource<T>(fetcher: () => Promise<T>): Resource<T> {
    const impl = new ResourceImpl<T>(fetcher);
    const getter = () => impl.data();
    const res: Resource<T> = Object.assign(getter, {
        data: impl.data,
        loading: impl.loading,
        error: impl.error,
        refetch: () => impl.refetch(),
        patch: (updater: (current: T) => T) => impl.patch(updater),
        mutate: (value: T | undefined | ResourceMutator<T>) => impl.mutate(value),
        dispose: () => impl.dispose(),
        peek: () => impl.data.peek(),
    });
    return res;
}
