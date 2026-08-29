import { describe, it, expect } from 'vitest';
import { signal, computed, effect, batch, untrack, flushSync } from '../src/index.js';

describe('reactivity: effect', () => {
    it('runs immediately upon creation and re-runs on dependency changes', () => {
        const count = signal(0);
        let runs = 0;
        let lastSeen = -1;

        effect(() => {
            runs++;
            lastSeen = count();
        });

        expect(runs).toBe(1);
        expect(lastSeen).toBe(0);

        count.set(1);
        flushSync();
        expect(runs).toBe(2);
        expect(lastSeen).toBe(1);
    });

    it('dynamically unsubscribes from stale dependencies after branch flip', () => {
        const cond = signal(true);
        const a = signal('A');
        const b = signal('B');
        const logs: string[] = [];

        effect(() => {
            if (cond()) {
                logs.push(a());
            } else {
                logs.push(b());
            }
        });

        expect(logs).toEqual(['A']);

        // Flip cond to false
        cond.set(false);
        flushSync();
        expect(logs).toEqual(['A', 'B']);

        // Writing to 'a' should NOT trigger effect because 'a' is no longer in the active branch
        a.set('A2');
        flushSync();
        expect(logs).toEqual(['A', 'B']); // did not re-run!

        // Writing to 'b' SHOULD trigger effect
        b.set('B2');
        flushSync();
        expect(logs).toEqual(['A', 'B', 'B2']);
    });

    it('batches synchronous writes inside batch() into a single flush', () => {
        const a = signal(0);
        const b = signal(0);
        const c = signal(0);
        let runs = 0;

        effect(() => {
            runs++;
            a();
            b();
            c();
        });

        expect(runs).toBe(1);

        batch(() => {
            a.set(1);
            b.set(2);
            c.set(3);
        });

        // Dependent effect must have run only once for all three writes
        expect(runs).toBe(2);
    });

    it('coalesces multiple synchronous writes outside batch into a single microtask flush', async () => {
        const a = signal(10);
        const b = signal(20);
        const c = signal(30);
        let runs = 0;

        effect(() => {
            runs++;
            a();
            b();
            c();
        });

        expect(runs).toBe(1);

        a.set(11);
        b.set(21);
        c.set(31);

        // Before microtask tick finishes, effect has not run multiple times
        expect(runs).toBe(1);

        await new Promise<void>(resolve => queueMicrotask(() => resolve()));

        expect(runs).toBe(2);
    });

    it('disposes and unsubscribes from all dependencies cleanly', () => {
        const count = signal(0);
        let runs = 0;

        const dispose = effect(() => {
            runs++;
            count();
        });

        expect(runs).toBe(1);

        count.set(1);
        flushSync();
        expect(runs).toBe(2);

        dispose();
        // Idempotent
        dispose();

        count.set(2);
        flushSync();
        expect(runs).toBe(2); // no more runs after dispose
    });

    it('runs cleanup function before re-run and upon disposal', () => {
        const count = signal(0);
        const cleanups: number[] = [];

        const dispose = effect(() => {
            const current = count();
            return () => {
                cleanups.push(current);
            };
        });

        expect(cleanups).toEqual([]);

        count.set(1);
        flushSync();
        expect(cleanups).toEqual([0]);

        count.set(2);
        flushSync();
        expect(cleanups).toEqual([0, 1]);

        dispose();
        expect(cleanups).toEqual([0, 1, 2]);
    });

    it('disposes nested inner effects when outer effect re-runs (no inner effect leak)', () => {
        const outer = signal(0);
        const inner = signal(0);

        let outerRuns = 0;
        let innerRuns = 0;

        const disposeOuter = effect(() => {
            outerRuns++;
            outer(); // outer reads outer

            effect(() => {
                innerRuns++;
                inner(); // inner reads inner
            });
        });

        expect(outerRuns).toBe(1);
        expect(innerRuns).toBe(1);

        // When outer re-runs, the previous inner effect must be disposed
        // and exactly one new inner effect created
        outer.set(1);
        flushSync();
        expect(outerRuns).toBe(2);
        expect(innerRuns).toBe(2);

        outer.set(2);
        flushSync();
        expect(outerRuns).toBe(3);
        expect(innerRuns).toBe(3);

        // Now updating inner should trigger ONLY the one active inner effect (runs becomes 4, not 4+2+1)
        inner.set(10);
        flushSync();
        expect(innerRuns).toBe(4);

        // Disposing outer disposes the remaining inner effect
        disposeOuter();
        inner.set(20);
        flushSync();
        expect(innerRuns).toBe(4); // inner did not run because it was torn down
    });

    it('untracks dependencies using untrack()', () => {
        const tracked = signal(1);
        const untracked = signal(100);
        let runs = 0;
        let seenUntracked = 0;

        effect(() => {
            runs++;
            tracked();
            seenUntracked = untrack(() => untracked());
        });

        expect(runs).toBe(1);
        expect(seenUntracked).toBe(100);

        // Mutating untracked should NOT trigger effect
        untracked.set(200);
        flushSync();
        expect(runs).toBe(1);

        // Mutating tracked SHOULD trigger effect and pick up newest untracked
        tracked.set(2);
        flushSync();
        expect(runs).toBe(2);
        expect(seenUntracked).toBe(200);
    });
});
