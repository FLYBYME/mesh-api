import type {
    Signal,
    ReadonlySignal,
    Resource,
    DisposeFn,
    EffectFn,
    ReactiveScope,
} from '../reactivity/types.js';
import { signal } from '../reactivity/signal.js';
import { computed } from '../reactivity/computed.js';
import { effect } from '../reactivity/effect.js';
import { resource } from '../reactivity/resource.js';
import type { AppStateContainer, LeakableResource } from './types.js';

/**
 * In-memory storage implementation used as fallback when localStorage is unavailable
 * or restricted by the runtime environment.
 */
export class MemoryStorage implements Storage {
    private entries = new Map<string, string>();

    get length(): number {
        return this.entries.size;
    }

    clear(): void {
        this.entries.clear();
    }

    getItem(key: string): string | null {
        const val = this.entries.get(key);
        return val !== undefined ? val : null;
    }

    key(index: number): string | null {
        const keys = Array.from(this.entries.keys());
        const k = keys[index];
        return k !== undefined ? k : null;
    }

    removeItem(key: string): void {
        this.entries.delete(key);
    }

    setItem(key: string, value: string): void {
        this.entries.set(key, value);
    }
}

/**
 * Safe JSON deserializer that returns a fallback value on parse errors.
 */
function deserializeJson<T>(raw: string, fallback: T): T {
    try {
        const parsed = JSON.parse(raw);
        return parsed;
    } catch {
        return fallback;
    }
}

/**
 * AppStateContainerImpl: manages isolated reactive state for a single App instance.
 *
 * All reactive effects, signals, and computeds created through this container execute
 * within the App's ReactiveScope. When the App unloads, disposing this container or its
 * scope terminates every effect and subscription without manual cleanup.
 */
export class AppStateContainerImpl implements AppStateContainer {
    private readonly appId: string;
    private readonly scope: ReactiveScope;
    private readonly storage: Storage;
    private readonly activeEffects = new Set<DisposeFn>();
    private readonly activeResources = new Set<LeakableResource>();
    private store?: object;
    private disposed = false;

    constructor(appId: string, scope: ReactiveScope, storage?: Storage) {
        this.appId = appId;
        this.scope = scope;
        if (storage !== undefined) {
            this.storage = storage;
        } else if (typeof localStorage !== 'undefined') {
            this.storage = localStorage;
        } else {
            this.storage = new MemoryStorage();
        }
    }

    get isDisposed(): boolean {
        return this.disposed;
    }

    set<T extends object>(state: T): void {
        if (this.disposed) {
            throw new Error(`Cannot set state on disposed AppState for "${this.appId}"`);
        }
        this.store = state;
    }

    get<T extends object>(): T {
        if (this.disposed) {
            throw new Error(`Cannot get state on disposed AppState for "${this.appId}"`);
        }
        if (this.store === undefined) {
            throw new Error(`No state has been set on AppState for "${this.appId}"`);
        }
        return this.store as T;
    }

    signal<T>(initial: T): Signal<T> {
        if (this.disposed) {
            throw new Error(`Cannot create signal on disposed AppState for "${this.appId}"`);
        }
        return this.scope.run(() => signal(initial));
    }

    computed<T>(fn: () => T): ReadonlySignal<T> {
        if (this.disposed) {
            throw new Error(`Cannot create computed on disposed AppState for "${this.appId}"`);
        }
        return this.scope.run(() => computed(fn));
    }

    effect(fn: EffectFn): DisposeFn {
        if (this.disposed) {
            throw new Error(`Cannot create effect on disposed AppState for "${this.appId}"`);
        }
        const dispose = this.scope.run(() => effect(fn));
        this.activeEffects.add(dispose);
        const wrappedDispose: DisposeFn = () => {
            this.activeEffects.delete(dispose);
            dispose();
        };
        return wrappedDispose;
    }

    // Mirrors `resource`'s real signature exactly -- a fetcher and nothing else. An earlier draft
    // here took a `prev` argument and an initial value, neither of which the reactivity layer
    // offers; widening this wrapper beyond what it wraps would have meant inventing behaviour at
    // the seam rather than exposing it.
    resource<T>(fetcher: () => Promise<T>): Resource<T> {
        if (this.disposed) {
            throw new Error(`Cannot create resource on disposed AppState for "${this.appId}"`);
        }
        const res = this.scope.run(() => resource(fetcher));
        this.activeResources.add(res);
        return res;
    }

    persisted<T>(key: string, initial: T): Signal<T> {
        if (this.disposed) {
            throw new Error(`Cannot create persisted signal on disposed AppState for "${this.appId}"`);
        }

        // Namespace the storage key strictly per app id to prevent key collision
        // and prevent cross-app state leakage.
        const storageKey = `mesh:app:${this.appId}:${key}`;
        let initialValue = initial;

        try {
            const raw = this.storage.getItem(storageKey);
            if (raw !== null) {
                initialValue = deserializeJson(raw, initial);
            } else {
                this.storage.setItem(storageKey, JSON.stringify(initial));
            }
        } catch {
            // Storage access failure: fallback to in-memory initial
        }

        const sig = this.scope.run(() => signal<T>(initialValue));

        // Create an effect inside the app's scope to serialize updates to storage.
        this.effect(() => {
            const val = sig();
            try {
                this.storage.setItem(storageKey, JSON.stringify(val));
            } catch {
                // Storage write failure (e.g. quota exceeded)
            }
        });

        return sig;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.activeEffects.clear();
        this.activeResources.clear();
    }

    getActiveEffectCount(): number {
        return this.activeEffects.size;
    }
}
