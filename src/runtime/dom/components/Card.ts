import './card.css';
import type { Child, Props } from '../types.js';
import { h } from '../h.js';

export interface CardProps {
    header?: Child | Child[];
    footer?: Child | Child[];
    variant?: 'default' | 'elevated' | 'outlined';
    class?: string | (() => string);
    onClick?: (e: MouseEvent) => void;
    ref?: (el: HTMLElement) => void;
    children?: Child[];
}

/**
 * Structured card container for cards, panels, and dashboard widgets.
 */
export function Card(props: CardProps = {}, ...children: Child[]): HTMLElement {
    const variant = props.variant ?? 'default';
    const classList: string[] = ['mesh-card', `mesh-card-variant-${variant}`];

    if (props.onClick) {
        classList.push('mesh-card-clickable');
    }

    const staticClass = classList.join(' ');
    const mergedClass = typeof props.class === 'function'
        ? () => `${staticClass} ${props.class ? (props.class as () => string)() : ''}`.trim()
        : props.class ? `${staticClass} ${props.class}` : staticClass;

    const elementProps: Props = {
        class: mergedClass,
        ...(props.onClick ? { onClick: (e: Event) => props.onClick?.(e as MouseEvent) } : {}),
        ...(props.ref ? { ref: props.ref } : {}),
    };

    const cardChildren: Child[] = [];

    if (props.header !== undefined) {
        const headerContent = Array.isArray(props.header) ? props.header : [props.header];
        cardChildren.push(h('div', { class: 'mesh-card-header' }, ...headerContent));
    }

    const bodyContent = props.children ? [...props.children, ...children] : children;
    if (bodyContent.length > 0) {
        cardChildren.push(h('div', { class: 'mesh-card-body' }, ...bodyContent));
    }

    if (props.footer !== undefined) {
        const footerContent = Array.isArray(props.footer) ? props.footer : [props.footer];
        cardChildren.push(h('div', { class: 'mesh-card-footer' }, ...footerContent));
    }

    return h('div', elementProps, ...cardChildren);
}
