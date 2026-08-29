import type { RemoteSiteConfig } from '../manifest/types.js';
import type {
    AppRouteDefinition,
    RouteParams,
    RouteResolution,
    ViewDefinition,
} from './types.js';

/**
 * Normalizes a path string by ensuring a leading slash and collapsing multiple slashes.
 */
export function normalizePath(path: string): string {
    if (!path || path === '') return '/';
    const clean = path.replace(/\/+/g, '/');
    const withLeading = clean.startsWith('/') ? clean : `/${clean}`;
    if (withLeading.length > 1 && withLeading.endsWith('/')) {
        return withLeading.slice(0, -1);
    }
    return withLeading;
}

export interface PatternMatchResult {
    readonly matched: boolean;
    readonly params: RouteParams;
    readonly rest: string;
}

/**
 * Matches a route pattern (e.g. `/card/:id` or `/kanban/*`) against a normalized pathname.
 */
export function matchRoutePattern(pattern: string, pathname: string): PatternMatchResult | null {
    const normPattern = normalizePath(pattern);
    const normPath = normalizePath(pathname);

    // Root pattern exact match
    if (normPattern === '/') {
        if (normPath === '/') {
            return { matched: true, params: {}, rest: '' };
        }
        return null;
    }

    const patternSegments = normPattern.split('/').filter(Boolean);
    const pathSegments = normPath.split('/').filter(Boolean);

    const params: RouteParams = {};

    for (let i = 0; i < patternSegments.length; i++) {
        const pSeg = patternSegments[i];
        if (pSeg === undefined) break;

        if (pSeg === '*') {
            // Wildcard matches the remainder of path
            const remainingSegments = pathSegments.slice(i);
            const rest = remainingSegments.length > 0 ? `/${remainingSegments.join('/')}` : '/';
            return { matched: true, params, rest };
        }

        const pathSeg = pathSegments[i];
        if (pathSeg === undefined) {
            return null; // Path ran out before pattern
        }

        if (pSeg.startsWith(':')) {
            const paramName = pSeg.slice(1);
            params[paramName] = decodeURIComponent(pathSeg);
        } else if (pSeg !== pathSeg) {
            return null; // Segment mismatch
        }
    }

    // If pattern did not end with wildcard, all path segments must have been consumed
    if (pathSegments.length > patternSegments.length) {
        return null;
    }

    return { matched: true, params, rest: '' };
}

/**
 * Matches a view pattern against an app-level path by checking both the full path
 * and subpaths relative to the app's root route.
 */
export function matchViewPattern(viewPattern: string, appPath: string): PatternMatchResult | null {
    const normAppPath = normalizePath(appPath);

    // 1. Direct match (if view pattern includes the full app route prefix)
    const direct = matchRoutePattern(viewPattern, normAppPath);
    if (direct !== null && direct.matched) {
        return direct;
    }

    const segments = normAppPath.split('/').filter(Boolean);

    // If appPath is a single segment (e.g. `/kanban` or `/shop`), subPath is `/`
    if (segments.length <= 1) {
        if (normalizePath(viewPattern) === '/') {
            return { matched: true, params: {}, rest: '' };
        }
        return null;
    }

    // 2. Subpath match: strip leading app prefix segments
    for (let i = 1; i < segments.length; i++) {
        const remaining = segments.slice(i);
        const subPath = `/${remaining.join('/')}`;
        const subMatch = matchRoutePattern(viewPattern, subPath);
        if (subMatch !== null && subMatch.matched) {
            return subMatch;
        }
    }

    return null;
}

/**
 * Resolves the three-tier routing hierarchy:
 * 1. Namespace: resolves remote mount prefix (e.g. `/b`), stripping it for downstream apps.
 * 2. App: matches app route subtree (e.g. `/kanban/*`).
 * 3. View: matches view pattern within app subtree (e.g. `/card/:id`), extracting params.
 */
export function resolveHierarchy(
    pathname: string,
    remotes: readonly RemoteSiteConfig[] | undefined,
    appRoutes: readonly AppRouteDefinition[]
): RouteResolution {
    const normalized = normalizePath(pathname);

    // 1. Resolve Namespace level
    let matchedNamespace: string | undefined = undefined;
    let mountPrefix = '';
    let appRelativePath = normalized;

    if (remotes && remotes.length > 0) {
        // Sort remotes by longest mount prefix first to handle sub-mounts properly
        const sortedRemotes = [...remotes].sort((a, b) => b.mount.length - a.mount.length);
        for (const remote of sortedRemotes) {
            const remoteMount = normalizePath(remote.mount);
            if (normalized === remoteMount || normalized.startsWith(`${remoteMount}/`)) {
                matchedNamespace = remote.namespace;
                mountPrefix = remoteMount;
                const remainder = normalized.slice(remoteMount.length);
                appRelativePath = normalizePath(remainder);
                break;
            }
        }
    }

    // 2. Resolve App level
    // Filter routes matching the target namespace
    const candidates = appRoutes.filter((r) => {
        if (matchedNamespace !== undefined) {
            return r.namespace === matchedNamespace;
        }
        return !r.namespace || r.namespace === 'local';
    });

    for (const appRoute of candidates) {
        const matchResult = matchRoutePattern(appRoute.route, appRelativePath);
        if (matchResult !== null && matchResult.matched) {
            const appId = appRoute.appId;
            const subPath = matchResult.rest || '/';

            // 3. Resolve View level
            if (appRoute.views && appRoute.views.length > 0) {
                for (const viewDef of appRoute.views) {
                    const viewMatch = matchViewPattern(viewDef.path, appRelativePath);
                    if (viewMatch !== null && viewMatch.matched) {
                        const mergedParams: RouteParams = {
                            ...matchResult.params,
                            ...viewMatch.params,
                        };
                        return {
                            matched: true,
                            namespace: matchedNamespace,
                            mountPrefix,
                            appId,
                            appRoute: appRoute.route,
                            appRelativePath,
                            viewRelativePath: subPath,
                            view: viewDef,
                            params: mergedParams,
                            isAuthGated: false,
                        };
                    }
                }
                // App matched but no declared view matched
                return {
                    matched: false,
                    namespace: matchedNamespace,
                    mountPrefix,
                    appId,
                    appRoute: appRoute.route,
                    appRelativePath,
                    viewRelativePath: subPath,
                    params: matchResult.params,
                    isAuthGated: false,
                };
            }

            // App has no nested views declared: app-level match succeeds
            return {
                matched: true,
                namespace: matchedNamespace,
                mountPrefix,
                appId,
                appRoute: appRoute.route,
                appRelativePath,
                viewRelativePath: subPath,
                params: matchResult.params,
                isAuthGated: false,
            };
        }
    }

    return {
        matched: false,
        namespace: matchedNamespace,
        mountPrefix,
        appRelativePath,
        viewRelativePath: '',
        params: {},
        isAuthGated: false,
    };
}
