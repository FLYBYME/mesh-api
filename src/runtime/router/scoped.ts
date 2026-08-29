import type { ReadonlySignal, Signal } from '../reactivity/types.js';
import type { RouteParams, ScopedRouter } from './types.js';
import { normalizePath } from './match.js';

export interface TopLevelNavigationHost {
    navigate(path: string, options?: { replace?: boolean }): Promise<void>;
    replace(path: string): Promise<void>;
    back(): void;
    forward(): void;
    readonly fullPath: ReadonlySignal<string>;
}

/**
 * ScopedRouterImpl: provides an App or View with an isolated routing interface.
 *
 * Implements prefix transparency:
 * When an App is mounted under a namespace prefix (`/b`), it interacts with its
 * own sub-paths as if it was mounted at root. The scoped router adds the mount
 * prefix when pushing/replacing URLs and strips it when exposing `currentPath`.
 */
export class ScopedRouterImpl implements ScopedRouter {
    readonly appId: string;
    readonly namespace?: string;
    readonly mountPrefix: string;
    readonly params: ReadonlySignal<RouteParams>;
    readonly query: ReadonlySignal<URLSearchParams>;
    readonly currentPath: ReadonlySignal<string>;
    private readonly navHost: TopLevelNavigationHost;

    constructor(options: {
        appId: string;
        namespace?: string;
        mountPrefix?: string;
        params: ReadonlySignal<RouteParams>;
        query: ReadonlySignal<URLSearchParams>;
        currentPath: ReadonlySignal<string>;
        navHost: TopLevelNavigationHost;
    }) {
        this.appId = options.appId;
        this.namespace = options.namespace;
        this.mountPrefix = options.mountPrefix ? normalizePath(options.mountPrefix) : '';
        this.params = options.params;
        this.query = options.query;
        this.currentPath = options.currentPath;
        this.navHost = options.navHost;
    }

    /**
     * Resolves an app-relative path to a top-level absolute URL by prepending the mount prefix.
     */
    private toTopLevelPath(path: string): string {
        if (path.startsWith('http://') || path.startsWith('https://')) {
            return path;
        }

        const [pathAndSearch = '', hash = ''] = path.split('#');
        const [pathname = '', search = ''] = pathAndSearch.split('?');

        const normPath = normalizePath(pathname);
        const prefixedPath =
            this.mountPrefix !== '' && this.mountPrefix !== '/'
                ? `${this.mountPrefix}${normPath === '/' ? '' : normPath}`
                : normPath;

        let result = prefixedPath;
        if (search) {
            result += `?${search}`;
        }
        if (hash) {
            result += `#${hash}`;
        }
        return result;
    }

    async navigate(path: string, options?: { replace?: boolean }): Promise<void> {
        const topLevelPath = this.toTopLevelPath(path);
        return this.navHost.navigate(topLevelPath, options);
    }

    async replace(path: string): Promise<void> {
        const topLevelPath = this.toTopLevelPath(path);
        return this.navHost.replace(topLevelPath);
    }

    back(): void {
        this.navHost.back();
    }

    forward(): void {
        this.navHost.forward();
    }

    /**
     * Creates a two-way reactive binding to a URL query parameter.
     *
     * Calling `getter()` reads the current value or fallback.
     * Calling `.set(val)` updates the URL query string via `replaceState` without full remounting.
     */
    queryParam(name: string, defaultValue = ''): Signal<string> {
        const getter = (): string => {
            const currentVal = this.query().get(name);
            return currentVal !== null ? currentVal : defaultValue;
        };

        const peek = (): string => {
            const currentVal = this.query.peek().get(name);
            return currentVal !== null ? currentVal : defaultValue;
        };

        const set = (value: string): void => {
            const currentSearch = this.query.peek();
            const next = new URLSearchParams(currentSearch.toString());

            if (value === defaultValue || value === '') {
                next.delete(name);
            } else {
                next.set(name, value);
            }

            const qs = next.toString();
            const currentAppPath = this.currentPath.peek();
            const target = qs ? `${currentAppPath}?${qs}` : currentAppPath;
            void this.replace(target);
        };

        const update = (fn: (prev: string) => string): void => {
            const prev = getter();
            set(fn(prev));
        };

        const signalObj: Signal<string> = Object.assign(getter, {
            peek,
            set,
            update,
        });

        return signalObj;
    }
}
