import { describe, it, expect } from 'vitest';
import { signal, effect, resource, createScope, flushSync } from '../src/index.js';

describe('reactivity: ReactiveScope', () => {
    it('disposes all effects and resources created inside scope.run()', () => {
        const count = signal(0);
        let effectRuns = 0;

        const scope = createScope();
        scope.run(() => {
            effect(() => {
                effectRuns++;
                count();
            });
        });

        expect(effectRuns).toBe(1);

        count.set(1);
        flushSync();
        expect(effectRuns).toBe(2);

        // Disposing scope tears down the effect
        scope.dispose();

        count.set(2);
        flushSync();
        expect(effectRuns).toBe(2); // no more runs
    });

    it('is idempotent: calling dispose() multiple times is safe', () => {
        const scope = createScope();
        let cleaned = false;

        scope.run(() => {
            effect(() => {
                return () => {
                    cleaned = true;
                };
            });
        });

        expect(cleaned).toBe(false);
        scope.dispose();
        expect(cleaned).toBe(true);

        // Calling dispose again should be safe and no-op
        expect(() => scope.dispose()).not.toThrow();
    });

    it('continues disposing remaining effects even if one throws during disposal', () => {
        const scope = createScope();
        let effect2Disposed = false;

        scope.run(() => {
            effect(() => {
                return () => {
                    throw new Error('Explosion during disposal');
                };
            });

            effect(() => {
                return () => {
                    effect2Disposed = true;
                };
            });
        });

        expect(() => scope.dispose()).toThrow('Explosion during disposal');
        // Critical: effect2 was still disposed!
        expect(effect2Disposed).toBe(true);
    });

    it('disposes nested child scopes when parent scope is disposed', () => {
        const count = signal(0);
        let childEffectRuns = 0;

        const parentScope = createScope();
        parentScope.run(() => {
            const childScope = createScope();
            childScope.run(() => {
                effect(() => {
                    childEffectRuns++;
                    count();
                });
            });
        });

        expect(childEffectRuns).toBe(1);

        count.set(1);
        flushSync();
        expect(childEffectRuns).toBe(2);

        // Disposing parent should tear down child scope
        parentScope.dispose();

        count.set(2);
        flushSync();
        expect(childEffectRuns).toBe(2);
    });

    it('disposes resources created inside scope.run()', async () => {
        let resolvePromise!: (val: string) => void;

        const scope = createScope();
        let cards: ReturnType<typeof resource<string>> | undefined;

        scope.run(() => {
            cards = resource(() => new Promise<string>(resolve => {
                resolvePromise = resolve;
            }));
        });

        expect(cards?.loading()).toBe(true);

        scope.dispose();

        resolvePromise('late-data');
        await Promise.resolve();

        // Stale late data cancelled
        expect(cards?.data()).toBeUndefined();
    });
});
