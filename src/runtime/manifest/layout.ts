import type { LayoutPolicy, LayoutRegionPolicy } from '../app/types.js';
import type { Manifest } from './types.js';

/**
 * Converts a validated Manifest's layout definition into the `LayoutPolicy` consumed
 * by the existing Compositor and AppHost runtime.
 *
 * Preserves the exact structural constraints established in spec/03 and spec/09.
 */
export function manifestToLayoutPolicy(manifest: Manifest, root?: HTMLElement): LayoutPolicy {
    const regions: Record<string, LayoutRegionPolicy> = {};
    for (const [name, regionConfig] of Object.entries(manifest.layout.regions)) {
        regions[name] = {
            slots: regionConfig.slots,
            roles: regionConfig.roles,
        };
    }

    return {
        regions,
        banners: manifest.layout.banners,
        overlays: manifest.layout.overlays,
        popups: manifest.layout.popups,
        taskSwitcher: manifest.layout.taskSwitcher,
        root,
    };
}
