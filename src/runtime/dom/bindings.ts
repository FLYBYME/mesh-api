import type { DisposeFn } from '../reactivity/types.js';
import { effect } from '../reactivity/effect.js';

/**
 * Updates an attribute or property on a DOM element.
 *
 * Properties such as `value` on inputs must be updated via the property directly,
 * not setAttribute(), to avoid resetting cursor position or fighting ongoing user input.
 * Boolean attributes are added/removed rather than rendered as "false" strings.
 */
export function setAttributeOrProperty(el: Element, name: string, val: unknown): void {
    if (name === 'value' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
        const str = val == null ? '' : String(val);
        if (el.value !== str) {
            el.value = str;
        }
        return;
    }

    if (name === 'checked' && el instanceof HTMLInputElement) {
        const bool = Boolean(val);
        if (el.checked !== bool) {
            el.checked = bool;
        }
        return;
    }

    const isBooleanAttr = name === 'disabled' || name === 'checked' || name === 'hidden' ||
        name === 'required' || name === 'readonly' || name === 'selected' ||
        name === 'autofocus' || name === 'multiple' || name === 'open';

    if (val == null || val === false) {
        el.removeAttribute(name);
        return;
    }

    if (isBooleanAttr) {
        el.setAttribute(name, '');
        return;
    }

    el.setAttribute(name, String(val));
}

/**
 * Binds a specific class name or dynamic class set to an element.
 *
 * Class updates use classList.add/remove to preserve static classes and compose
 * cleanly across multiple bindings without clobbering existing tokens.
 */
export function bindClass(
    el: HTMLElement,
    nameOrFn: string | (() => string | Record<string, boolean | unknown> | null | undefined),
    condition?: () => boolean | unknown,
): DisposeFn {
    if (typeof nameOrFn === 'string') {
        const className = nameOrFn;
        const check = condition ?? (() => true);
        return effect(() => {
            const active = Boolean(check());
            if (active) {
                el.classList.add(className);
            } else {
                el.classList.remove(className);
            }
        });
    }

    const classFn = nameOrFn;
    let prevClasses = new Set<string>();

    return effect(() => {
        const res = classFn();
        const nextClasses = new Set<string>();

        if (typeof res === 'string') {
            for (const token of res.trim().split(/\s+/)) {
                if (token.length > 0) nextClasses.add(token);
            }
        } else if (res !== null && typeof res === 'object') {
            for (const [token, active] of Object.entries(res)) {
                if (Boolean(active)) nextClasses.add(token);
            }
        }

        for (const token of prevClasses) {
            if (!nextClasses.has(token)) {
                el.classList.remove(token);
            }
        }
        for (const token of nextClasses) {
            if (!prevClasses.has(token)) {
                el.classList.add(token);
            }
        }

        prevClasses = nextClasses;
    });
}

/**
 * Binds inline styles to an element.
 *
 * Supports single property bindings or full style object bindings, removing
 * properties when set to null or undefined.
 */
export function bindStyle(
    el: HTMLElement,
    propOrFn: string | (() => string | Record<string, string | number | null | undefined> | null | undefined),
    valFn?: () => string | number | null | undefined,
): DisposeFn {
    if (typeof propOrFn === 'string') {
        const propName = propOrFn;
        const readVal = valFn ?? (() => '');
        return effect(() => {
            const val = readVal();
            if (val == null) {
                el.style.removeProperty(propName);
            } else {
                el.style.setProperty(propName, String(val));
            }
        });
    }

    const styleFn = propOrFn;
    let prevProps = new Set<string>();

    return effect(() => {
        const res = styleFn();
        if (typeof res === 'string') {
            el.style.cssText = res;
        } else if (res !== null && typeof res === 'object') {
            const nextProps = new Set<string>();
            for (const [key, val] of Object.entries(res)) {
                nextProps.add(key);
                if (val == null) {
                    el.style.removeProperty(key);
                } else {
                    el.style.setProperty(key, String(val));
                }
            }
            for (const key of prevProps) {
                if (!nextProps.has(key)) {
                    el.style.removeProperty(key);
                }
            }
            prevProps = nextProps;
        } else {
            el.style.cssText = '';
        }
    });
}

/**
 * Binds an arbitrary DOM attribute to a reactive expression.
 */
export function bindAttr(el: Element, name: string, fn: () => unknown): DisposeFn {
    return effect(() => {
        const val = fn();
        setAttributeOrProperty(el, name, val);
    });
}

/**
 * Binds the textContent of a DOM Text node or Element to a reactive expression.
 *
 * Directly updates textContent without reconstructing parent or sibling nodes.
 */
export function bindText(node: Node, fn: () => unknown): DisposeFn {
    return effect(() => {
        const val = fn();
        const text = val == null || typeof val === 'boolean' ? '' : String(val);
        if (node.textContent !== text) {
            node.textContent = text;
        }
    });
}
