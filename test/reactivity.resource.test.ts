import { describe, it, expect } from 'vitest';
import { signal, resource, flushSync } from '../src/index.js';

describe('reactivity: resource', () => {
    it('initializes loading, transitions data on resolve', async () => {
        let resolvePromise!: (val: string) => void;
        const fetcher = () => new Promise<string>(resolve => {
            resolvePromise = resolve;
        });

        const cards = resource(fetcher);

        expect(cards.loading()).toBe(true);
        expect(cards.data()).toBeUndefined();
        expect(cards.error()).toBeNull();

        resolvePromise('board-data');
        await Promise.resolve(); // allow microtask resolve

        expect(cards.loading()).toBe(false);
        expect(cards.data()).toBe('board-data');
        expect(cards.error()).toBeNull();
        expect(cards()).toBe('board-data'); // callable
    });

    it('re-fetches automatically when a signal read inside the fetcher changes', async () => {
        const repo = signal('repo-a');
        const fetchLog: string[] = [];

        const board = resource(async () => {
            const currentRepo = repo();
            fetchLog.push(currentRepo);
            return `cards-for-${currentRepo}`;
        });

        await Promise.resolve(); // initial fetch resolve
        expect(board.data()).toBe('cards-for-repo-a');
        expect(fetchLog).toEqual(['repo-a']);

        // Changing repo triggers a refetch automatically
        repo.set('repo-b');
        flushSync();
        await Promise.resolve(); // refetch resolve

        expect(board.data()).toBe('cards-for-repo-b');
        expect(fetchLog).toEqual(['repo-a', 'repo-b']);
    });

    it('discards out-of-order responses (inverted resolution order does not clobber)', async () => {
        const repo = signal('slow');

        let resolveSlow!: (val: string) => void;
        let resolveFast!: (val: string) => void;

        const board = resource(() => {
            const r = repo();
            if (r === 'slow') {
                return new Promise<string>(resolve => {
                    resolveSlow = resolve;
                });
            } else {
                return new Promise<string>(resolve => {
                    resolveFast = resolve;
                });
            }
        });

        // Request 1 ('slow') is in flight
        expect(board.loading()).toBe(true);

        // Switch to 'fast' -> starts Request 2
        repo.set('fast');
        flushSync();
        expect(board.loading()).toBe(true);

        // Deliberately resolve Request 2 (fast) first:
        resolveFast('data-fast');
        await Promise.resolve();

        expect(board.loading()).toBe(false);
        expect(board.data()).toBe('data-fast');

        // Now resolve Request 1 (slow) LATER:
        resolveSlow('data-slow-stale');
        await Promise.resolve();

        // Stale response must be discarded; fast data must remain intact!
        expect(board.data()).toBe('data-fast');
        expect(board.loading()).toBe(false);
    });

    it('deduplicates in-flight requests on concurrent refetch()', async () => {
        let fetchCalls = 0;
        let resolveFetch!: (val: string) => void;

        const cards = resource(() => {
            fetchCalls++;
            return new Promise<string>(resolve => {
                resolveFetch = resolve;
            });
        });

        expect(fetchCalls).toBe(1);

        // Calling refetch while in-flight should return the existing in-flight promise
        const p1 = cards.refetch();
        const p2 = cards.refetch();

        expect(fetchCalls).toBe(1); // did not trigger new fetch

        resolveFetch('done');
        const [res1, res2] = await Promise.all([p1, p2]);

        expect(res1).toBe('done');
        expect(res2).toBe('done');
        expect(cards.data()).toBe('done');
    });

    it('populates error() and leaves last good data() intact on failure', async () => {
        let shouldFail = false;

        const res = resource(async () => {
            if (shouldFail) {
                throw new Error('Network timeout');
            }
            return 'good-data';
        });

        await Promise.resolve();
        expect(res.data()).toBe('good-data');
        expect(res.error()).toBeNull();
        expect(res.loading()).toBe(false);

        // Trigger refetch that fails
        shouldFail = true;
        await res.refetch();

        expect(res.loading()).toBe(false);
        expect(res.error()?.message).toBe('Network timeout');
        // Critical: last good data is NOT blanked
        expect(res.data()).toBe('good-data');
    });

    it('supports local mutation via .patch() and .mutate()', async () => {
        interface Card { id: string; title: string; }
        const board = resource<Card[]>(async () => [
            { id: '1', title: 'Task 1' },
            { id: '2', title: 'Task 2' },
        ]);

        await Promise.resolve();
        expect(board.data()).toEqual([
            { id: '1', title: 'Task 1' },
            { id: '2', title: 'Task 2' },
        ]);

        // .patch updates in place
        board.patch(cards => cards.map(c => c.id === '1' ? { ...c, title: 'Updated Task 1' } : c));
        expect(board.data()).toEqual([
            { id: '1', title: 'Updated Task 1' },
            { id: '2', title: 'Task 2' },
        ]);

        // .mutate replaces or transforms
        board.mutate(cards => [...(cards ?? []), { id: '3', title: 'Task 3' }]);
        expect(board.data()).toHaveLength(3);
    });

    it('disposes and cancels in-flight responses when disposed', async () => {
        let resolveFetch!: (val: string) => void;
        const res = resource(() => new Promise<string>(resolve => {
            resolveFetch = resolve;
        }));

        expect(res.loading()).toBe(true);

        res.dispose();

        resolveFetch('arrived-after-dispose');
        await Promise.resolve();

        // Data remains undefined because response was cancelled
        expect(res.data()).toBeUndefined();
    });
});
