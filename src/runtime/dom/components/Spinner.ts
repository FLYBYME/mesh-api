import './spinner.css';
import type { Props } from '../types.js';
import { h } from '../h.js';

export interface SpinnerProps {
    size?: 'sm' | 'md' | 'lg';
    label?: string;
    class?: string | (() => string);
    ref?: (el: HTMLElement) => void;
}

/**
 * Accessible loading spinner indicator.
 */
export function Spinner(props: SpinnerProps = {}): HTMLElement {
    const size = props.size ?? 'md';
    const label = props.label ?? 'Loading...';

    const classList: string[] = ['mesh-spinner', `mesh-spinner-size-${size}`];

    const staticClass = classList.join(' ');
    const mergedClass = typeof props.class === 'function'
        ? () => `${staticClass} ${props.class ? (props.class as () => string)() : ''}`.trim()
        : props.class ? `${staticClass} ${props.class}` : staticClass;

    const elementProps: Props = {
        class: mergedClass,
        role: 'status',
        'aria-label': label,
        ...(props.ref ? { ref: props.ref } : {}),
    };

    return h('div', elementProps);
}
