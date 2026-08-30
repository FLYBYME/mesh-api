import type { AppDefinition } from './types.js';

/**
 * Module-level registry of declared Apps.
 *
 * Apps self-register on import via `defineApp()`, mirroring how `defineContract()`
 * registers contracts into the exposure broker.
 */
const appRegistry = new Map<string, AppDefinition<unknown>>();

/**
 * Registers an App definition into the framework's module-level registry.
 *
 * Enforces unique App ids across the entire runtime. Duplicate registration throws
 * immediately with an informative error naming both the existing and incoming apps.
 */
export function defineApp<TApi = unknown>(definition: AppDefinition<TApi>): AppDefinition<TApi> {
    if (!definition.id || typeof definition.id !== 'string') {
        throw new Error('App definition must have a valid non-empty "id" string');
    }
    const existing = appRegistry.get(definition.id);
    if (existing !== undefined) {
        throw new Error(
            `App with id "${definition.id}" is already registered (existing: "${existing.title}", new: "${definition.title}")`
        );
    }
    appRegistry.set(definition.id, definition);
    return definition;
}

/**
 * Retrieves a registered App definition by its unique id.
 */
export function getRegisteredApp(id: string): AppDefinition | undefined {
    return appRegistry.get(id);
}

/**
 * Returns a readonly list of all currently registered App definitions.
 */
export function getAllRegisteredApps(): readonly AppDefinition[] {
    return Array.from(appRegistry.values());
}

/**
 * Clears the registry. Useful in test fixtures to avoid state bleeding across suites.
 */
export function clearAppRegistry(): void {
    appRegistry.clear();
}
