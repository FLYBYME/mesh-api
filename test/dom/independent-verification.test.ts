// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { signal, flushSync } from '../../src/runtime/reactivity/index.js';
import { h, For, When } from '../../src/runtime/dom/index.js';

// Written independently of the dispatch's own tests, against the two properties this whole
// framework exists to provide. Both are about NODE IDENTITY, which is what `mesh-ui`'s
// `updateProps()` destroyed on every prop change:
//
//     this.element.innerHTML = '';   // discards the entire subtree
//     this.render();                 // rebuilds it from scratch
//
// A test asserting on rendered *text* cannot tell the difference between updating a node and
// replacing it with an identical one -- which is exactly the bug. So these assert on object
// identity, not content.

describe('adversarial DOM: fine-grained updates', () => {
    it('updates one bound text node and leaves every sibling node object untouched', () => {
        const title = signal('first');
        const el = h('div', {},
            h('span', { class: 'a' }, 'static-a'),
            h('span', { class: 'b' }, () => title()),
            h('span', { class: 'c' }, 'static-c'),
        );

        const a = el.children[0];
        const b = el.children[1];
        const c = el.children[2];
        const bText = b?.firstChild;
        expect(b?.textContent).toBe('first');

        title.set('second');
        flushSync();

        expect(b?.textContent).toBe('second');
        // The identity assertions are the real test.
        expect(el.children[0]).toBe(a);
        expect(el.children[1]).toBe(b);
        expect(el.children[2]).toBe(c);
        expect(b?.firstChild).toBe(bText);
    });

    it('does not clobber what the user is typing into a bound input', () => {
        const value = signal('hello');
        const input = h('input', { value: () => value() });
        expect(input).toBeInstanceOf(HTMLInputElement);
        if (!(input instanceof HTMLInputElement)) throw new Error('expected an input element');

        // `value` must be set as a PROPERTY. Set as an attribute it is only the *default* value,
        // so a controlled input silently stops reflecting updates once the user has typed.
        expect(input.value).toBe('hello');
        value.set('world');
        flushSync();
        expect(input.value).toBe('world');
    });
});

describe('adversarial DOM: keyed For moves rather than rebuilds', () => {
    it('preserves the same node object across a reorder', () => {
        const items = signal([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
        const host = h('div', {}, For(items, item => h('span', { 'data-id': item.id }, item.id), item => item.id));

        const nodeFor = (id: string): Element => {
            const found = host.querySelector(`[data-id="${id}"]`);
            if (!found) throw new Error(`no node for ${id}`);
            return found;
        };
        const a = nodeFor('a');
        const b = nodeFor('b');
        const c = nodeFor('c');

        items.set([{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
        flushSync();

        // Same objects, new positions. A rebuild would produce equal-but-different nodes, which is
        // how focus, scroll position, and child state get destroyed.
        expect(nodeFor('a')).toBe(a);
        expect(nodeFor('b')).toBe(b);
        expect(nodeFor('c')).toBe(c);
        expect(host.textContent).toBe('cab');
    });

    it('keeps surviving nodes identical across an insert and a remove', () => {
        const items = signal([{ id: 'x' }, { id: 'y' }]);
        const host = h('div', {}, For(items, item => h('span', { 'data-id': item.id }, item.id), item => item.id));
        const nodeFor = (id: string) => host.querySelector(`[data-id="${id}"]`);
        const y = nodeFor('y');

        items.set([{ id: 'x' }, { id: 'new' }, { id: 'y' }]);
        flushSync();
        expect(nodeFor('y')).toBe(y);

        items.set([{ id: 'new' }, { id: 'y' }]);
        flushSync();
        expect(nodeFor('y')).toBe(y);
        expect(nodeFor('x')).toBeNull();
    });

    it('preserves real DOM state (focus) that a rebuild would destroy', () => {
        const items = signal([{ id: 'p' }, { id: 'q' }]);
        const host = h('div', {}, For(items, item => h('input', { 'data-id': item.id }), item => item.id));
        document.body.appendChild(host);

        const q = host.querySelector('[data-id="q"]');
        if (!(q instanceof HTMLInputElement)) throw new Error('expected an input');
        q.value = 'typed by the user';
        q.focus();
        expect(document.activeElement).toBe(q);

        items.set([{ id: 'q' }, { id: 'p' }]);
        flushSync();

        // This is the concrete user-visible consequence of node identity, and the reason it matters.
        expect(document.activeElement).toBe(q);
        expect(q.value).toBe('typed by the user');
        document.body.removeChild(host);
    });
});

describe('adversarial DOM: disposal', () => {
    it('stops the effects of a subtree that When has unmounted', () => {
        const show = signal(true);
        const counter = signal(0);
        let renders = 0;

        const host = h('div', {}, When(() => show(), () => h('span', {}, () => { renders++; return String(counter()); })));
        flushSync();
        const initial = renders;

        counter.set(1);
        flushSync();
        expect(renders).toBeGreaterThan(initial);

        show.set(false);
        flushSync();
        const afterUnmount = renders;

        // A binding whose element is gone but whose effect still runs is a leak that grows for the
        // lifetime of the page.
        counter.set(2);
        counter.set(3);
        flushSync();
        expect(renders).toBe(afterUnmount);
        expect(host.textContent).toBe('');
    });
});
