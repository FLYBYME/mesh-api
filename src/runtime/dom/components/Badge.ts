import './badge.css';
import type { Child, Props } from '../types.js';
import { h } from '../h.js';

export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
    variant?: BadgeVariant | (() => BadgeVariant);
    size?: 'sm' | 'md';
    class?: string | (() => string);
    ref?: (el: HTMLElement) => void;
    children?: Child[];
}

/**
 * Status and metadata tag badge.
 */
export function Badge(props: BadgeProps = {}, ...children: Child[]): HTMLElement {
    const size = props.size ?? 'sm';
    const variantProp = props.variant ?? 'default';
    const classProp = props.class;

    const baseClass = `mesh-badge mesh-badge-size-${size}`;
    const isDynamicVariant = typeof variantProp === 'function';
    const isDynamicClass = typeof classProp === 'function';

    let mergedClass: string | (() => string);

    if (isDynamicVariant || isDynamicClass) {
        mergedClass = () => {
            const v = typeof variantProp === 'function' ? variantProp() : variantProp;
            const extra = typeof classProp === 'function' ? classProp() : (classProp ?? '');
            return `${baseClass} mesh-badge-variant-${v} ${extra}`.trim();
        };
    } else {
        const extra = classProp ? ` ${classProp}` : '';
        mergedClass = `${baseClass} mesh-badge-variant-${variantProp}${extra}`.trim();
    }

    const elementProps: Props = {
        class: mergedClass,
        ...(props.ref ? { ref: props.ref } : {}),
    };

    const allChildren = props.children ? [...props.children, ...children] : children;
    return h('span', elementProps, ...allChildren);
}
