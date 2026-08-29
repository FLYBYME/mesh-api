import { describe, it, expect } from 'vitest';
import { signal, computed, effect } from '../src/index.js';

describe('reactivity: signal', () => {
    it('initializes with a value and can be read by calling it', () => {
        const count = signal(0);
        expect(count()).toBe(0);
    });

    it('updates value via .set() and .update()', () => {
        const count = signal(10);
        count.set(20);
        expect(count()).toBe(20);

        count.update(n => n + 5);
        expect(count()).toBe(25);
    });

    it('reads current value without tracking via .peek()', () => {
        const count = signal(5);
        let effectRuns = 0;

        effect(() => {
            effectRuns++;
            // peek() should not subscribe
            count.peek();
        });

        expect(effectRuns).toBe(1);
        count.set(10);
        expect(effectRuns).toBe(1); // did not re-run
    });

    it('does not notify or increment version when setting identical value (Object.is)', () => {
        const count = signal(42);
        let runs = 0;

        effect(() => {
            runs++;
            count();
        });

        expect(runs).toBe(1);
        count.set(42);
        expect(runs).toBe(1);

        const nanSig = signal(NaN);
        let nanRuns = 0;
        effect(() => {
            nanRuns++;
            nanSig();
        });
        expect(nanRuns).toBe(1);
        nanSig.set(NaN); // Object.is(NaN, NaN) === true
        expect(nanRuns).toBe(1);
    });

    it('throws when writing to a signal inside a computed', () => {
        const a = signal(1);
        const b = signal(2);

        const c = computed(() => {
            b.set(100); // writing inside computed must throw
            return a() * 2;
        });

        expect(() => c()).toThrow('Cannot write to a signal inside a computed');
    });
});
