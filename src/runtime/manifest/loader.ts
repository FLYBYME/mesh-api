import YAML from 'yaml';
import type { SessionUser } from '../../auth/types.js';
// `roles.js`, not `gate.js`: this is browser code, and gate.ts imports the whole server half.
import { ADMIN_ROLE } from '../../auth/roles.js';
import type { AppHost, LayoutPolicy } from '../app/types.js';
import type { Manifest, ManifestAuthLevel } from './types.js';
import { validateManifest, validateManifestOverlay } from './validate.js';
import { mergeManifests } from './merge.js';
import { manifestToLayoutPolicy } from './layout.js';

/**
 * Options for parsing a YAML manifest.
 */
export interface ParseManifestOptions {
    readonly overlay?: string;
    readonly root?: HTMLElement;
}

/**
 * Result of parsing and validating a manifest.
 */
export interface ParsedManifestResult {
    readonly manifest: Manifest;
    readonly policy: LayoutPolicy;
}

/**
 * Parses, validates, and resolves a YAML manifest string (and optional overlay),
 * producing the typed Manifest and the corresponding runtime LayoutPolicy.
 */
export function parseManifest(
    yamlContent: string,
    options?: ParseManifestOptions
): ParsedManifestResult {
    const rawBase: unknown = YAML.parse(yamlContent);
    let manifest = validateManifest(rawBase);

    if (options?.overlay) {
        const rawOverlay: unknown = YAML.parse(options.overlay);
        const overlay = validateManifestOverlay(rawOverlay);
        manifest = mergeManifests(manifest, overlay);
    }

    const policy = manifestToLayoutPolicy(manifest, options?.root);

    return { manifest, policy };
}

/**
 * Evaluates whether an app's declared auth level is satisfied by the active user session.
 *
 * Implements the security principle from spec/02 and spec/09:
 * An app requiring auth is NOT loaded at all for an unauthorized visitor.
 */
export function isAppAuthAllowed(
    auth: ManifestAuthLevel | undefined,
    sessionUser?: SessionUser | null
): boolean {
    if (!auth || auth === 'public') {
        return true;
    }

    if (!sessionUser) {
        return false;
    }

    if (auth === 'user') {
        return true;
    }

    if (auth === 'admin') {
        const roles = sessionUser.roles ?? [];
        return roles.includes(ADMIN_ROLE);
    }

    return false;
}

/**
 * Loads all apps configured with `load: 'eager'`, strictly respecting auth gating.
 *
 * Anonymous visitors will not have auth-gated eager apps fetched or loaded.
 */
export async function loadEagerApps(
    manifest: Manifest,
    host: AppHost,
    sessionUser?: SessionUser | null
): Promise<string[]> {
    const loaded: string[] = [];

    // 1. Eager local apps
    if (manifest.apps) {
        for (const app of manifest.apps) {
            if (app.load === 'eager') {
                if (isAppAuthAllowed(app.auth, sessionUser)) {
                    await host.loadApp(app.id);
                    loaded.push(app.id);
                }
            }
        }
    }

    // 2. Eager remote apps
    if (manifest.remotes) {
        for (const remote of manifest.remotes) {
            for (const app of remote.apps) {
                if (app.load === 'eager') {
                    if (isAppAuthAllowed(app.auth, sessionUser)) {
                        await host.loadApp(app.id);
                        loaded.push(app.id);
                    }
                }
            }
        }
    }

    return loaded;
}
