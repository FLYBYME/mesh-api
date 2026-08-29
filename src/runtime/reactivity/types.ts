/**
 * Core type definitions for the fine-grained reactivity system.
 *
 * The reactive graph consists of sources (producers of values such as signals and
 * computeds) and subscribers (consumers such as computeds and effects).
 */

export interface ReadonlySignal<T> {
    (): T;
    peek(): T;
}

export interface Signal<T> extends ReadonlySignal<T> {
    set(value: T): void;
    update(fn: (prev: T) => T): void;
}

export interface Resource<T> extends ReadonlySignal<T | undefined> {
    readonly data: ReadonlySignal<T | undefined>;
    readonly loading: ReadonlySignal<boolean>;
    readonly error: ReadonlySignal<Error | null>;
    refetch(): Promise<T | undefined>;
    patch(updater: (current: T) => T): void;
    mutate(value: T | undefined | ((prev: T | undefined) => T | undefined)): void;
    dispose(): void;
}

export interface ReactiveScope {
    run<T>(fn: () => T): T;
    dispose(): void;
}

export type CleanupFn = () => void;
export type EffectFn = () => void | CleanupFn;
export type DisposeFn = () => void;

export const enum NodeState {
    CLEAN = 0,
    CHECK = 1,
    DIRTY = 2,
}

export interface ISource {
    addSubscriber(sub: ISubscriber): void;
    removeSubscriber(sub: ISubscriber): void;
    readonly version: number;
}

export interface ISubscriber {
    notifyDirty(): void;
    notifyCheck(): void;
    addDependency(source: ISource): void;
}

export interface IDisposableContainer {
    addDisposable(dispose: () => void): void;
    removeDisposable(dispose: () => void): void;
}
