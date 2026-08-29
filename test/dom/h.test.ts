// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
    h,
    bindClass,
    bindStyle,
    bindAttr,
    bindText,
    setAttributeOrProperty,
} from '../../src/runtime/dom/index.js';
import {
    signal,
    createScope,
    flushSync,
} from '../../src/runtime/reactivity/index.js';

describe('DOM h() and binding helpers', () => {
    it('creates basic HTML elements with static attributes and text children', () => {
        const el = h('div', { id: 'test-id', 'data-kind': 'panel' }, 'Hello World');
        expect(el.tagName.toLowerCase()).toBe('div');
        expect(el.id).toBe('test-id');
        expect(el.getAttribute('data-kind')).toBe('panel');
        expect(el.textContent).toBe('Hello World');
    });

    it('supports child arrays and nested elements', () => {
        const el = h('ul', { class: 'list' }, [
            h('li', 'Item 1'),
            h('li', 'Item 2'),
            [h('li', 'Item 3'), h('li', 'Item 4')],
        ]);

        expect(el.children.length).toBe(4);
        expect(el.children[0]?.textContent).toBe('Item 1');
        expect(el.children[3]?.textContent).toBe('Item 4');
    });

    it('invokes ref callback with the created element', () => {
        let captured: HTMLInputElement | null = null;
        const el = h('input', {
            type: 'text',
            ref: (node: HTMLInputElement) => {
                captured = node;
            },
        });

        expect(captured).toBe(el);
    });

    it('handles event listeners and cleans them up on scope disposal', () => {
        let clickCount = 0;
        const scope = createScope();
        let btn!: HTMLButtonElement;

        scope.run(() => {
            btn = h('button', {
                type: 'button',
                onClick: () => {
                    clickCount++;
                },
            }, 'Click me');
        });

        btn.click();
        expect(clickCount).toBe(1);

        btn.click();
        expect(clickCount).toBe(2);

        // Dispose scope -> event listener removed
        scope.dispose();
        btn.click();
        expect(clickCount).toBe(2);
    });

    it('handles boolean attributes correctly without string false', () => {
        const disabled = signal(true);
        const required = signal(false);

        const input = h('input', {
            disabled: () => disabled(),
            required: () => required(),
        });

        expect(input.hasAttribute('disabled')).toBe(true);
        expect(input.hasAttribute('required')).toBe(false);

        disabled.set(false);
        required.set(true);
        flushSync();

        expect(input.hasAttribute('disabled')).toBe(false);
        expect(input.hasAttribute('required')).toBe(true);
    });

    it('bindClass toggles individual classes without clobbering existing classes', () => {
        const isActive = signal(false);
        const isBlocked = signal(true);

        const el = h('div', { class: 'card static-class' });
        bindClass(el, 'active', () => isActive());
        bindClass(el, 'blocked', () => isBlocked());

        expect(el.className).toBe('card static-class blocked');

        isActive.set(true);
        isBlocked.set(false);
        flushSync();

        expect(el.classList.contains('card')).toBe(true);
        expect(el.classList.contains('static-class')).toBe(true);
        expect(el.classList.contains('active')).toBe(true);
        expect(el.classList.contains('blocked')).toBe(false);
    });

    it('bindStyle dynamically updates inline styles', () => {
        const color = signal('red');
        const padding = signal<string | null>('8px');

        const el = h('div');
        bindStyle(el, 'color', () => color());
        bindStyle(el, 'padding', () => padding());

        expect(el.style.color).toBe('red');
        expect(el.style.padding).toBe('8px');

        color.set('blue');
        padding.set(null); // removal
        flushSync();

        expect(el.style.color).toBe('blue');
        expect(el.style.padding).toBe('');
    });

    it('bindAttr dynamically updates attributes', () => {
        const role = signal('button');
        const ariaHidden = signal(true);

        const el = h('div');
        bindAttr(el, 'role', () => role());
        bindAttr(el, 'aria-hidden', () => ariaHidden());

        expect(el.getAttribute('role')).toBe('button');
        expect(el.getAttribute('aria-hidden')).toBe('true');

        role.set('link');
        ariaHidden.set(false);
        flushSync();

        expect(el.getAttribute('role')).toBe('link');
        expect(el.hasAttribute('aria-hidden')).toBe(false);
    });

    it('bindText updates node text content without destroying the node', () => {
        const textNode = document.createTextNode('initial');
        const count = signal(100);

        bindText(textNode, () => count());
        expect(textNode.textContent).toBe('100');

        count.set(200);
        flushSync();
        expect(textNode.textContent).toBe('200');
    });

    it('setAttributeOrProperty handles value and checked properties on form inputs', () => {
        const input = document.createElement('input');
        input.type = 'checkbox';

        setAttributeOrProperty(input, 'checked', true);
        expect(input.checked).toBe(true);

        setAttributeOrProperty(input, 'checked', false);
        expect(input.checked).toBe(false);

        input.type = 'text';
        setAttributeOrProperty(input, 'value', 'test-val');
        expect(input.value).toBe('test-val');
    });
});
