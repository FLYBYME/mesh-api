import type {
    AppHost,
    AppHostOptions,
    AppLifecycleState,
    LayoutPolicy,
} from './types.js';
import { getRegisteredApp } from './registry.js';
import { Compositor } from './compositor.js';
import { AppInstance } from './instance.js';
import type { ScopedRouter } from '../router/types.js';
import type { TopLevelNavigationHost } from '../router/scoped.js';

/**
 * AppHostImpl: coordinates App lifecycles, surface placement via the Compositor,
 * and task switching between top-level apps.
 */
export class AppHostImpl implements AppHost {
    private readonly policy: LayoutPolicy;
    private readonly root: HTMLElement;
    private readonly devMode: boolean;
    private readonly storage?: Storage;
    private readonly compositor: Compositor;
    private readonly instances = new Map<string, AppInstance<unknown>>();
    private foregroundAppId: string | null = null;
    private loadedOrder: string[] = [];
    private keydownHandler?: (e: KeyboardEvent) => void;
    private routerOption?: TopLevelNavigationHost | ((appId: string) => ScopedRouter | undefined);
    private apiOption?: unknown;

    constructor(options: AppHostOptions) {
        this.policy = options.policy;
        this.root = options.root;
        this.devMode = options.devMode ?? false;
        this.storage = options.storage;
        this.routerOption = options.router;
        this.apiOption = options.api;
        this.compositor = new Compositor({
            root: options.root,
            policy: options.policy,
        });

        this.setupTaskSwitcher();
    }

    setRouter(router: TopLevelNavigationHost | ((appId: string) => ScopedRouter | undefined)): void {
        this.routerOption = router;
    }

    setApi(api: unknown): void {
        this.apiOption = api;
    }

    private resolveRouterForApp(appId: string): ScopedRouter | undefined {
        const r = this.routerOption;
        if (!r) return undefined;
        if (typeof r === 'function') {
            return r(appId);
        }
        if (typeof r === 'object' && 'getAppRouter' in r && typeof r.getAppRouter === 'function') {
            return r.getAppRouter(appId);
        }
        return undefined;
    }

    private isApiFactory(val: unknown): val is (appId: string) => unknown {
        return typeof val === 'function';
    }

    private resolveApiForApp(appId: string): unknown {
        const a = this.apiOption;
        if (this.isApiFactory(a)) {
            return a(appId);
        }
        return a;
    }

    private setupTaskSwitcher(): void {
        const switcher = this.policy.taskSwitcher;
        if (switcher?.enabled && switcher.hotkey) {
            const targetKey = switcher.hotkey.toLowerCase();
            this.keydownHandler = (event: KeyboardEvent) => {
                const isCtrl = event.ctrlKey;
                const isBacktick = event.key === '`';
                if (targetKey === 'ctrl+`' && isCtrl && isBacktick) {
                    event.preventDefault();
                    this.cycleToNextApp();
                }
            };
            window.addEventListener('keydown', this.keydownHandler);
        }
    }

    private cycleToNextApp(): void {
        if (this.loadedOrder.length <= 1) return;
        const currentIndex =
            this.foregroundAppId !== null
                ? this.loadedOrder.indexOf(this.foregroundAppId)
                : -1;
        const nextIndex = (currentIndex + 1) % this.loadedOrder.length;
        const nextAppId = this.loadedOrder[nextIndex];
        if (nextAppId !== undefined) {
            void this.activateApp(nextAppId);
        }
    }

    async loadApp(id: string): Promise<void> {
        let instance = this.instances.get(id);
        if (instance !== undefined) {
            if (instance.status !== 'registered') return;
            await instance.load();
            return;
        }

        const definition = getRegisteredApp(id);
        if (definition === undefined) {
            throw new Error(`App "${id}" is not registered`);
        }

        const router = this.resolveRouterForApp(id);
        const api = this.resolveApiForApp(id);

        instance = new AppInstance(definition, this.compositor, this.storage, router, api);
        this.instances.set(id, instance);
        if (!this.loadedOrder.includes(id)) {
            this.loadedOrder.push(id);
        }
        await instance.load();
    }

    async activateApp(id: string): Promise<void> {
        let instance = this.instances.get(id);
        if (instance === undefined) {
            await this.loadApp(id);
            instance = this.instances.get(id);
        }
        if (instance === undefined) {
            throw new Error(`Failed to load app "${id}"`);
        }

        if (this.foregroundAppId !== null && this.foregroundAppId !== id) {
            await this.deactivateApp(this.foregroundAppId);
        }

        await instance.activate();
        this.foregroundAppId = id;
    }

    async deactivateApp(id: string): Promise<void> {
        const instance = this.instances.get(id);
        if (instance === undefined) return;
        if (instance.status === 'foreground') {
            await instance.deactivate();
            if (this.foregroundAppId === id) {
                this.foregroundAppId = null;
            }
        }
    }

    async switchTo(id: string): Promise<void> {
        await this.activateApp(id);
    }

    async unloadApp(id: string, options?: { assertNoLeaks?: boolean }): Promise<void> {
        const instance = this.instances.get(id);
        if (instance === undefined) return;

        if (this.foregroundAppId === id) {
            this.foregroundAppId = null;
        }

        const shouldAssertLeaks = options?.assertNoLeaks ?? this.devMode;
        await instance.unload({ assertNoLeaks: shouldAssertLeaks });

        this.instances.delete(id);
        const idx = this.loadedOrder.indexOf(id);
        if (idx !== -1) {
            this.loadedOrder.splice(idx, 1);
        }
    }

    getAppState(id: string): AppLifecycleState | undefined {
        const instance = this.instances.get(id);
        return instance?.status;
    }

    getForegroundAppId(): string | null {
        return this.foregroundAppId;
    }

    getLoadedAppIds(): readonly string[] {
        return [...this.loadedOrder];
    }

    dispose(): void {
        if (this.keydownHandler !== undefined) {
            window.removeEventListener('keydown', this.keydownHandler);
        }
        for (const id of Array.from(this.instances.keys())) {
            void this.unloadApp(id);
        }
        this.compositor.dispose();
    }
}

/**
 * Creates an AppHost managing screen layout and App lifecycles.
 */
export function createAppHost(options: AppHostOptions): AppHost {
    return new AppHostImpl(options);
}
