import type {
    AppDefinition,
    AppLifecycleState,
} from './types.js';
import { createScope } from '../reactivity/scope.js';
import type { ReactiveScope } from '../reactivity/types.js';
import { AppStateContainerImpl } from './state.js';
import { AppContextImpl } from './context.js';
import type { Compositor } from './compositor.js';
import { assertNoAppLeaks } from './leak.js';
import type { ScopedRouter } from '../router/types.js';
import { mountViews } from '../router/view.js';

/**
 * AppInstance: manages the runtime lifecycle, scope, and surfaces of a single App.
 *
 * Implements the state machine:
 * registered -> loaded -> foreground <-> background -> unloaded
 */
export class AppInstance<TApi = unknown> {
    readonly definition: AppDefinition<TApi>;
    readonly scope: ReactiveScope;
    readonly state: AppStateContainerImpl;
    readonly ctx: AppContextImpl<TApi>;
    private readonly compositor: Compositor;
    private readonly activeSurfaces: Array<{ dismiss(): void }> = [];

    constructor(
        definition: AppDefinition<TApi>,
        compositor: Compositor,
        storage?: Storage,
        router?: ScopedRouter,
        api?: TApi
    ) {
        this.definition = definition;
        this.compositor = compositor;
        this.scope = createScope();
        this.state = new AppStateContainerImpl(definition.id, this.scope, storage);
        this.ctx = new AppContextImpl<TApi>(definition.id, this.state, compositor, router, api);
    }

    get id(): string {
        return this.definition.id;
    }

    get status(): AppLifecycleState {
        return this.ctx.status;
    }

    async load(): Promise<void> {
        if (this.status !== 'registered') return;
        try {
            this.ctx.setStatus('loaded');
            if (this.definition.onLoad) {
                await this.scope.run(() => this.definition.onLoad!(this.ctx));
            }

            // Evaluate static background surfaces declared on the App definition
            if (this.definition.surfaces) {
                for (const surfaceDef of this.definition.surfaces) {
                    if (surfaceDef.role === 'background' || surfaceDef.slot !== undefined) {
                        const res = await this.compositor.requestSurface(
                            this.id,
                            {
                                role: surfaceDef.role,
                                slot: surfaceDef.slot,
                                mount: surfaceDef.mount
                                    ? (el) => surfaceDef.mount!(el, this.ctx)
                                    : undefined,
                            },
                            this.ctx
                        );
                        if (res.granted) {
                            this.activeSurfaces.push(res);
                        }
                    }
                }
            }
        } catch (err) {
            this.ctx.setStatus('failed');
            this.compositor.teardownAppSurfaces(this.id);
            throw err;
        }
    }

    async activate(): Promise<void> {
        if (this.status === 'registered') {
            await this.load();
        }
        if (this.status === 'foreground') return;

        try {
            if (this.status === 'background') {
                // Restore detached surfaces without rebuilding their subtrees
                this.compositor.restoreAppSurfaces(this.id);
            } else if (this.status === 'loaded') {
                // Mount declared static visual surfaces
                if (this.definition.surfaces) {
                    for (const surfaceDef of this.definition.surfaces) {
                        if (surfaceDef.role !== 'background' && surfaceDef.slot === undefined) {
                            const res = await this.compositor.requestSurface(
                                this.id,
                                {
                                    role: surfaceDef.role,
                                    slot: surfaceDef.slot,
                                    mount: (container) => {
                                        if (surfaceDef.mount) {
                                            return surfaceDef.mount(container, this.ctx);
                                        }
                                        if (surfaceDef.views && this.ctx.router) {
                                            const cleanup = mountViews(
                                                container,
                                                surfaceDef.views,
                                                this.ctx.router,
                                                this.ctx
                                            );
                                            this.ctx.registerCleanup(cleanup);
                                            return cleanup;
                                        }
                                    },
                                },
                                this.ctx
                            );
                            if (res.granted) {
                                this.activeSurfaces.push(res);
                            }
                        }
                    }
                }
            }

            this.ctx.setStatus('foreground');
            if (this.definition.onActivate) {
                await this.scope.run(() => this.definition.onActivate!(this.ctx));
            }
        } catch (err) {
            this.ctx.setStatus('failed');
            this.compositor.teardownAppSurfaces(this.id);
            throw err;
        }
    }

    async deactivate(): Promise<void> {
        if (this.status !== 'foreground') return;

        try {
            this.ctx.setStatus('background');
            // Detach visible DOM nodes from layout regions while preserving element state
            this.compositor.detachAppSurfaces(this.id);

            if (this.definition.onDeactivate) {
                await this.scope.run(() => this.definition.onDeactivate!(this.ctx));
            }
        } catch (err) {
            this.ctx.setStatus('failed');
            throw err;
        }
    }

    async unload(options?: { assertNoLeaks?: boolean }): Promise<void> {
        if (this.status === 'unloaded') return;

        try {
            if (this.definition.onUnload) {
                await this.scope.run(() => this.definition.onUnload!(this.ctx));
            }
        } finally {
            // Teardown and unmount all surfaces from the compositor
            this.compositor.teardownAppSurfaces(this.id);
            this.activeSurfaces.length = 0;

            // Execute all cleanup handlers registered on the AppContext
            this.ctx.runCleanups();

            // Dispose reactive state container and scope
            this.state.dispose();
            this.scope.dispose();

            this.ctx.setStatus('unloaded');

            if (options?.assertNoLeaks) {
                assertNoAppLeaks(this);
            }
        }
    }
}
