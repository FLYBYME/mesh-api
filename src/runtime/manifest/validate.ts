import type { Manifest, ManifestOverlay } from './types.js';
import { manifestSchema, manifestOverlaySchema } from './schema.js';

/**
 * Validates a parsed or raw manifest object against the Zod schema and runtime semantic rules.
 *
 * Semantic rules enforced per spec/09:
 * 1. Slot references on panel surfaces must resolve to a valid region or slot declared in `layout.regions`.
 * 2. Remote apps must each possess a non-empty pinned `version` and Subresource Integrity (`integrity`) hash.
 * 3. Remote app lists must be explicit allowlists without wildcards.
 * 4. App IDs must be unique across all local and remote declarations.
 */
export function validateManifest(data: unknown): Manifest {
    const result = manifestSchema.safeParse(data);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => {
                const pathStr = issue.path.join('.');
                return pathStr ? `${pathStr}: ${issue.message}` : issue.message;
            })
            .join('; ');
        throw new Error(`Manifest validation failed: ${issues}`);
    }

    const manifest = result.data;
    validateManifestSemantics(manifest);
    return manifest;
}

/**
 * Validates an environment overlay object.
 */
export function validateManifestOverlay(data: unknown): ManifestOverlay {
    const result = manifestOverlaySchema.safeParse(data);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => {
                const pathStr = issue.path.join('.');
                return pathStr ? `${pathStr}: ${issue.message}` : issue.message;
            })
            .join('; ');
        throw new Error(`Manifest overlay validation failed: ${issues}`);
    }
    return result.data;
}

/**
 * Enforces runtime semantic rules that go beyond pure structural schema validation.
 */
function validateManifestSemantics(manifest: Manifest): void {
    // 1. Build table of valid regions and slot targets
    const validRegions = new Set<string>(Object.keys(manifest.layout.regions));
    const validFullSlots = new Set<string>();
    const validShortSlots = new Set<string>();

    for (const [regionName, regionConfig] of Object.entries(manifest.layout.regions)) {
        if (regionConfig.slots) {
            for (const slotName of regionConfig.slots) {
                validFullSlots.add(`${regionName}.${slotName}`);
                validShortSlots.add(slotName);
            }
        }
    }

    const availableSlotsList = Array.from(validFullSlots).concat(Array.from(validRegions));

    // 2. Validate App IDs for uniqueness and slot references
    const seenAppIds = new Set<string>();

    // Validate local apps
    if (manifest.apps) {
        for (const app of manifest.apps) {
            if (seenAppIds.has(app.id)) {
                throw new Error(`Duplicate app id "${app.id}" declared in manifest`);
            }
            seenAppIds.add(app.id);

            if (app.surfaces) {
                for (const surface of app.surfaces) {
                    if (surface.role === 'panel' && surface.slot !== undefined) {
                        validateSlotReference(app.id, surface.slot, validRegions, validFullSlots, validShortSlots, availableSlotsList);
                    }
                }
            }
        }
    }

    // Validate remotes
    if (manifest.remotes) {
        const seenNamespaces = new Set<string>();

        for (const remote of manifest.remotes) {
            if (seenNamespaces.has(remote.namespace)) {
                throw new Error(`Duplicate remote namespace "${remote.namespace}" declared in manifest`);
            }
            seenNamespaces.add(remote.namespace);

            if (!remote.mount.startsWith('/')) {
                throw new Error(
                    `Remote namespace "${remote.namespace}" mount path must start with "/" (got "${remote.mount}")`
                );
            }

            if (!remote.apps || remote.apps.length === 0) {
                throw new Error(
                    `Remote namespace "${remote.namespace}" must declare an explicit non-empty allowlist of apps`
                );
            }

            for (const app of remote.apps) {
                if (seenAppIds.has(app.id)) {
                    throw new Error(
                        `Duplicate app id "${app.id}" declared in remote namespace "${remote.namespace}" (already registered)`
                    );
                }
                seenAppIds.add(app.id);

                // SRI hash check: mandatory trust boundary
                if (!app.integrity || typeof app.integrity !== 'string' || app.integrity.trim() === '') {
                    throw new Error(
                        `Remote app "${app.id}" in namespace "${remote.namespace}" is missing a required Subresource Integrity (SRI) hash. Federation requires pinned SRI.`
                    );
                }

                // Version check: mandatory pinned version
                if (!app.version || typeof app.version !== 'string' || app.version.trim() === '') {
                    throw new Error(
                        `Remote app "${app.id}" in namespace "${remote.namespace}" is missing a pinned version.`
                    );
                }

                if (app.surfaces) {
                    for (const surface of app.surfaces) {
                        if (surface.role === 'panel' && surface.slot !== undefined) {
                            validateSlotReference(
                                app.id,
                                surface.slot,
                                validRegions,
                                validFullSlots,
                                validShortSlots,
                                availableSlotsList
                            );
                        }
                    }
                }
            }
        }
    }
}

/**
 * Checks whether a given slot reference is known to the layout policy.
 */
function validateSlotReference(
    appId: string,
    slot: string,
    validRegions: Set<string>,
    validFullSlots: Set<string>,
    validShortSlots: Set<string>,
    availableSlotsList: string[]
): void {
    if (slot.includes('.')) {
        if (!validFullSlots.has(slot)) {
            throw new Error(
                `App "${appId}" references slot "${slot}" which does not exist in layout regions (${availableSlotsList.join(
                    ', '
                )})`
            );
        }
    } else {
        if (!validRegions.has(slot) && !validShortSlots.has(slot)) {
            throw new Error(
                `App "${appId}" references slot "${slot}" which does not exist in layout regions (${availableSlotsList.join(
                    ', '
                )})`
            );
        }
    }
}
