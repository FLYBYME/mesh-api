// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
    h,
    When,
    For,
} from '../../src/runtime/dom/index.js';
import {
    signal,
    createScope,
    flushSync,
} from '../../src/runtime/reactivity/index.js';

describe('DOM Control Flow: When & For', () => {
    describe('When()', () => {
        it('renders thenBranch when condition is truthy and passes the unwrapped value', () => {
            interface Reason { text: string }
            const reason = signal<Reason | null>({ text: 'Blocked by dependency' });

            const el = h('div', { class: 'card' },
                When(() => reason(), r => h('div', { class: 'blocked' }, r.text)),
            );

            const blockedEl = el.querySelector('.blocked');
            expect(blockedEl).not.toBeNull();
            expect(blockedEl?.textContent).toBe('Blocked by dependency');
        });

        it('renders elseBranch when condition is falsy', () => {
            const hasData = signal(false);

            const el = h('div',
                When(
                    () => hasData(),
                    () => h('div', { class: 'data' }, 'Data Loaded'),
                    () => h('div', { class: 'fallback' }, 'No Data Available'),
                ),
            );

            expect(el.querySelector('.data')).toBeNull();
            expect(el.querySelector('.fallback')?.textContent).toBe('No Data Available');

            hasData.set(true);
            flushSync();

            expect(el.querySelector('.data')?.textContent).toBe('Data Loaded');
            expect(el.querySelector('.fallback')).toBeNull();
        });

        it('disposes active branch when parent scope is disposed', () => {
            const show = signal(true);
            const counter = signal(0);
            let effectRuns = 0;

            const scope = createScope();
            let el!: HTMLElement;

            scope.run(() => {
                el = h('div',
                    When(() => show(), () => {
                        return h('div', { class: 'content' }, () => {
                            effectRuns++;
                            return `Value: ${counter()}`;
                        });
                    }),
                );
            });

            expect(effectRuns).toBe(1);
            expect(el.querySelector('.content')?.textContent).toBe('Value: 0');

            // Dispose parent scope
            scope.dispose();

            counter.set(1);
            flushSync();
            expect(effectRuns).toBe(1); // effect inside When was disposed
        });
    });

    describe('For()', () => {
        it('throws descriptive error on duplicate keys', () => {
            const items = [
                { id: '1', name: 'Alpha' },
                { id: '2', name: 'Beta' },
                { id: '1', name: 'Duplicate Alpha' },
            ];

            expect(() => {
                For(items, item => h('div', item.name), item => item.id);
            }).toThrow('Duplicate key "1" found in For() list');
        });

        it('handles inserting items at beginning, middle, and end', () => {
            const list = signal([
                { id: 'b', label: 'B' },
                { id: 'd', label: 'D' },
            ]);

            const container = h('div',
                For(list, item => h('span', { 'data-id': item.id }, item.label), item => item.id),
            );

            const initialNodes = Array.from(container.querySelectorAll('span'));
            const [nodeB, nodeD] = initialNodes;

            // Insert A at start, C in middle, E at end
            list.set([
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
                { id: 'c', label: 'C' },
                { id: 'd', label: 'D' },
                { id: 'e', label: 'E' },
            ]);
            flushSync();

            const nodesAfter = Array.from(container.querySelectorAll('span'));
            expect(nodesAfter.length).toBe(5);
            expect(nodesAfter.map(n => n.textContent).join('')).toBe('ABCDE');

            // Verify identity of preserved nodes B and D
            expect(nodesAfter[1]).toBe(nodeB);
            expect(nodesAfter[3]).toBe(nodeD);
        });

        it('handles removing items from beginning, middle, and end', () => {
            const list = signal([
                { id: '1', label: '1' },
                { id: '2', label: '2' },
                { id: '3', label: '3' },
                { id: '4', label: '4' },
                { id: '5', label: '5' },
            ]);

            const container = h('div',
                For(list, item => h('span', { 'data-id': item.id }, item.label), item => item.id),
            );

            const initialNodes = Array.from(container.querySelectorAll('span'));

            // Remove 1, 3, 5 -> leave 2 and 4
            list.set([
                { id: '2', label: '2' },
                { id: '4', label: '4' },
            ]);
            flushSync();

            const nodesAfter = Array.from(container.querySelectorAll('span'));
            expect(nodesAfter.length).toBe(2);
            expect(nodesAfter[0]).toBe(initialNodes[1]); // node 2
            expect(nodesAfter[1]).toBe(initialNodes[3]); // node 4
        });

        it('disposes scopes of removed items only and keeps surviving item scopes intact', () => {
            const list = signal(['1', '2', '3']);
            const sharedSignal = signal('active');
            const itemRuns: Record<string, number> = { '1': 0, '2': 0, '3': 0 };

            const container = h('div',
                For(list, id => {
                    return h('div', { 'data-id': id }, () => {
                        const current = itemRuns[id];
                        if (current !== undefined) {
                            itemRuns[id] = current + 1;
                        }
                        return `${id}: ${sharedSignal()}`;
                    });
                }, id => id),
            );

            expect(itemRuns['1']).toBe(1);
            expect(itemRuns['2']).toBe(1);
            expect(itemRuns['3']).toBe(1);

            // Remove item 2
            list.set(['1', '3']);
            flushSync();

            expect(container.querySelector('[data-id="2"]')).toBeNull();

            // Updating sharedSignal updates items 1 and 3, while 2 is dead
            sharedSignal.set('updated');
            flushSync();

            expect(itemRuns['1']).toBe(2);
            expect(itemRuns['2']).toBe(1); // stopped running
            expect(itemRuns['3']).toBe(2);
        });

        it('handles transitioning to and from empty list', () => {
            const list = signal<string[]>(['a', 'b']);

            const container = h('div',
                For(list, item => h('div', item), item => item),
            );

            expect(container.querySelectorAll('div').length).toBe(2);

            list.set([]);
            flushSync();
            expect(container.querySelectorAll('div').length).toBe(0);

            list.set(['x', 'y', 'z']);
            flushSync();
            expect(container.querySelectorAll('div').length).toBe(3);
        });
    });
});
