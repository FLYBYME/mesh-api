import { describe, it, expect } from 'vitest';
import { signal, computed, effect, batch, resource, createScope, flushSync } from '../src/runtime/reactivity/index.js';

// Effects are scheduled on a microtask, not run synchronously on write -- that is the design
// ("synchronous writes in the same tick are coalesced into one flush", spec/05), so a write
// followed by an immediate assertion is testing the scheduler, not the property. flushSync()
// after each write is the intended idiom and is what the framework's own tests use.

// Written independently of the dispatch's own tests, against the properties that are easy to
// claim and hard to actually get right. A reactive core that fails any of these passes hand-written
// happy-path tests and is still wrong in a way every consumer inherits.

describe('adversarial: glitch freedom', () => {
    it('runs a diamond dependent exactly once per source change, never on a mixed pair', () => {
        const a = signal(1);
        const b = computed(() => a() * 2);
        const c = computed(() => a() * 10);
        const seen: string[] = [];
        effect(() => { seen.push(`${b()}/${c()}`); });

        expect(seen).toEqual(['2/10']);
        a.set(2);
        flushSync();
        // A naive implementation logs '4/10' (b updated, c stale) then '4/20'.
        expect(seen).toEqual(['2/10', '4/20']);
    });

    it('holds through an asymmetric diamond with different path depths', () => {
        const a = signal(1);
        const b = computed(() => a() + 1);
        const deep = computed(() => computedChain(b));
        const seen: number[] = [];
        effect(() => { seen.push(deep() + a()); });
        a.set(5);
        flushSync();
        expect(seen.length).toBe(2);
        expect(seen[1]).toBe((5 + 1) * 2 + 5);
    });

    function computedChain(b: () => number): number { return b() * 2; }
});

describe('adversarial: dynamic dependencies', () => {
    it('unsubscribes from a branch it no longer reads', () => {
        const useA = signal(true);
        const a = signal('a1');
        const b = signal('b1');
        let runs = 0;
        effect(() => { runs++; useA() ? a() : b(); });

        expect(runs).toBe(1);
        useA.set(false);          // now reads b, no longer a
        flushSync();
        expect(runs).toBe(2);

        a.set('a2');              // must NOT re-run: a is no longer a dependency
        flushSync();
        expect(runs).toBe(2);

        b.set('b2');              // must re-run
        flushSync();
        expect(runs).toBe(3);
    });
});

describe('adversarial: nested effects', () => {
    it('disposes the inner effect when the outer re-runs, instead of leaking one per run', () => {
        const outer = signal(0);
        const inner = signal(0);
        let innerRuns = 0;

        effect(() => {
            outer();
            effect(() => { inner(); innerRuns++; });
        });

        expect(innerRuns).toBe(1);
        outer.set(1);
        flushSync();
        outer.set(2);
        flushSync();
        outer.set(3);
        flushSync();
        // Four inner effects have now been *created*. If the old ones were not disposed, a single
        // write to `inner` re-runs all four.
        const before = innerRuns;
        inner.set(1);
        flushSync();
        expect(innerRuns - before).toBe(1);
    });
});

describe('adversarial: batching and equality', () => {
    it('coalesces writes to three signals into one effect run', () => {
        const a = signal(0), b = signal(0), c = signal(0);
        let runs = 0;
        effect(() => { a(); b(); c(); runs++; });
        expect(runs).toBe(1);
        batch(() => { a.set(1); b.set(1); c.set(1); });
        expect(runs).toBe(2);
    });

    it('notifies nobody when a write does not change the value', () => {
        const s = signal(1);
        let runs = 0;
        effect(() => { s(); runs++; });
        s.set(1);
        flushSync();
        s.set(1);
        flushSync();
        expect(runs).toBe(1);
    });
});

describe('adversarial: laziness', () => {
    it('does not evaluate a computed nobody reads', () => {
        const a = signal(1);
        let evaluations = 0;
        const derived = computed(() => { evaluations++; return a() * 2; });
        expect(evaluations).toBe(0);
        a.set(2);
        flushSync();
        expect(evaluations).toBe(0);
        expect(derived()).toBe(4);
        expect(evaluations).toBe(1);
    });
});

describe('adversarial: resource', () => {
    it('discards a stale response that lands after a newer one', async () => {
        const id = signal(1);
        const resolvers = new Map<number, (v: string) => void>();
        const res = resource(() => {
            const current = id();
            return new Promise<string>(resolve => { resolvers.set(current, resolve); });
        });

        await Promise.resolve();
        id.set(2);
        flushSync();
        await Promise.resolve();
        await Promise.resolve();

        // Resolve the NEW request first, then the stale one. The stale value must never win.
        resolvers.get(2)?.('value-for-2');
        await new Promise(r => setTimeout(r, 5));
        resolvers.get(1)?.('value-for-1');
        await new Promise(r => setTimeout(r, 5));

        expect(res.data()).toBe('value-for-2');
    });

    it('keeps the last good data when a refetch errors', async () => {
        let shouldFail = false;
        const trigger = signal(0);
        const res = resource(async () => {
            trigger();
            if (shouldFail) throw new Error('boom');
            return 'good';
        });
        await new Promise(r => setTimeout(r, 5));
        expect(res.data()).toBe('good');

        shouldFail = true;
        trigger.set(1);
        flushSync();
        await new Promise(r => setTimeout(r, 5));

        expect(res.error()).toBeInstanceOf(Error);
        expect(res.data()).toBe('good');
    });
});

describe('adversarial: scope disposal', () => {
    it('tears down effects created inside it, and is idempotent', () => {
        const s = signal(0);
        let runs = 0;
        const scope = createScope();
        scope.run(() => { effect(() => { s(); runs++; }); });
        expect(runs).toBe(1);

        s.set(1);
        flushSync();
        expect(runs).toBe(2);

        scope.dispose();
        s.set(2);
        flushSync();
        expect(runs).toBe(2);

        scope.dispose();
        expect(runs).toBe(2);
    });
});

describe('adversarial: purity enforcement', () => {
    it('throws rather than silently allowing a write inside a computed', () => {
        const a = signal(1);
        const bad = computed(() => { a.set(a() + 1); return a(); });
        expect(() => bad()).toThrow();
    });
});
