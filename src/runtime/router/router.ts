import type { ReadonlySignal, Signal } from '../reactivity/types.js';
import { signal } from '../reactivity/signal.js';
import { batch } from '../reactivity/batch.js';
import type { AppHost } from '../app/types.js';
import type { Manifest, ManifestAuthLevel, RemoteSiteConfig } from '../manifest/types.js';
import { isAppAuthAllowed } from '../manifest/loader.js';
import type { SessionUser } from '../../auth/types.js';
import type {
    AppRouteDefinition,
    RouteParams,
    RouterOptions,
    ScopedRouter,
} from './types.js';
import { resolveHierarchy, normalizePath } from './match.js';
import { attachLinkInterceptor } from './link.js';
import { ScrollManager } from './scroll.js';
import { ScopedRouterImpl, type TopLevelNavigationHost } from './scoped.js';

/**
 * Router: manages URLs, browser history, three-tier route dispatch,
 * same-origin link interception, and scroll/focus restoration.
 */
export class Router implements TopLevelNavigationHost {
    private readonly host?: AppHost;
    private readonly manifest?: Manifest;
    private readonly routes: AppRouteDefinition[] = [];
    private readonly scrollManager = new ScrollManager();
    private readonly scopedRouters = new Map<string, ScopedRouterImpl>();
    private readonly win?: Window;
    private readonly root?: HTMLElement;
    private readonly sessionOption?:
        | { user?: () => SessionUser | null; isAuthed?: () => boolean }
        | Signal<SessionUser | null>
        | (() => SessionUser | null);

    private readonly _fullPath: Signal<string>;
    private readonly _currentPath: Signal<string>;
    private readonly _params: Signal<RouteParams>;
    private readonly _query: Signal<URLSearchParams>;
    private readonly _currentAppId: Signal<string | null>;
    private readonly _currentNamespace: Signal<string | undefined>;
    private readonly _currentMountPrefix: Signal<string>;
    private readonly _isNotFound: Signal<boolean>;
    private readonly _isUnauthorized: Signal<boolean>;

    private cleanupLinkInterceptor?: () => void;
    private popstateHandler?: (e: PopStateEvent) => void;

    constructor(options: RouterOptions = {}) {
        this.host = options.host;
        this.manifest = options.manifest;
        this.root = options.root;
        this.win = options.window ?? (typeof window !== 'undefined' ? window : undefined);
        this.sessionOption = options.session;

        // Initialize signals
        const initialPath = this.getInitialLocation();
        const [initPathnameAndSearch = ''] = initialPath.split('#');
        const [initPathname = '/', initSearch = ''] = initPathnameAndSearch.split('?');

        this._fullPath = signal(initialPath);
        this._currentPath = signal(normalizePath(initPathname));
        this._params = signal({});
        this._query = signal(new URLSearchParams(initSearch));
        this._currentAppId = signal(null);
        this._currentNamespace = signal(undefined);
        this._currentMountPrefix = signal('');
        this._isNotFound = signal(false);
        this._isUnauthorized = signal(false);

        // Populate routes from manifest and explicit options
        this.initRoutes(options.routes);

        // Setup History and Link Interceptor
        this.setupHistory();

        if (this.host && 'setRouter' in this.host && typeof this.host.setRouter === 'function') {
            this.host.setRouter(this);
        }

        if (options.interceptLinks !== false && this.win) {
            this.cleanupLinkInterceptor = attachLinkInterceptor(
                this.root ?? this.win.document,
                (href) => this.navigate(href)
            );
        }
    }

    get fullPath(): ReadonlySignal<string> {
        return this._fullPath;
    }

    get currentPath(): ReadonlySignal<string> {
        return this._currentPath;
    }

    get params(): ReadonlySignal<RouteParams> {
        return this._params;
    }

    get query(): ReadonlySignal<URLSearchParams> {
        return this._query;
    }

    get currentAppId(): ReadonlySignal<string | null> {
        return this._currentAppId;
    }

    get currentNamespace(): ReadonlySignal<string | undefined> {
        return this._currentNamespace;
    }

    get currentMountPrefix(): ReadonlySignal<string> {
        return this._currentMountPrefix;
    }

