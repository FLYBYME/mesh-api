export type {
    RouteParams,
    ScopedRouter,
    ViewComponent,
    ViewDefinition,
    AppRouteDefinition,
    RouteResolution,
    RouterOptions,
} from './types.js';

export {
    normalizePath,
    matchRoutePattern,
    matchViewPattern,
    resolveHierarchy,
    type PatternMatchResult,
} from './match.js';
export { shouldInterceptLinkClick, attachLinkInterceptor } from './link.js';
export { ScrollManager, type ScrollPosition } from './scroll.js';
export { ScopedRouterImpl, type TopLevelNavigationHost } from './scoped.js';
export { mountViews } from './view.js';
export { Router, createRouter } from './router.js';
