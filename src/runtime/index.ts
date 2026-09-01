// `@flybyme/mesh-api/runtime` -- the BROWSER half: reactivity, DOM, apps, router, manifest.
//
// Kept separate from the package root because these modules `import './x.css'` for real, which
// Node cannot load. See `src/index.ts` for the full reasoning.

/// <reference path="./dom/css.d.ts" />

// Reactivity Core
export type {
    Signal,
    ReadonlySignal,
    Resource,
    ReactiveScope,
    EffectFn,
    CleanupFn,
    DisposeFn,
    ResourceMutator,
} from './reactivity/index.js';
export {
    signal,
    computed,
    effect,
    batch,
    untrack,
    flushSync,
    resource,
    createScope,
} from './reactivity/index.js';

// DOM & Components Runtime
export type {
    Child,
    DOMChild,
    PrimitiveChild,
    DynamicChild,
    Props,
    Component,
    EventHandler,
    StackProps,
    RowProps,
    TextProps,
    HeadingProps,
    ButtonProps,
    InputProps,
    CardProps,
    BadgeProps,
    BadgeVariant,
    SpinnerProps,
    EmptyStateProps,
    ErrorStateProps,
    FormProps,
    StringInputType,
    FormContractLike,
    TableProps,
    TableColumn,
    TableColumnProp,
} from './dom/index.js';
export {
    h,
    When,
    For,
    bindClass,
    bindStyle,
    bindAttr,
    bindText,
    attachScope,
    getScope,
    disposeElement,
    registerCleanup,
    setAttributeOrProperty,
    Stack,
    Row,
    Text,
    Heading,
    Button,
    Input,
    Card,
    Badge,
    Spinner,
    EmptyState,
    ErrorState,
    Form,
    Table,
} from './dom/index.js';

// App Runtime & Compositor
export type {
    SurfaceRole,
    SurfaceRefusalReason,
    SurfaceResult,
    SurfaceRequest,
    SurfaceDefinition,
    AppLifecycleState,
    AppStateContainer,
    AppContext,
    AppDefinition,
    LayoutRegionPolicy,
    LayoutPolicy,
    AppHostOptions,
    AppHost,
    LeakableResource,
} from './app/index.js';
export {
    defineApp,
    getRegisteredApp,
    getAllRegisteredApps,
    clearAppRegistry,
    createAppHost,
    AppHostImpl,
    Compositor,
    AppInstance,
    AppContextImpl,
    AppStateContainerImpl,
    MemoryStorage,
    AppLeakError,
    assertNoAppLeaks,
} from './app/index.js';

// Manifest & Layout Policy
export type {
    LoadStrategy,
    ManifestAuthLevel,
    SiteConfig,
    RegionLayoutConfig,
    TaskSwitcherConfig,
    LayoutConfig,
    SurfaceConfig,
    LocalAppConfig,
    RemoteAppConfig,
    RemoteSiteConfig,
    Manifest,
    ManifestOverlay,
    ParseManifestOptions,
    ParsedManifestResult,
} from './manifest/index.js';
export {
    surfaceRoleSchema,
    surfaceConfigSchema,
    loadStrategySchema,
    manifestAuthLevelSchema,
    siteConfigSchema,
    regionLayoutConfigSchema,
    taskSwitcherConfigSchema,
    layoutConfigSchema,
    localAppConfigSchema,
    remoteAppConfigSchema,
    remoteSiteConfigSchema,
    manifestSchema,
    manifestOverlaySchema,
    validateManifest,
    validateManifestOverlay,
    mergeManifests,
    manifestToLayoutPolicy,
    parseManifest,
    isAppAuthAllowed,
    loadEagerApps,
} from './manifest/index.js';

// Router & History Navigation
export type {
    RouteParams,
    ScopedRouter,
    ViewComponent,
    ViewDefinition,
    AppRouteDefinition,
    RouteResolution,
    RouterOptions,
    ScrollPosition,
} from './router/index.js';
export {
    normalizePath,
    matchRoutePattern,
    matchViewPattern,
    resolveHierarchy,
    shouldInterceptLinkClick,
    attachLinkInterceptor,
    ScrollManager,
    ScopedRouterImpl,
    mountViews,
    Router,
    createRouter,
} from './router/index.js';

// Live Event Stream Bridge
export type {
    EventBridgeState,
    EventBridgeClientOptions,
    EventBridgeClient,
} from './events/index.js';
export { createEventBridgeClient } from './events/index.js';

