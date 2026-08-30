import type { ReadonlySignal, Signal } from '../reactivity/types.js';
import type { AppHost, AppContext } from '../app/types.js';
import type { Manifest, ManifestAuthLevel } from '../manifest/types.js';
import type { SessionUser } from '../../auth/types.js';
import type { DOMChild } from '../dom/types.js';

/**
 * Extracted path parameters (e.g. `{ id: 'abc123' }`).
 */
export type RouteParams = Record<string, string>;

/**
 * Scoped router instance provided to an App or View.
 *
 * Implements prefix transparency per spec/07 and spec/12:
 * A remote app mounted under a prefix (e.g. `/b`) calls `navigate('/shop/card/1')`
 * and the scoped router automatically prefixes it to `/b/shop/card/1` without the app knowing.
 */
export interface ScopedRouter {
    readonly appId: string;
    navigate(path: string, options?: { replace?: boolean }): Promise<void>;
    replace(path: string): Promise<void>;
    back(): void;
    forward(): void;
    readonly params: ReadonlySignal<RouteParams>;
    readonly query: ReadonlySignal<URLSearchParams>;
    queryParam(name: string, defaultValue?: string): Signal<string>;
    readonly currentPath: ReadonlySignal<string>;
    readonly namespace?: string;
    readonly mountPrefix: string;
}

/**
 * Properties passed to a ViewComponent.
 */
export interface ViewProps<TApi = unknown> {
    params: ReadonlySignal<RouteParams>;
    query: ReadonlySignal<URLSearchParams>;
    router: ScopedRouter;
    ctx?: AppContext<TApi>;
}

/**
 * View component function signature.
 */
export type ViewComponent<TApi = unknown> = (
    props: ViewProps<TApi>,
    ctx?: AppContext<TApi>
) => HTMLElement | DOMChild;

/**
 * Declaration of a View within an App's page surface.
 */
export interface ViewDefinition<TApi = unknown> {
    readonly path: string;
    view(props: ViewProps<TApi>, ctx?: AppContext<TApi>): HTMLElement | DOMChild;
}

/**
 * Routing declaration for an App.
 */
export interface AppRouteDefinition {
    readonly appId: string;
    readonly route: string;
    readonly views?: readonly ViewDefinition[];
    readonly auth?: ManifestAuthLevel;
    readonly namespace?: string;
    readonly mountPrefix?: string;
}

/**
 * Three-tier hierarchy match resolution result.
 */
export interface RouteResolution {
    readonly matched: boolean;
    readonly namespace?: string;
    readonly mountPrefix: string;
    readonly appId?: string;
    readonly appRoute?: string;
    readonly appRelativePath: string;
    readonly viewRelativePath: string;
    readonly view?: ViewDefinition;
    readonly params: RouteParams;
    readonly isAuthGated: boolean;
}

/**
 * Top-level Router configuration options.
 */
export interface RouterOptions {
    readonly host?: AppHost;
    readonly manifest?: Manifest;
    readonly routes?: readonly AppRouteDefinition[];
    readonly root?: HTMLElement;
    readonly window?: Window;
    readonly session?:
        | { user?: () => SessionUser | null; isAuthed?: () => boolean }
        | Signal<SessionUser | null>
        | (() => SessionUser | null);
    readonly scrollRestoration?: 'auto' | 'manual';
    readonly interceptLinks?: boolean;
    readonly notFoundView?: ViewComponent;
    readonly unauthorizedView?: (props: {
        router: ScopedRouter;
        appId?: string;
    }) => HTMLElement | DOMChild;
}
