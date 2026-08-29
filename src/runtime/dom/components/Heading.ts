import './heading.css';
import type { Child, Props } from '../types.js';
import { h } from '../h.js';

export interface HeadingProps {
    level?: 1 | 2 | 3 | 4 | 5 | 6;
    size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';
    class?: string | (() => string);
    ref?: (el: HTMLElement) => void;
    children?: Child[];
}

/**
 * Semantic heading primitive.
 */
export function Heading(props: HeadingProps = {}, ...children: Child[]): HTMLElement {
    const level = props.level ?? 2;
    const tag = `h${level}` as keyof HTMLElementTagNameMap;
    const classList: string[] = ['mesh-heading', `mesh-heading-level-${level}`];

    if (props.size) {
        classList.push(`mesh-heading-size-${props.size}`);
    }

    const staticClass = classList.join(' ');
    const mergedClass = typeof props.class === 'function'
        ? () => `${staticClass} ${props.class ? (props.class as () => string)() : ''}`.trim()
        : props.class ? `${staticClass} ${props.class}` : staticClass;

    const elementProps: Props = {
        class: mergedClass,
        ...(props.ref ? { ref: props.ref } : {}),
    };

    const allChildren = props.children ? [...props.children, ...children] : children;
    return h(tag, elementProps, ...allChildren);
}
