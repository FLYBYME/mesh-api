import type { SurfaceRole } from '../app/types.js';

/**
 * Load strategy for an App declared in the manifest.
 *
 * - `eager`: loaded immediately at startup.
 * - `on-route`: loaded dynamically when a matching URL route is first visited.
 * - `on-demand`: loaded exclusively on explicit programmatic invocation via `ctx.apps.load(id)`.
 */
export type LoadStrategy = 'eager' | 'on-route' | 'on-demand';

/**
 * Authentication gating levels for an App.
 *
 * - `public`: always accessible without authentication.
 * - `user`: requires an active authenticated user session.
 * - `admin`: requires an authenticated session holding the `admin` role.
 */
export type ManifestAuthLevel = 'public' | 'user' | 'admin';

/**
 * Site-level metadata block.
 */
export interface SiteConfig {
    readonly id: string;
    readonly title: string;
    readonly theme?: string;
}

/**
 * Region layout configuration declaring named slots, collapsibility, and permitted roles.
 */
export interface RegionLayoutConfig {
    readonly slots?: readonly string[];
    readonly collapsible?: boolean;
    readonly roles?: readonly SurfaceRole[];
}

/**
 * Hotkey and task switcher configuration.
 */
export interface TaskSwitcherConfig {
    readonly enabled?: boolean;
    readonly hotkey?: string;
}

/**
 * Screen layout configuration defining regions, banners, overlays, and task switching.
 */
export interface LayoutConfig {
    readonly regions: Record<string, RegionLayoutConfig>;
    readonly banners?: boolean | 'enabled' | 'disabled';
    readonly overlays?: boolean | 'enabled' | 'disabled';
    readonly popups?: boolean | 'enabled' | 'disabled';
    readonly taskSwitcher?: TaskSwitcherConfig;
}

/**
 * Surface placement declaration for an app in the manifest.
 */
export interface SurfaceConfig {
    readonly role: SurfaceRole;
    readonly route?: string;
    readonly slot?: string;
    readonly order?: number;
}

/**
 * Local app declaration within the manifest.
 */
export interface LocalAppConfig {
    readonly id: string;
    readonly module: string;
    readonly load?: LoadStrategy;
    readonly auth?: ManifestAuthLevel;
    readonly surfaces?: readonly SurfaceConfig[];
}

/**
 * Remote app declaration federated from an external site.
 *
 * Mandatory security constraints per spec/09 and spec/12:
 * - Pinned version is required.
 * - Subresource Integrity (SRI) hash is mandatory. Wildcards are strictly forbidden.
 */
export interface RemoteAppConfig {
    readonly id: string;
    readonly version: string;
    readonly integrity: string;
    readonly module?: string;
    readonly load?: LoadStrategy;
    readonly auth?: ManifestAuthLevel;
    readonly surfaces?: readonly SurfaceConfig[];
}

/**
 * Remote site federation block declaring namespace alias, origin, mount prefix, and allowed apps.
 */
export interface RemoteSiteConfig {
    readonly namespace: string;
    readonly origin: string;
    readonly mount: string;
    readonly apps: readonly RemoteAppConfig[];
}

/**
 * Full deployment manifest specification.
 */
export interface Manifest {
    readonly site: SiteConfig;
    readonly layout: LayoutConfig;
    readonly apps?: readonly LocalAppConfig[];
    readonly remotes?: readonly RemoteSiteConfig[];
}

/**
 * Environment overlay used to augment or override a base manifest per deployment target.
 */
export interface ManifestOverlay {
    readonly site?: Partial<SiteConfig>;
    readonly layout?: {
        readonly regions?: Record<string, RegionLayoutConfig>;
        readonly banners?: boolean | 'enabled' | 'disabled';
        readonly overlays?: boolean | 'enabled' | 'disabled';
        readonly popups?: boolean | 'enabled' | 'disabled';
        readonly taskSwitcher?: Partial<TaskSwitcherConfig>;
    };
    readonly apps?: readonly LocalAppConfig[];
    readonly remotes?: readonly RemoteSiteConfig[];
}
