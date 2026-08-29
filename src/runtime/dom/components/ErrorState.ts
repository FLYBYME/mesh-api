import './error-state.css';
import type { Child, Props } from '../types.js';
import { h } from '../h.js';
import { Button } from './Button.js';

export interface ErrorStateProps {
    title?: string | (() => string);
    message: string | Error | (() => string | Error);
    onRetry?: () => void;
    retryLabel?: string;
    class?: string | (() => string);
    ref?: (el: HTMLElement) => void;
}

/**
 * Accessible error alert feedback component.
 */
export function ErrorState(props: ErrorStateProps): HTMLElement {
    const classList: string[] = ['mesh-error-state'];

    const staticClass = classList.join(' ');
    const mergedClass = typeof props.class === 'function'
        ? () => `${staticClass} ${props.class ? (props.class as () => string)() : ''}`.trim()
        : props.class ? `${staticClass} ${props.class}` : staticClass;

    const elementProps: Props = {
        class: mergedClass,
        role: 'alert',
        ...(props.ref ? { ref: props.ref } : {}),
    };

    const titleText = props.title ?? 'An error occurred';
    const messageChild = typeof props.message === 'function'
        ? () => {
            const res = (props.message as () => string | Error)();
            return res instanceof Error ? res.message : String(res);
        }
        : props.message instanceof Error ? props.message.message : String(props.message);

    const children: Child[] = [
        h('h3', { class: 'mesh-error-state-title' }, titleText),
        h('p', { class: 'mesh-error-state-message' }, messageChild),
    ];

    if (props.onRetry) {
        const retryBtn = Button(
            {
                variant: 'danger',
                size: 'sm',
                onClick: props.onRetry,
                class: 'mesh-error-state-retry',
            },
            props.retryLabel ?? 'Try again',
        );
        children.push(retryBtn);
    }

    return h('div', elementProps, ...children);
}
