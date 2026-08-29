import type { ReactiveScope, DisposeFn } from '../reactivity/types.js';

/**
 * Primitive leaf values that can be inserted directly into the DOM tree.
 * Booleans, null, and undefined represent empty slots without rendered output.
 */
export type PrimitiveChild = string | number | boolean | null | undefined;

/**
 * A DOM Node or primitive value that can be mounted into the document tree.
 */
export type DOMChild = Node | PrimitiveChild;

/**
 * Dynamic child generator. When a function is passed as a child, it represents
 * a reactive expression that evaluates to DOM nodes or text.
 */
export type DynamicChild = () => DOMChild | DOMChild[];

/**
 * Recursive child definition supporting nested arrays and reactive bindings.
 */
export type Child = DOMChild | DynamicChild | Child[];

/**
 * Event handler callback signature. Real addEventListener handlers receive standard DOM Events.
 */
export type EventHandler<E extends Event = Event> = (event: E) => void;

/**
 * Property bag passed to h(). Supports static attributes, reactive binding accessors,
 * style/class definitions, event listeners, and direct element refs.
 */
export type Props<T extends HTMLElement = HTMLElement> = {
    class?: string | Record<string, boolean | unknown> | (() => string | Record<string, boolean | unknown> | null | undefined) | null | undefined;
    style?: string | Record<string, string | number | null | undefined> | (() => string | Record<string, string | number | null | undefined> | null | undefined) | null | undefined;
    id?: string | (() => string | null | undefined) | null | undefined;
    ref?: (el: T) => void;
    [key: string]: unknown;
};

/**
 * Component signature: a plain function taking props and returning an HTMLElement.
 * No base classes, no virtual DOM nodes, no updateProps() or render() lifecycle methods.
 */
export type Component<P = Record<string, unknown>> = (props: P) => HTMLElement;

export type { ReactiveScope, DisposeFn };
