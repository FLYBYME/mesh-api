import {
    incrementBatchDepth,
    decrementBatchDepth,
    flushPendingEffects,
    getCurrentSubscriber,
    setCurrentSubscriber,
} from './context.js';

/**
 * Batches synchronous signal writes together, delaying effect execution until
 * the batch completes.
 */
export function batch<T>(fn: () => T): T {
    incrementBatchDepth();
    try {
        return fn();
    } finally {
        decrementBatchDepth();
    }
}

/**
 * Runs a function without tracking any signal reads as dependencies.
 */
export function untrack<T>(fn: () => T): T {
    const prev = getCurrentSubscriber();
    setCurrentSubscriber(null);
    try {
        return fn();
    } finally {
        setCurrentSubscriber(prev);
    }
}

/**
 * Flushes all pending scheduled effects synchronously.
 */
export function flushSync(): void {
    flushPendingEffects();
}
