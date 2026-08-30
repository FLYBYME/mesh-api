import type { AppInstance } from './instance.js';

/**
 * Error thrown in development when an App fails to release resources during unload.
 */
export class AppLeakError extends Error {
    readonly appId: string;
    readonly leakCount: number;

    constructor(appId: string, message: string, leakCount: number) {
        super(`[AppLeakError] App "${appId}" leaked resources after unload: ${message}`);
        this.name = 'AppLeakError';
        this.appId = appId;
        this.leakCount = leakCount;
    }
}

/**
 * Dev-mode assertion checking that an App has released all effects, subscriptions,
 * timers, and DOM elements upon unload.
 */
export function assertNoAppLeaks<TApi>(instance: AppInstance<TApi>): void {
    const appId = instance.id;
    let leaks = 0;
    const details: string[] = [];

    if (!instance.state.isDisposed) {
        leaks++;
        details.push('AppStateContainer was not disposed');
    }

    const activeEffects = instance.state.getActiveEffectCount();
    if (activeEffects > 0) {
        leaks += activeEffects;
        details.push(`${activeEffects} active effect(s) remained undisposed`);
    }

    const tracked = instance.ctx.getTrackedLeakables();
    for (const item of tracked) {
        if (typeof item === 'function') {
            leaks++;
            details.push('un-executed cleanup callback remained');
        } else if (item.isDisposed === false) {
            leaks++;
            details.push('undisposed leakable resource remained');
        }
    }

    if (leaks > 0) {
        throw new AppLeakError(appId, details.join(', '), leaks);
    }
}
