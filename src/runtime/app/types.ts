import type {
    Signal,
    ReadonlySignal,
    Resource,
    DisposeFn,
    EffectFn,
} from '../reactivity/types.js';

/**
 * Closed set of surface roles.
 *
 * Adding a role is a framework-level decision rather than an app-level one.
 * An open vocabulary would reintroduce the placement free-for-all the compositor
 * architecture exists to eliminate.
 */
export type SurfaceRole =
    | 'page'
    | 'panel'
    | 'popup'
    | 'banner'
    | 'overlay'
    | 'background';

/**
 * Concrete reasons why the compositor may refuse a surface request.
 *
 * Refusal is an expected, normal outcome under varying layout policies (e.g. a panel
 * requested under a storefront shell with no sidebar).
 */
export type SurfaceRefusalReason =
    | 'no_matching_region'
    | 'slot_not_found'
    | 'role_disabled'
    | 'superseded'
    | 'cancelled'
    | 'layout_missing';

/**
 * Discriminated outcome of requesting a surface from the compositor.
 *
 * The discriminated union on `granted` forces the consumer to handle refusal explicitly
 * before attempting to interact with the container element.
 */
export type SurfaceResult =
    | {
          readonly granted: true;
          readonly container: HTMLElement;
          dismiss(): void;
      }
    | {
          readonly granted: false;
          readonly reason: SurfaceRefusalReason;
      };

/**
 * Surface request submitted by an App to the compositor.
 *
 * Intentionally carries no positional or geometric coordinates: the App describes
 * what kind of surface it needs, and the compositor decides where (and whether) to place it.
 */
export interface SurfaceRequest {
    readonly role: SurfaceRole;
    readonly slot?: string;
    readonly anchor?: HTMLElement;
    readonly mount?: (container: HTMLElement) => void | (() => void) | Promise<void | (() => void)>;
}

/**
 * Static surface declaration on an App definition.
 */
export interface SurfaceDefinition {
    readonly role: SurfaceRole;
    readonly slot?: string;
    readonly route?: string;
    mount?(container: HTMLElement, ctx: AppContext): void | (() => void) | Promise<void | (() => void)>;
}

/**
 * App lifecycle state machine states.
 */
export type AppLifecycleState =
    | 'registered'
    | 'loaded'
    | 'foreground'
    | 'background'
    | 'unloaded'
    | 'failed';

/**
 * Isolated per-app state container.
 *
 * Every signal, computed, effect, and resource created through this container is bound
 * to the App's ReactiveScope and automatically disposed when the App unloads.
 */
export interface AppStateContainer {
    signal<T>(initial: T): Signal<T>;
    computed<T>(fn: () => T): ReadonlySignal<T>;
    effect(fn: EffectFn): DisposeFn;
    /** Mirrors `resource`'s real signature exactly: a fetcher, nothing else. */
    resource<T>(fetcher: () => Promise<T>): Resource<T>;
    persisted<T>(key: string, initial: T): Signal<T>;
    dispose(): void;
    readonly isDisposed: boolean;
}

/**
 * Disposable or cleanup handle that can be tracked for dev-mode leak assertions.
 */
export interface LeakableResource {
    readonly isDisposed?: boolean;
    dispose(): void;
}

/**
 * Execution context provided to an App's lifecycle hooks and surface mount functions.
 *
 * Structural constraint: there are no DOM positioning APIs, no target selectors,
 * and no layout region accessors on this object.
 */
export interface AppContext {
    readonly appId: string;
    readonly state: AppStateContainer;
    readonly status: AppLifecycleState;
    requestSurface(request: SurfaceRequest): Promise<SurfaceResult>;
    registerCleanup(cleanup: () => void): void;
    trackLeakable(resource: LeakableResource | (() => void)): void;
}

/**
 * Declaration of an App.
 */
export interface AppDefinition {
    readonly id: string;
    readonly title: string;
    readonly surfaces?: readonly SurfaceDefinition[];
    onLoad?(ctx: AppContext): void | Promise<void>;
    onActivate?(ctx: AppContext): void | Promise<void>;
    onDeactivate?(ctx: AppContext): void | Promise<void>;
    onUnload?(ctx: AppContext): void | Promise<void>;
}

/**
 * Configuration of a layout region.
 */
export interface LayoutRegionPolicy {
    readonly roles?: readonly SurfaceRole[];
    readonly slots?: readonly string[];
    readonly container?: HTMLElement;
}

/**
 * Layout policy determining how the compositor resolves and places surfaces.
 */
export interface LayoutPolicy {
    readonly regions: Record<string, LayoutRegionPolicy>;
    readonly banners?: 'enabled' | 'disabled' | boolean;
    readonly overlays?: 'enabled' | 'disabled' | boolean;
    readonly popups?: 'enabled' | 'disabled' | boolean;
    readonly taskSwitcher?: {
        readonly enabled?: boolean;
        readonly hotkey?: string;
    };
    readonly root?: HTMLElement;
}

/**
 * Options for creating an AppHost.
 */
export interface AppHostOptions {
    readonly policy: LayoutPolicy;
    readonly root: HTMLElement;
    readonly devMode?: boolean;
    readonly storage?: Storage;
}

/**
 * Runtime host managing loaded apps, compositor interactions, and task switching.
 */
export interface AppHost {
    loadApp(id: string): Promise<void>;
    activateApp(id: string): Promise<void>;
    deactivateApp(id: string): Promise<void>;
    unloadApp(id: string, options?: { assertNoLeaks?: boolean }): Promise<void>;
    switchTo(id: string): Promise<void>;
    getAppState(id: string): AppLifecycleState | undefined;
    getForegroundAppId(): string | null;
    getLoadedAppIds(): readonly string[];
    dispose(): void;
}
