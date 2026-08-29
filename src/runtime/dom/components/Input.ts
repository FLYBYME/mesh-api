import './input.css';
import type { Props } from '../types.js';
import type { Signal } from '../../reactivity/types.js';
import { h } from '../h.js';

export interface InputProps {
    type?: 'text' | 'password' | 'email' | 'search' | 'number' | 'url' | 'tel';
    value?: string | Signal<string> | (() => string);
    placeholder?: string | (() => string);
    disabled?: boolean | (() => boolean);
    readonly?: boolean | (() => boolean);
    required?: boolean | (() => boolean);
    id?: string | (() => string);
    name?: string;
    ariaLabel?: string | (() => string);
    onInput?: (e: Event) => void;
    onChange?: (e: Event) => void;
    onKeyDown?: (e: KeyboardEvent) => void;
    onFocus?: (e: FocusEvent) => void;
    onBlur?: (e: FocusEvent) => void;
    class?: string | (() => string);
    ref?: (el: HTMLInputElement) => void;
}

/**
 * Controlled input component.
 *
 * Controlled value updates write directly to the DOM property without resetting
 * selection or clobbering in-progress keystrokes.
 */
export function Input(props: InputProps = {}): HTMLInputElement {
    const classList: string[] = ['mesh-input'];

    const staticClass = classList.join(' ');
    const mergedClass = typeof props.class === 'function'
        ? () => `${staticClass} ${props.class ? (props.class as () => string)() : ''}`.trim()
        : props.class ? `${staticClass} ${props.class}` : staticClass;

    const elementProps: Props<HTMLInputElement> = {
        type: props.type ?? 'text',
        class: mergedClass,
        ...(props.value !== undefined ? { value: props.value } : {}),
        ...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {}),
        ...(props.disabled !== undefined ? { disabled: props.disabled } : {}),
        ...(props.readonly !== undefined ? { readonly: props.readonly } : {}),
        ...(props.required !== undefined ? { required: props.required } : {}),
        ...(props.id !== undefined ? { id: props.id } : {}),
        ...(props.name !== undefined ? { name: props.name } : {}),
        ...(props.ariaLabel !== undefined ? { 'aria-label': props.ariaLabel } : {}),
        ...(props.onInput ? { onInput: props.onInput } : {}),
        ...(props.onChange ? { onChange: props.onChange } : {}),
        ...(props.onKeyDown ? { onKeyDown: (e: Event) => props.onKeyDown?.(e as KeyboardEvent) } : {}),
        ...(props.onFocus ? { onFocus: (e: Event) => props.onFocus?.(e as FocusEvent) } : {}),
        ...(props.onBlur ? { onBlur: (e: Event) => props.onBlur?.(e as FocusEvent) } : {}),
        ...(props.ref ? { ref: props.ref } : {}),
    };

    return h('input', elementProps);
}