    get isNotFound(): ReadonlySignal<boolean> {
        return this._isNotFound;
    }

    get isUnauthorized(): ReadonlySignal<boolean> {
        return this._isUnauthorized;
    }

    private getInitialLocation(): string {
        if (this.win && this.win.location) {
            return `${this.win.location.pathname}${this.win.location.search}${this.win.location.hash}`;
        }
        return '/';
    }

    private getSessionUser(): SessionUser | null {
        if (!this.sessionOption) return null;
        if (typeof this.sessionOption === 'function') {
            return this.sessionOption();
        }
        if ('user' in this.sessionOption && typeof this.sessionOption.user === 'function') {
            return this.sessionOption.user() ?? null;
        }
        if ('peek' in this.sessionOption && typeof this.sessionOption.peek === 'function') {
            return this.sessionOption.peek();
        }
        return null;
    }

    private initRoutes(explicitRoutes?: readonly AppRouteDefinition[]): void {
        if (explicitRoutes) {
            for (const r of explicitRoutes) {
                this.routes.push(r);
            }
        }

        if (this.manifest) {
            // Register local apps with 'page' role surfaces
            if (this.manifest.apps) {
                for (const app of this.manifest.apps) {
                    if (app.surfaces) {
                        for (const surface of app.surfaces) {
                            if (surface.role === 'page' && surface.route) {
                                this.routes.push({
                                    appId: app.id,
                                    route: surface.route,
                                    auth: app.auth,
                                    namespace: 'local',
                                    mountPrefix: '',
                                });
                            }
                        }
                    }
                }
            }

            // Register federated remote apps
            if (this.manifest.remotes) {
                for (const remote of this.manifest.remotes) {
                    for (const app of remote.apps) {
                        if (app.surfaces) {
                            for (const surface of app.surfaces) {
                                if (surface.role === 'page' && surface.route) {
                                    this.routes.push({
                                        appId: app.id,
                                        route: surface.route,
                                        auth: app.auth,
                                        namespace: remote.namespace,
                                        mountPrefix: remote.mount,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private setupHistory(): void {
        if (!this.win) return;

        if ('scrollRestoration' in this.win.history) {
            this.win.history.scrollRestoration = 'manual';
        }

        this.popstateHandler = () => {
            const loc = this.getInitialLocation();
            void this.handleNavigation(loc, { isPopState: true });
        };

        this.win.addEventListener('popstate', this.popstateHandler);
    }

    registerRoute(route: AppRouteDefinition): void {
        this.routes.push(route);
    }

    /**
     * Initializes route resolution for the current initial URL.
     */
    async start(): Promise<void> {
        const initial = this.getInitialLocation();
        await this.handleNavigation(initial, { isPopState: false });
    }

    async navigate(path: string, options?: { replace?: boolean }): Promise<void> {
        if (this.win && this.win.history) {
            if (options?.replace) {
                this.win.history.replaceState(null, '', path);
            } else {
                this.scrollManager.save(this._fullPath.peek(), this.win);
                this.win.history.pushState(null, '', path);
                this.scrollManager.reset(this.win);
            }
        }

        await this.handleNavigation(path, { isPopState: false });
        this.scrollManager.focusMainContent(this.root, this.win?.document);
    }

    async replace(path: string): Promise<void> {
        return this.navigate(path, { replace: true });
    }

    back(): void {
        if (this.win && this.win.history) {
            this.win.history.back();
        }
    }

    forward(): void {
        if (this.win && this.win.history) {
            this.win.history.forward();
        }
    }

    /**
     * Handles URL transitions across the three-tier hierarchy and drives AppHost activation.
     */
    async handleNavigation(rawUrl: string, options?: { isPopState?: boolean }): Promise<void> {
        const [pathAndSearch = '', hash = ''] = rawUrl.split('#');
        const [rawPathname = '/', search = ''] = pathAndSearch.split('?');
        const pathname = normalizePath(rawPathname);
        const searchParams = new URLSearchParams(search);

        const remotes: readonly RemoteSiteConfig[] | undefined = this.manifest?.remotes;
        const resolution = resolveHierarchy(pathname, remotes, this.routes);

        if (!resolution.matched || !resolution.appId) {
            batch(() => {
                this._fullPath.set(rawUrl);
                this._currentPath.set(pathname);
                this._params.set({});
                this._query.set(searchParams);
                this._currentAppId.set(null);
                this._currentNamespace.set(resolution.namespace);
                this._currentMountPrefix.set(resolution.mountPrefix);
                this._isNotFound.set(true);
                this._isUnauthorized.set(false);
            });
            return;
        }

        const targetAppId = resolution.appId;

        // 1. Auth Gating Check per spec/02 and spec/09
        let requiredAuth = resolution.appRoute ? this.findAppAuth(targetAppId) : undefined;
        if (requiredAuth === undefined) {
            const matchedRouteDef = this.routes.find((r) => r.appId === targetAppId);
            requiredAuth = matchedRouteDef?.auth;
        }

        const sessionUser = this.getSessionUser();
        const allowed = isAppAuthAllowed(requiredAuth, sessionUser);

        if (!allowed) {
            batch(() => {
                this._fullPath.set(rawUrl);
                this._currentPath.set(resolution.appRelativePath);
                this._params.set(resolution.params);
                this._query.set(searchParams);
                this._currentAppId.set(targetAppId);
                this._currentNamespace.set(resolution.namespace);
                this._currentMountPrefix.set(resolution.mountPrefix);
                this._isNotFound.set(false);
                this._isUnauthorized.set(true);
            });
            // Crucial: do NOT load or activate auth-gated app for unauthorized session
            return;
        }

        // 2. Drive AppHost activation
        if (this.host) {
            const appState = this.host.getAppState(targetAppId);
            if (appState === undefined || appState === 'registered') {
                await this.host.loadApp(targetAppId);
            }
            if (this.host.getForegroundAppId() !== targetAppId) {
                await this.host.activateApp(targetAppId);
            }
        }

        // 3. Atomically update reactive signals
        batch(() => {
            this._fullPath.set(rawUrl);
            this._currentPath.set(resolution.appRelativePath);
            this._params.set(resolution.params);
            this._query.set(searchParams);
            this._currentAppId.set(targetAppId);
            this._currentNamespace.set(resolution.namespace);
            this._currentMountPrefix.set(resolution.mountPrefix);
            this._isNotFound.set(false);
            this._isUnauthorized.set(false);
        });

        // 4. Restore scroll on back/forward
        if (options?.isPopState) {
            this.scrollManager.restore(rawUrl, this.win);
        }
    }

    private findAppAuth(appId: string): ManifestAuthLevel | undefined {
        if (this.manifest?.apps) {
            const found = this.manifest.apps.find((a) => a.id === appId);
            if (found?.auth) return found.auth;
        }
        if (this.manifest?.remotes) {
            for (const r of this.manifest.remotes) {
                const found = r.apps.find((a) => a.id === appId);
                if (found?.auth) return found.auth;
            }
        }
        return undefined;
    }

    /**
     * Returns an App-scoped router instance enforcing prefix transparency.
     */
    getAppRouter(appId: string, options?: { namespace?: string; mountPrefix?: string }): ScopedRouter {
        let scoped = this.scopedRouters.get(appId);
        if (scoped === undefined) {
            const routeDef = this.routes.find((r) => r.appId === appId);
            const namespace = options?.namespace ?? routeDef?.namespace ?? this._currentNamespace.peek();
            const mountPrefix = options?.mountPrefix ?? routeDef?.mountPrefix ?? this._currentMountPrefix.peek();

            scoped = new ScopedRouterImpl({
                appId,
                namespace,
                mountPrefix,
                params: this._params,
                query: this._query,
                currentPath: this._currentPath,
                navHost: this,
            });
            this.scopedRouters.set(appId, scoped);
        }
        return scoped;
    }

    dispose(): void {
        if (this.cleanupLinkInterceptor) {
            this.cleanupLinkInterceptor();
        }
        if (this.popstateHandler && this.win) {
            this.win.removeEventListener('popstate', this.popstateHandler);
        }
        this.scrollManager.clear();
        this.scopedRouters.clear();
    }
}

/**
 * Creates and initializes a top-level Router.
 */
export function createRouter(options: RouterOptions = {}): Router {
    return new Router(options);
}
