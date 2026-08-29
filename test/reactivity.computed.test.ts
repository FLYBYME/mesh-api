import { describe, it, expect } from 'vitest';
import { signal, computed, effect, flushSync } from '../src/index.js';

describe('reactivity: computed', () => {
    it('derives and caches values', () => {
        const count = signal(2);
        let computeCount = 0;
        const doubled = computed(() => {
            computeCount++;
            return count() * 2;
        });

        expect(computeCount).toBe(0); // lazy on creation
        expect(doubled()).toBe(4);
        expect(computeCount).toBe(1);

        // cached on subsequent reads
        expect(doubled()).toBe(4);
        expect(computeCount).toBe(1);

        count.set(5);
        expect(computeCount).toBe(1); // lazy on write (not evaluated until read)
        expect(doubled()).toBe(10);
        expect(computeCount).toBe(2);
    });

    it('is lazy: unread computeds do not evaluate', () => {
        const a = signal(1);
        let evaluations = 0;
        const c = computed(() => {
            evaluations++;
            return a() + 10;
        });

        expect(evaluations).toBe(0);
        a.set(2);
        a.set(3);
        expect(evaluations).toBe(0);

        expect(c()).toBe(13);
        expect(evaluations).toBe(1);
    });

    it('unsubscribes from stale dynamic dependencies when branches change', () => {
        const cond = signal(true);
        const a = signal('A');
        const b = signal('B');
        let evaluations = 0;

        const result = computed(() => {
            evaluations++;
            return cond() ? a() : b();
        });

        expect(result()).toBe('A');
        expect(evaluations).toBe(1);

        // Switching cond to false subscribes to b and drops a
        cond.set(false);
        expect(result()).toBe('B');
        expect(evaluations).toBe(2);

        // Mutating a should NOT trigger or invalidate result since a is no longer a dependency
        a.set('A-modified');
        expect(result()).toBe('B');
        expect(evaluations).toBe(2); // still 2! Did not recompute!

        // Mutating b SHOULD invalidate result
        b.set('B-modified');
        expect(result()).toBe('B-modified');
        expect(evaluations).toBe(3);
    });

    it('detects direct cycles and throws an error naming the cycle', () => {
        const a: ReturnType<typeof computed<number>> = computed(() => a() + 1, 'cycleA');
        expect(() => a()).toThrow(/Cycle detected in computed: cycleA -> cycleA/);
    });

    it('detects indirect/transitive cycles and throws an error naming the cycle chain', () => {
        const a: ReturnType<typeof computed<number>> = computed(() => b() + 1, 'nodeA');
        const b: ReturnType<typeof computed<number>> = computed(() => c() + 1, 'nodeB');
        const c: ReturnType<typeof computed<number>> = computed(() => a() + 1, 'nodeC');

        expect(() => a()).toThrow(/Cycle detected in computed: nodeA -> nodeB -> nodeC -> nodeA/);
    });

    it('does not re-notify downstream when computed value does not change (fine-grained)', () => {
        const count = signal(1);
        const isBig = computed(() => count() > 10);
        let effectRuns = 0;

        effect(() => {
            effectRuns++;
            isBig();
        });

        expect(effectRuns).toBe(1);

        // count changes from 1 to 2 -> isBig is still false
        count.set(2);
        flushSync();
        expect(effectRuns).toBe(1); // effect did not re-run!

        count.set(20); // isBig flips to true
        flushSync();
        expect(effectRuns).toBe(2); // effect re-runs!
    });

    it('allows reading without tracking via .peek()', () => {
        const a = signal(10);
        const doubleA = computed(() => a() * 2);
        let runs = 0;

        effect(() => {
            runs++;
            doubleA.peek();
        });

        expect(runs).toBe(1);
        a.set(20);
        expect(runs).toBe(1); // peek did not track doubleA
    });
});
