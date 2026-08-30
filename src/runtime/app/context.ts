import type {
    AppContext,
    AppLifecycleState,
    SurfaceRequest,
    SurfaceResult,
    LeakableResource,
} from './types.js';
import type { AppStateContainerImpl } from './state.js';
import type { Compositor } from './compositor.js';
import type { ScopedRouter } from '../router/types.js';

interface CloseableEventsHolder {
    readonly events: {
        close(): void;
        readonly isDisposed?: boolean;
    };
}

function isCloseableEventsHolder(val: unknown): val is CloseableEventsHolder {
    if (typeof val !== 'object' || val === null) return false;
    if (!('events' in val)) return false;
    const events = (val as { readonly events: unknown }).events;
    if (typeof events !== 'object' || events === null) return false;
    if (!('close' in events)) return false;
    const closeFn = (events as { readonly close: unknown }).close;
    return typeof closeFn === 'function';
}

/**
 * AppContextImpl: context instance provided to an App during its lifecycle.
 *
 * Implements the Wayland architectural constraint: an App can request surfaces from the
 * compositor, manage its own scoped state, and register cleanups, but possesses no API
 * allowing it to position itself or inspect foreign app state.
 *
 * Exposes scoped router and typed api client directly on the context, fulfilling the
 * framework contract that an App receives everything it needs via its AppContext.
 */
export class AppContextImpl<TApi = unknown> implements AppContext<TApi> {
    readonly appId: string;
    readonly state: AppStateContainerImpl;
    private _status: AppLifecycleState = 'registered';
    private readonly compositor?: Compositor;
    private readonly cleanups: Array<() => void> = [];
    private readonly leakTrackers: Array<LeakableResource | (() => void)> = [];
    readonly router?: ScopedRouter;
    readonly api?: TApi;

    constructor(
        appId: string,
        state: AppStateContainerImpl,
        compositor?: Compositor,
        router?: ScopedRouter,
        api?: TApi
    ) {
        this.appId = appId;
        this.state = state;
        this.compositor = compositor;
        this.router = router;
        this.api = api;

        if (isCloseableEventsHolder(api)) {
            const events = api.events;
            this.registerCleanup(() => events.close());
            this.trackLeakable({
                get isDisposed() {
                    return events.isDisposed ?? false;
                },
                dispose: () => events.close(),
            });
        }
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
        if (!this.compositor) {
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
