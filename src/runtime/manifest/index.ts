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
} from './types.js';

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
} from './schema.js';

export { validateManifest, validateManifestOverlay } from './validate.js';
export { mergeManifests } from './merge.js';
export { manifestToLayoutPolicy } from './layout.js';
export {
    parseManifest,
    isAppAuthAllowed,
    loadEagerApps,
    type ParseManifestOptions,
    type ParsedManifestResult,
} from './loader.js';
