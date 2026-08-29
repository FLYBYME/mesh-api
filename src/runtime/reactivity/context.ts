import type { ISubscriber, ISource, IDisposableContainer } from './types.js';

/**
 * Global execution context for reactive dependency tracking, scope hierarchy,
 * batching, and computed cycle detection.
 *
 * Threading context through these module-level pointers avoids passing tracking
 * handles through every user function signature.
 */

export interface IComputedNode extends ISource, ISubscriber {
    readonly name: string;
    updateIfNecessary(): void;
}

export interface IEffectNode {
    runIfNeeded(): void;
}

let currentSubscriber: ISubscriber | null = null;
let activeScopeContext: IDisposableContainer | null = null;
const activeComputedStack: IComputedNode[] = [];

let batchDepth = 0;
let microtaskQueued = false;
let isFlushing = false;

const pendingEffects: Set<IEffectNode> = new Set();

export function getCurrentSubscriber(): ISubscriber | null {
    return currentSubscriber;
}

export function setCurrentSubscriber(sub: ISubscriber | null): ISubscriber | null {
    const prev = currentSubscriber;
    currentSubscriber = sub;
    return prev;
}

export function getActiveScopeContext(): IDisposableContainer | null {
    return activeScopeContext;
}

export function setActiveScopeContext(scope: IDisposableContainer | null): IDisposableContainer | null {
    const prev = activeScopeContext;
    activeScopeContext = scope;
    return prev;
}

export function getActiveComputedStack(): readonly IComputedNode[] {
    return activeComputedStack;
}

export function pushActiveComputed(node: IComputedNode): void {
    activeComputedStack.push(node);
}

export function popActiveComputed(): IComputedNode | undefined {
    return activeComputedStack.pop();
}

/**
 * Ensures signals cannot be written inside a computed function.
 * Computeds must remain pure derivation functions without side effects.
 */
export function assertNotInComputed(): void {
    if (activeComputedStack.length > 0) {
        throw new Error('Cannot write to a signal inside a computed');
    }
}

/**
 * Records a dependency between the currently evaluating subscriber and the given source.
 */
export function recordDependency(source: ISource): void {
    if (currentSubscriber !== null) {
        currentSubscriber.addDependency(source);
        source.addSubscriber(currentSubscriber);
    }
}

export function getBatchDepth(): number {
    return batchDepth;
}

export function incrementBatchDepth(): void {
    batchDepth++;
}

export function decrementBatchDepth(): void {
    batchDepth--;
    if (batchDepth === 0) {
        flushPendingEffects();
    }
}

export function scheduleEffect(effect: IEffectNode): void {
    pendingEffects.add(effect);
    if (batchDepth === 0 && !microtaskQueued) {
        microtaskQueued = true;
        queueMicrotask(() => {
            microtaskQueued = false;
            flushPendingEffects();
        });
    }
}

export function flushPendingEffects(): void {
    if (isFlushing || batchDepth > 0) return;
    isFlushing = true;
    try {
        let iterations = 0;
        while (pendingEffects.size > 0) {
            iterations++;
            if (iterations > 10000) {
                pendingEffects.clear();
                throw new Error('Maximum reactive flush depth exceeded (possible infinite effect loop)');
            }
            const batchToRun = Array.from(pendingEffects);
            pendingEffects.clear();
            for (const eff of batchToRun) {
                eff.runIfNeeded();
            }
        }
    } finally {
        isFlushing = false;
    }
}
