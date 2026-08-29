import type {
    Manifest,
    ManifestOverlay,
    LocalAppConfig,
    RemoteSiteConfig,
    RemoteAppConfig,
    RegionLayoutConfig,
    LayoutConfig,
    TaskSwitcherConfig,
} from './types.js';
import { validateManifest } from './validate.js';

/**
 * Merges an environment overlay into a base manifest.
 *
 * Per spec/09:
 * - `site` fields are overridden by overlay values.
 * - `layout.regions` merges region configurations; layout flags (banners, overlays, etc.) override base values.
 * - `apps` are merged by App ID: an overlay app with matching ID replaces the base declaration; new apps are appended.
 * - `remotes` are merged by namespace: matching namespaces merge apps by ID; new remotes are appended.
 */
export function mergeManifests(base: Manifest, overlay: ManifestOverlay | Manifest): Manifest {
    // 1. Merge site configuration
    const mergedSite = {
        id: overlay.site?.id ?? base.site.id,
        title: overlay.site?.title ?? base.site.title,
        theme: overlay.site?.theme ?? base.site.theme,
    };

    // 2. Merge layout configuration
    const mergedRegions: Record<string, RegionLayoutConfig> = { ...base.layout.regions };
    if (overlay.layout?.regions) {
        for (const [regionName, regionCfg] of Object.entries(overlay.layout.regions)) {
            const baseRegion = mergedRegions[regionName];
            if (baseRegion !== undefined) {
                mergedRegions[regionName] = {
                    slots: regionCfg.slots ?? baseRegion.slots,
                    collapsible: regionCfg.collapsible ?? baseRegion.collapsible,
                    roles: regionCfg.roles ?? baseRegion.roles,
                };
            } else {
                mergedRegions[regionName] = regionCfg;
            }
        }
    }

    let taskSwitcher: TaskSwitcherConfig | undefined = undefined;
    if (overlay.layout?.taskSwitcher !== undefined || base.layout.taskSwitcher !== undefined) {
        taskSwitcher = {
            enabled: overlay.layout?.taskSwitcher?.enabled ?? base.layout.taskSwitcher?.enabled,
            hotkey: overlay.layout?.taskSwitcher?.hotkey ?? base.layout.taskSwitcher?.hotkey,
        };
    }

    const mergedLayout: LayoutConfig = {
        regions: mergedRegions,
        banners: overlay.layout?.banners ?? base.layout.banners,
        overlays: overlay.layout?.overlays ?? base.layout.overlays,
        popups: overlay.layout?.popups ?? base.layout.popups,
        taskSwitcher,
    };

    // 3. Merge local apps by App ID
    const appMap = new Map<string, LocalAppConfig>();
    if (base.apps) {
        for (const app of base.apps) {
            appMap.set(app.id, app);
        }
    }
    if (overlay.apps) {
        for (const app of overlay.apps) {
            appMap.set(app.id, app);
        }
    }
    const mergedApps = Array.from(appMap.values());

    // 4. Merge remote sites by namespace
    const remoteMap = new Map<string, RemoteSiteConfig>();
    if (base.remotes) {
        for (const remote of base.remotes) {
            remoteMap.set(remote.namespace, remote);
        }
    }
    if (overlay.remotes) {
        for (const overlayRemote of overlay.remotes) {
            const baseRemote = remoteMap.get(overlayRemote.namespace);
            if (baseRemote !== undefined) {
                // Merge apps inside this remote namespace by app ID
                const remoteAppMap = new Map<string, RemoteAppConfig>();
                for (const app of baseRemote.apps) {
                    remoteAppMap.set(app.id, app);
                }
                for (const app of overlayRemote.apps) {
                    remoteAppMap.set(app.id, app);
                }
                remoteMap.set(overlayRemote.namespace, {
                    namespace: overlayRemote.namespace,
                    origin: overlayRemote.origin ?? baseRemote.origin,
                    mount: overlayRemote.mount ?? baseRemote.mount,
                    apps: Array.from(remoteAppMap.values()),
                });
            } else {
                remoteMap.set(overlayRemote.namespace, overlayRemote);
            }
        }
    }
    const mergedRemotes = Array.from(remoteMap.values());

    const mergedManifest: Manifest = {
        site: mergedSite,
        layout: mergedLayout,
        apps: mergedApps,
        remotes: mergedRemotes,
    };

    return validateManifest(mergedManifest);
}
