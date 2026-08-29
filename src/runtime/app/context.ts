import type {
    AppContext,
    AppLifecycleState,
    SurfaceRequest,
    SurfaceResult,
    LeakableResource,
} from './types.js';
import type { AppStateContainerImpl } from './state.js';
import type { Compositor } from './compositor.js';

/**
 * AppContextImpl: context instance provided to an App during its lifecycle.
 *
 * Implements the Wayland architectural constraint: an App can request surfaces from the
 * compositor, manage its own scoped state, and register cleanups, but possesses no API
 * allowing it to position itself or inspect foreign app state.
 */
export class AppContextImpl implements AppContext {
    readonly appId: string;
    readonly state: AppStateContainerImpl;
    private _status: AppLifecycleState = 'registered';
    private readonly compositor: Compositor;
    private readonly cleanups: Array<() => void> = [];
    private readonly leakTrackers: Array<LeakableResource | (() => void)> = [];

    constructor(appId: string, state: AppStateContainerImpl, compositor: Compositor) {
        this.appId = appId;
        this.state = state;
        this.compositor = compositor;
    }

    get status(): AppLifecycleState {
        return this._status;
    }

    setStatus(status: AppLifecycleState): void {
        this._status = status;
    }

    async requestSurface(request: SurfaceRequest): Promise<SurfaceResult> {
        if (this._status === 'unloaded' || this._status === 'failed') {
            return { granted: false, reason: 'cancelled' };
        }
        return this.compositor.requestSurface(this.appId, request, this);
    }

    registerCleanup(cleanup: () => void): void {
        this.cleanups.push(cleanup);
    }

    trackLeakable(resource: LeakableResource | (() => void)): void {
        this.leakTrackers.push(resource);
    }

    runCleanups(): void {
        const items = [...this.cleanups];
        this.cleanups.length = 0;
        for (const cleanup of items) {
            try {
                cleanup();
            } catch {
                // Ensure remaining cleanups execute even if one throws
            }
        }
    }

    getTrackedLeakables(): ReadonlyArray<LeakableResource | (() => void)> {
        return this.leakTrackers;
    }
}
