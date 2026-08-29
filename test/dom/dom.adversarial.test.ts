// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
    h,
    When,
    For,
    Input,
    disposeElement,
    attachScope,
} from '../../src/runtime/dom/index.js';
import {
    signal,
    createScope,
    flushSync,
} from '../../src/runtime/reactivity/index.js';

describe('DOM adversarial guarantees', () => {
    it('updating one bound value touches exactly one DOM node and does not recreate its siblings', () => {
        const title = signal('Card 1');
        const repo = signal('flybyme/mesh');
        const agentId = signal('agent-42');

        const titleEl = h('div', { class: 'card-title' }, () => title());
        const metaEl = h('div', { class: 'card-meta' }, () => `${repo()} · ${agentId()}`);
        const staticSiblingBefore = h('div', { class: 'card-icon' }, '★');
        const staticSiblingAfter = h('div', { class: 'card-badge' }, 'active');

        const cardContainer = h('div', { class: 'card' },
            staticSiblingBefore,
            titleEl,
            metaEl,
            staticSiblingAfter,
        );

        // Capture initial DOM node identity references
        const initialBefore = staticSiblingBefore;
        const initialTitleEl = titleEl;
        const initialTitleTextNode = titleEl.firstChild;
        const initialMetaEl = metaEl;
        const initialMetaTextNode = metaEl.firstChild;
        const initialAfter = staticSiblingAfter;

        expect(cardContainer.children.length).toBe(4);
        expect(titleEl.textContent).toBe('Card 1');
        expect(metaEl.textContent).toBe('flybyme/mesh · agent-42');

        // Update ONLY the title signal
        title.set('Renamed Card');
        flushSync();

        // 1. Text updated correctly
        expect(titleEl.textContent).toBe('Renamed Card');

        // 2. Exact node identity preserved across all elements and siblings
        expect(cardContainer.children[0]).toBe(initialBefore);
        expect(cardContainer.children[1]).toBe(initialTitleEl);
        expect(cardContainer.children[2]).toBe(initialMetaEl);
        expect(cardContainer.children[3]).toBe(initialAfter);

        // 3. Exactly the single text node inside titleEl was mutated in-place
        expect(titleEl.firstChild).toBe(initialTitleTextNode);
        expect(metaEl.firstChild).toBe(initialMetaTextNode);

        // 4. Meta element and sibling contents remained untouched
        expect(metaEl.textContent).toBe('flybyme/mesh · agent-42');
        expect(staticSiblingBefore.textContent).toBe('★');
        expect(staticSiblingAfter.textContent).toBe('active');
    });

    it('For reordering preserves node identity', () => {
        interface Item {
            id: string;
            label: string;
        }

        const items = signal<Item[]>([
            { id: '1', label: 'Item 1' },
            { id: '2', label: 'Item 2' },
            { id: '3', label: 'Item 3' },
        ]);

        const listContainer = h('div', { class: 'list' },
            For(items, (item, index) => {
                return h('div', { class: 'list-item', 'data-id': item.id },
                    () => `${index()}: ${item.label}`,
                );
            }, item => item.id),
        );

        // Query the initial rendered items
        const itemNodesInitial = Array.from(listContainer.querySelectorAll('.list-item')) as HTMLElement[];
        expect(itemNodesInitial.length).toBe(3);
        const [node1, node2, node3] = itemNodesInitial;
        expect(node1?.getAttribute('data-id')).toBe('1');
        expect(node2?.getAttribute('data-id')).toBe('2');
        expect(node3?.getAttribute('data-id')).toBe('3');
        expect(node1?.textContent).toBe('0: Item 1');
        expect(node2?.textContent).toBe('1: Item 2');
        expect(node3?.textContent).toBe('2: Item 3');

        // Reorder list: [3, 1, 2]
        items.set([
            { id: '3', label: 'Item 3' },
            { id: '1', label: 'Item 1' },
            { id: '2', label: 'Item 2' },
        ]);
        flushSync();

        const itemNodesAfter = Array.from(listContainer.querySelectorAll('.list-item')) as HTMLElement[];
        expect(itemNodesAfter.length).toBe(3);

        // Crucial: The exact DOM node object references MUST be preserved!
        expect(itemNodesAfter[0]).toBe(node3);
        expect(itemNodesAfter[1]).toBe(node1);
        expect(itemNodesAfter[2]).toBe(node2);

        // Indexes updated dynamically without rebuilding the DOM elements
        expect(itemNodesAfter[0]?.textContent).toBe('0: Item 3');
        expect(itemNodesAfter[1]?.textContent).toBe('1: Item 1');
        expect(itemNodesAfter[2]?.textContent).toBe('2: Item 2');
    });

    it('a removed subtree effects are disposed and stop running', () => {
        const count = signal(0);
        let effectRuns = 0;

        const subtreeScope = createScope();
        let subtreeEl!: HTMLElement;

        subtreeScope.run(() => {
            subtreeEl = h('div', { class: 'subtree' }, () => {
                effectRuns++;
                return `Count: ${count()}`;
            });
        });

        attachScope(subtreeEl, subtreeScope);

        const parent = h('div', { class: 'parent' }, subtreeEl);
        expect(effectRuns).toBe(1);
        expect(subtreeEl.textContent).toBe('Count: 0');

        // Updating signal triggers effect
        count.set(1);
        flushSync();
        expect(effectRuns).toBe(2);
        expect(subtreeEl.textContent).toBe('Count: 1');

        // Unmount & dispose subtree
        parent.removeChild(subtreeEl);
        disposeElement(subtreeEl);

        // Updating signal must NEVER trigger the disposed effect again
        count.set(2);
        flushSync();
        expect(effectRuns).toBe(2); // no more runs

        count.set(3);
        flushSync();
        expect(effectRuns).toBe(2);
    });

    it('a bound value on an input does not clobber what the user is typing', () => {
        const text = signal('hello');

        const inputEl = Input({
            value: () => text(),
            onInput: (e: Event) => {
                const target = e.target as HTMLInputElement;
                text.set(target.value);
            },
        });

        expect(inputEl.value).toBe('hello');

        // Simulate user typing in the middle or end
        inputEl.value = 'hello world';
        // Dispatch real input event
        inputEl.dispatchEvent(new Event('input'));
        flushSync();

        expect(text()).toBe('hello world');
        expect(inputEl.value).toBe('hello world');

        // External signal update updates the input
        text.set('reset externally');
        flushSync();
        expect(inputEl.value).toBe('reset externally');
    });

    it('When toggling disposes the outgoing branch', () => {
        const show = signal(true);
        const title = signal('Active Branch');
        let branchEffectRuns = 0;

        const container = h('div', { class: 'container' },
            When(
                () => show(),
                () => {
                    return h('div', { class: 'branch-a' }, () => {
                        branchEffectRuns++;
                        return `A: ${title()}`;
                    });
                },
                () => h('div', { class: 'branch-b' }, 'B: Inactive'),
            ),
        );

        expect(branchEffectRuns).toBe(1);
        expect(container.querySelector('.branch-a')?.textContent).toBe('A: Active Branch');
        expect(container.querySelector('.branch-b')).toBeNull();

        // Updating signal while branch is active triggers effect
        title.set('Updated Active');
        flushSync();
        expect(branchEffectRuns).toBe(2);
        expect(container.querySelector('.branch-a')?.textContent).toBe('A: Updated Active');

        // Toggle condition to false -> unmount branch A and mount branch B
        show.set(false);
        flushSync();

        expect(container.querySelector('.branch-a')).toBeNull();
        expect(container.querySelector('.branch-b')?.textContent).toBe('B: Inactive');

        // Changing title must NOT trigger branch A effect anymore!
        title.set('Should not run');
        flushSync();
        expect(branchEffectRuns).toBe(2); // no increase!

        // Toggle back to true -> new instance of branch A mounts
        show.set(true);
        flushSync();
        expect(branchEffectRuns).toBe(3);
        expect(container.querySelector('.branch-a')?.textContent).toBe('A: Should not run');
    });
});
