import './empty-state.css';
import type { Child, Props } from '../types.js';
import { h } from '../h.js';

export interface EmptyStateProps {
    title: string | (() => string);
    description?: string | (() => string);
    icon?: Child;
    action?: Child;
    class?: string | (() => string);
    ref?: (el: HTMLElement) => void;
}

/**
 * Placeholder empty state component.
 */
export function EmptyState(props: EmptyStateProps): HTMLElement {
    const classList: string[] = ['mesh-empty-state'];

    const staticClass = classList.join(' ');
    const mergedClass = typeof props.class === 'function'
        ? () => `${staticClass} ${props.class ? (props.class as () => string)() : ''}`.trim()
        : props.class ? `${staticClass} ${props.class}` : staticClass;

    const elementProps: Props = {
        class: mergedClass,
        ...(props.ref ? { ref: props.ref } : {}),
    };

    const children: Child[] = [];

    if (props.icon !== undefined) {
        children.push(h('div', { class: 'mesh-empty-state-icon' }, props.icon));
    }

    children.push(h('h3', { class: 'mesh-empty-state-title' }, props.title));

    if (props.description !== undefined) {
        children.push(h('p', { class: 'mesh-empty-state-desc' }, props.description));
    }

    if (props.action !== undefined) {
        children.push(h('div', { class: 'mesh-empty-state-action' }, props.action));
    }

    return h('div', elementProps, ...children);
}
