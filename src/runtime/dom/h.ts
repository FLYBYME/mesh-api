import type { Props, Child, DynamicChild } from './types.js';
import { effect } from '../reactivity/effect.js';
import { bindClass, bindStyle, bindAttr, bindText, setAttributeOrProperty } from './bindings.js';
import { registerCleanup } from './scope.js';

function isPropsObject(val: unknown): val is Record<string, unknown> {
    if (val === null || typeof val !== 'object') return false;
    if (val instanceof Node) return false;
    if (Array.isArray(val)) return false;
    return true;
}

function appendChildTo(parent: Node, child: Child): void {
    if (child == null || typeof child === 'boolean') {
        return;
    }

    if (typeof child === 'string' || typeof child === 'number') {
        parent.appendChild(document.createTextNode(String(child)));
        return;
    }

    if (child instanceof Node) {
        parent.appendChild(child);
        return;
    }

    if (Array.isArray(child)) {
        for (const item of child) {
            appendChildTo(parent, item);
        }
        return;
    }

    if (typeof child === 'function') {
        const dynamicFn: DynamicChild = child;
        const marker = document.createComment('mesh-dyn');
        parent.appendChild(marker);

        let currentNodes: Node[] = [];

        effect(() => {
            const rawVal = dynamicFn();

            if (
                rawVal == null ||
                typeof rawVal === 'string' ||
                typeof rawVal === 'number' ||
                typeof rawVal === 'boolean'
            ) {
                const text = rawVal == null || typeof rawVal === 'boolean' ? '' : String(rawVal);
                const firstNode = currentNodes[0];

                if (currentNodes.length === 1 && firstNode instanceof Text) {
                    if (firstNode.textContent !== text) {
                        firstNode.textContent = text;
                    }
                    return;
                }

                for (const node of currentNodes) {
                    node.parentNode?.removeChild(node);
                }
                currentNodes = [];

                const textNode = document.createTextNode(text);
                marker.parentNode?.insertBefore(textNode, marker);
                currentNodes.push(textNode);
                return;
            }

            for (const node of currentNodes) {
                node.parentNode?.removeChild(node);
            }
            currentNodes = [];

            const list = Array.isArray(rawVal) ? rawVal : [rawVal];
            for (const item of list) {
                if (item instanceof Node) {
                    marker.parentNode?.insertBefore(item, marker);
                    currentNodes.push(item);
                } else if (item != null && typeof item !== 'boolean') {
                    const textNode = document.createTextNode(String(item));
                    marker.parentNode?.insertBefore(textNode, marker);
                    currentNodes.push(textNode);
                }
            }
        });
    }
}

/**
 * Creates a real DOM element with reactive bindings, attributes, and children.
 *
 * Plain values are set once; functions are wrapped in fine-grained effects that
 * update only the specific node or attribute when dependencies change.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    propsOrChild?: Props<HTMLElementTagNameMap[K]> | Child | null,
    ...children: Child[]
): HTMLElementTagNameMap[K];
export function h(
    tag: string,
    propsOrChild?: Props<HTMLElement> | Child | null,
    ...children: Child[]
): HTMLElement;
export function h(
    tag: string,
    propsOrChild?: unknown,
    ...children: Child[]
): HTMLElement {
    const el = document.createElement(tag);

    let props: Record<string, unknown> | null = null;
    let actualChildren = children;

    if (isPropsObject(propsOrChild)) {
        props = propsOrChild;
    } else if (propsOrChild !== undefined && propsOrChild !== null) {
        actualChildren = [propsOrChild as Child, ...children];
    }

    if (props !== null) {
        for (const [key, val] of Object.entries(props)) {
            if (key === 'ref' && typeof val === 'function') {
                val(el);
                continue;
            }

            if (key === 'class' || key === 'className') {
                if (typeof val === 'function') {
                    bindClass(el, val as () => string | Record<string, boolean | unknown> | null | undefined);
                } else if (typeof val === 'string') {
                    for (const cls of val.trim().split(/\s+/)) {
                        if (cls.length > 0) el.classList.add(cls);
                    }
                } else if (val !== null && typeof val === 'object') {
                    for (const [cls, active] of Object.entries(val)) {
                        if (Boolean(active)) el.classList.add(cls);
                    }
                }
                continue;
            }

            if (key === 'style') {
                if (typeof val === 'function') {
                    bindStyle(el, val as () => string | Record<string, string | number | null | undefined> | null | undefined);
                } else if (typeof val === 'string') {
                    el.style.cssText = val;
                } else if (val !== null && typeof val === 'object') {
                    for (const [propName, propVal] of Object.entries(val)) {
                        if (propVal != null) {
                            el.style.setProperty(propName, String(propVal));
                        }
                    }
                }
                continue;
            }

            if (key.startsWith('on') && typeof val === 'function') {
                const eventName = key.slice(2).toLowerCase();
                const handler = val as (e: Event) => void;
                const listener = (e: Event) => handler(e);
                el.addEventListener(eventName, listener);
                registerCleanup(() => el.removeEventListener(eventName, listener));
                continue;
            }

            if (typeof val === 'function') {
                bindAttr(el, key, val as () => unknown);
                continue;
            }

            setAttributeOrProperty(el, key, val);
        }
    }

    for (const child of actualChildren) {
        appendChildTo(el, child);
    }

    return el;
}
