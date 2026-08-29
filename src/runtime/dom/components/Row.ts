import './row.css';
import type { Child, Props } from '../types.js';
import { h } from '../h.js';

export interface RowProps {
    gap?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number | string;
    align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
    justify?: 'start' | 'center' | 'end' | 'between' | 'around';
    wrap?: boolean;
    class?: string | (() => string);
    ref?: (el: HTMLElement) => void;
    children?: Child[];
}

/**
 * Horizontal flex layout container.
 */
export function Row(props: RowProps = {}, ...children: Child[]): HTMLElement {
    const classList: string[] = ['mesh-row'];

    if (props.wrap) {
        classList.push('mesh-row-wrap');
    }
    if (typeof props.gap === 'string' && ['xs', 'sm', 'md', 'lg', 'xl'].includes(props.gap)) {
        classList.push(`mesh-row-gap-${props.gap}`);
    }
    if (props.align) {
        classList.push(`mesh-row-align-${props.align}`);
    }
    if (props.justify) {
        classList.push(`mesh-row-justify-${props.justify}`);
    }

    const staticClass = classList.join(' ');
    const mergedClass = typeof props.class === 'function'
        ? () => `${staticClass} ${props.class ? (props.class as () => string)() : ''}`.trim()
        : props.class ? `${staticClass} ${props.class}` : staticClass;

    const styleObj: Record<string, string> = {};
    if (typeof props.gap === 'number') {
        styleObj['gap'] = `${props.gap}px`;
    } else if (typeof props.gap === 'string' && !['xs', 'sm', 'md', 'lg', 'xl'].includes(props.gap)) {
        styleObj['gap'] = props.gap;
    }

    const elementProps: Props = {
        class: mergedClass,
        ...(Object.keys(styleObj).length > 0 ? { style: styleObj } : {}),
        ...(props.ref ? { ref: props.ref } : {}),
    };

    const allChildren = props.children ? [...props.children, ...children] : children;
    return h('div', elementProps, ...allChildren);
}
