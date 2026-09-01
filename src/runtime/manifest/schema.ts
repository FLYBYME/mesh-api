import { z } from '@flybyme/mesh/contracts';

/**
 * Closed set of surface roles validated per spec/03.
 */
export const surfaceRoleSchema = z.enum([
    'page',
    'panel',
    'popup',
    'banner',
    'overlay',
    'background',
]);

/**
 * Surface placement config schema.
 */
export const surfaceConfigSchema = z.object({
    role: surfaceRoleSchema,
    route: z.string().optional(),
    slot: z.string().optional(),
    order: z.number().optional(),
});

/**
 * App loading strategy schema.
 */
export const loadStrategySchema = z.enum(['eager', 'on-route', 'on-demand']);

/**
 * Auth gating level schema.
 */
export const manifestAuthLevelSchema = z.enum(['public', 'user', 'admin']);

/**
 * Site metadata schema.
 */
export const siteConfigSchema = z.object({
    id: z.string().min(1, 'site.id must not be empty'),
    title: z.string().min(1, 'site.title must not be empty'),
    theme: z.string().optional(),
});

/**
 * Region layout configuration schema.
 */
export const regionLayoutConfigSchema = z.object({
    slots: z.array(z.string()).optional(),
    collapsible: z.boolean().optional(),
    roles: z.array(surfaceRoleSchema).optional(),
});

/**
 * Task switcher configuration schema.
 */
export const taskSwitcherConfigSchema = z.object({
    enabled: z.boolean().optional(),
    hotkey: z.string().optional(),
});

/**
 * Layout configuration schema.
 */
export const layoutConfigSchema = z.object({
    regions: z.record(regionLayoutConfigSchema),
    banners: z.union([z.boolean(), z.enum(['enabled', 'disabled'])]).optional(),
    overlays: z.union([z.boolean(), z.enum(['enabled', 'disabled'])]).optional(),
    popups: z.union([z.boolean(), z.enum(['enabled', 'disabled'])]).optional(),
    taskSwitcher: taskSwitcherConfigSchema.optional(),
});

/**
 * Local app declaration schema.
 */
export const localAppConfigSchema = z.object({
    id: z.string().min(1, 'app id must not be empty'),
    module: z.string().min(1, 'app module path must not be empty'),
    load: loadStrategySchema.optional(),
    auth: manifestAuthLevelSchema.optional(),
    surfaces: z.array(surfaceConfigSchema).optional(),
});

/**
 * Remote app declaration schema.
 *
 * Per spec/09: `version` is pinned and `integrity` (SRI hash) is strictly mandatory.
 */
export const remoteAppConfigSchema = z.object({
    id: z.string().min(1, 'remote app id must not be empty'),
    version: z.string().min(1, 'remote app version must be pinned and not empty'),
    integrity: z.string().min(1, 'remote app integrity (SRI hash) is required'),
    module: z.string().optional(),
    load: loadStrategySchema.optional(),
    auth: manifestAuthLevelSchema.optional(),
    surfaces: z.array(surfaceConfigSchema).optional(),
});

/**
 * Remote site federation block schema.
 *
 * Per spec/09 and spec/12: every remote app must be explicitly named in `apps` (no wildcards).
 */
export const remoteSiteConfigSchema = z.object({
    namespace: z.string().min(1, 'remote namespace must not be empty'),
    origin: z.string().min(1, 'remote origin must not be empty'),
    mount: z.string().min(1, 'remote mount path must not be empty'),
    apps: z.array(remoteAppConfigSchema).min(1, 'remote apps list must not be empty (no wildcards allowed)'),
});

/**
 * Complete deployment manifest Zod schema.
 */
export const manifestSchema = z.object({
    site: siteConfigSchema,
    layout: layoutConfigSchema,
    apps: z.array(localAppConfigSchema).optional().default([]),
    remotes: z.array(remoteSiteConfigSchema).optional().default([]),
});

/**
 * Environment overlay schema for merging per-environment differences.
 */
export const manifestOverlaySchema = z.object({
    site: siteConfigSchema.partial().optional(),
    layout: z
        .object({
            regions: z.record(regionLayoutConfigSchema).optional(),
            banners: z.union([z.boolean(), z.enum(['enabled', 'disabled'])]).optional(),
            overlays: z.union([z.boolean(), z.enum(['enabled', 'disabled'])]).optional(),
            popups: z.union([z.boolean(), z.enum(['enabled', 'disabled'])]).optional(),
            taskSwitcher: taskSwitcherConfigSchema.partial().optional(),
        })
        .optional(),
    apps: z.array(localAppConfigSchema).optional(),
    remotes: z.array(remoteSiteConfigSchema).optional(),
});
