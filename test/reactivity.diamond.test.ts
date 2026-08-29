import { describe, it, expect } from 'vitest';
import { signal, computed, effect, batch } from '../src/index.js';

describe('reactivity: glitch-free diamond dependency', () => {
    it('executes terminal effect exactly once per root change without intermediate glitch state', () => {
        // Classic diamond:
        //       a
        //      / \
        //     b   c
        //      \ /
        //       d
        const a = signal(1);
        const b = computed(() => a() * 2);
        const c = computed(() => a() * 3);
        const d = computed(() => `${b()}+${c()}`);

        const observed: string[] = [];
        let effectRuns = 0;

        effect(() => {
            effectRuns++;
            observed.push(d());
        });

        expect(effectRuns).toBe(1);
        expect(observed).toEqual(['2+3']);

        // Write to root signal
        batch(() => {
            a.set(2);
        });

        // Effect must run exactly once for the change to a
        expect(effectRuns).toBe(2);
        // And must never observe a mixed state like '4+3' or '2+6'
        expect(observed).toEqual(['2+3', '4+6']);

        batch(() => {
            a.set(10);
        });

        expect(effectRuns).toBe(3);
        expect(observed).toEqual(['2+3', '4+6', '20+30']);
    });

    it('evaluates deep multi-layer DAG consistently', () => {
        // Multi-level diamond graph:
        //       s
        //      / \
        //     a1  a2
        //     | \ / |
        //     b1  b2
        //      \ /
        //       c
        const s = signal(1);

        const a1 = computed(() => s() + 1); // 2
        const a2 = computed(() => s() * 10); // 10

        const b1 = computed(() => a1() + a2()); // 12
        const b2 = computed(() => a1() * 2 + a2()); // 14

        const c = computed(() => b1() + b2()); // 26

        const recorded: number[] = [];
        let effectCount = 0;

        effect(() => {
            effectCount++;
            recorded.push(c());
        });

        expect(effectCount).toBe(1);
        expect(recorded).toEqual([26]);

        batch(() => {
            s.set(2);
            // a1 = 3, a2 = 20, b1 = 23, b2 = 26, c = 49
        });

        expect(effectCount).toBe(2);
        expect(recorded).toEqual([26, 49]);
    });
});
