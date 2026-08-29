import './button.css';
import type { Child, Props } from '../types.js';
import { h } from '../h.js';

export interface ButtonProps {
    variant?: 'primary' | 'secondary' | 'danger' | 'warning' | 'ghost';
    size?: 'sm' | 'md' | 'lg';
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean | (() => boolean);
    onClick?: (e: MouseEvent) => void;
    ariaLabel?: string | (() => string);
    class?: string | (() => string);
    ref?: (el: HTMLButtonElement) => void;
    children?: Child[];
}

/**
 * Accessible button component.
 */
export function Button(props: ButtonProps = {}, ...children: Child[]): HTMLButtonElement {
    const variant = props.variant ?? 'secondary';
    const size = props.size ?? 'md';
    const type = props.type ?? 'button';

    const classList: string[] = [
        'mesh-button',
        `mesh-button-variant-${variant}`,
        `mesh-button-size-${size}`,
    ];

    const staticClass = classList.join(' ');
    const mergedClass = typeof props.class === 'function'
        ? () => `${staticClass} ${props.class ? (props.class as () => string)() : ''}`.trim()
        : props.class ? `${staticClass} ${props.class}` : staticClass;

    const elementProps: Props<HTMLButtonElement> = {
        type,
        class: mergedClass,
        ...(props.disabled !== undefined ? { disabled: props.disabled } : {}),
        ...(props.onClick ? { onClick: (e: Event) => props.onClick?.(e as MouseEvent) } : {}),
        ...(props.ariaLabel ? { 'aria-label': props.ariaLabel } : {}),
        ...(props.ref ? { ref: props.ref } : {}),
    };

    const allChildren = props.children ? [...props.children, ...children] : children;
    return h('button', elementProps, ...allChildren);
}
