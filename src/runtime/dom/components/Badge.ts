import './badge.css';
import type { Child, Props } from '../types.js';
import { h } from '../h.js';

export interface BadgeProps {
    variant?: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
    size?: 'sm' | 'md';
    class?: string | (() => string);
    ref?: (el: HTMLElement) => void;
    children?: Child[];
}

/**
 * Status and metadata tag badge.
 */
export function Badge(props: BadgeProps = {}, ...children: Child[]): HTMLElement {
    const variant = props.variant ?? 'default';
    const size = props.size ?? 'sm';

    const classList: string[] = [
        'mesh-badge',
        `mesh-badge-variant-${variant}`,
        `mesh-badge-size-${size}`,
    ];

    const staticClass = classList.join(' ');
    const mergedClass = typeof props.class === 'function'
        ? () => `${staticClass} ${props.class ? (props.class as () => string)() : ''}`.trim()
        : props.class ? `${staticClass} ${props.class}` : staticClass;

    const elementProps: Props = {
        class: mergedClass,
        ...(props.ref ? { ref: props.ref } : {}),
    };

    const allChildren = props.children ? [...props.children, ...children] : children;
    return h('span', elementProps, ...allChildren);
}
