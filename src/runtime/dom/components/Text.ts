import './text.css';
import type { Child, Props } from '../types.js';
import { h } from '../h.js';

export interface TextProps {
    as?: 'span' | 'p' | 'label' | 'div' | 'small' | 'code';
    variant?: 'body' | 'caption' | 'muted' | 'code';
    weight?: 'normal' | 'medium' | 'semibold' | 'bold';
    size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl';
    class?: string | (() => string);
    ref?: (el: HTMLElement) => void;
    children?: Child[];
}

/**
 * Text typography primitive.
 */
export function Text(props: TextProps = {}, ...children: Child[]): HTMLElement {
    const tag = props.as ?? (props.variant === 'code' ? 'code' : 'span');
    const classList: string[] = ['mesh-text'];

    if (props.variant) {
        classList.push(`mesh-text-variant-${props.variant}`);
    }
    if (props.weight) {
        classList.push(`mesh-text-weight-${props.weight}`);
    }
    if (props.size) {
        classList.push(`mesh-text-size-${props.size}`);
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
