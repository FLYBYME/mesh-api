import type {
    LayoutPolicy,
    LayoutRegionPolicy,
    SurfaceRequest,
    SurfaceResult,
    SurfaceRole,
    AppContext,
} from './types.js';
import { disposeElement } from '../dom/scope.js';

interface SurfaceRecord {
    readonly id: string;
    readonly appId: string;
    readonly role: SurfaceRole;
    readonly slot?: string;
    readonly container: HTMLElement;
    readonly parentElement: HTMLElement;
    readonly nextSibling: Node | null;
    readonly dismiss: () => void;
    isAttached: boolean;
}

interface QueuedBanner {
    readonly appId: string;
    readonly request: SurfaceRequest;
    readonly ctx?: AppContext;
    readonly resolve: (result: SurfaceResult) => void;
    cancelled: boolean;
}

interface ActiveOverlay {
    readonly appId: string;
    readonly backdrop: HTMLElement;
    readonly container: HTMLElement;
    readonly opener: HTMLElement | null;
    readonly cleanup: () => void;
}

interface ActivePopup {
    readonly appId: string;
    readonly container: HTMLElement;
    readonly anchor?: HTMLElement;
    readonly cleanup: () => void;
}

/**
 * Helper to retrieve all focusable elements within a given container.
 */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
    const selector =
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const nodeList = container.querySelectorAll(selector);
    const result: HTMLElement[] = [];
    for (let i = 0; i < nodeList.length; i++) {
        const item = nodeList.item(i);
        if (item instanceof HTMLElement) {
            result.push(item);
        }
    }
    return result;
}

/**
 * Compositor: owns all screen placement and spatial layout policy.
 *
 * Implements the Wayland client/compositor split: Apps request surfaces by role,
 * and the Compositor resolves each request against the active layout policy,
 * refusing requests when the target region or role is absent.
 */
export class Compositor {
    private readonly policy: LayoutPolicy;
    private readonly root: HTMLElement;
    private readonly regionElements = new Map<string, HTMLElement>();
    private readonly slotElements = new Map<string, HTMLElement>();
    private readonly surfaceRecords = new Map<string, SurfaceRecord>();

    private bannerHost: HTMLElement;
    private overlayHost: HTMLElement;
    private popupHost: HTMLElement;

    private bannerQueue: QueuedBanner[] = [];
    private activeBannerRecord: SurfaceRecord | null = null;
    private activeOverlay: ActiveOverlay | null = null;
    private activePopup: ActivePopup | null = null;

    private surfaceIdCounter = 0;

    constructor(options: { root: HTMLElement; policy: LayoutPolicy }) {
        this.policy = options.policy;
        this.root = options.root;

        this.bannerHost = this.getOrCreateHost('mesh-banners', 'data-mesh-banners');
        this.overlayHost = this.getOrCreateHost('mesh-overlays', 'data-mesh-overlays');
        this.popupHost = this.getOrCreateHost('mesh-popups', 'data-mesh-popups');

        this.initRegions();
    }

    private getOrCreateHost(className: string, attr: string): HTMLElement {
        let host = this.root.querySelector<HTMLElement>(`[${attr}]`);
        if (host === null) {
            host = document.createElement('div');
            host.className = className;
            host.setAttribute(attr, 'true');
            this.root.appendChild(host);
        }
        return host;
    }

    private initRegions(): void {
        for (const [regionName, regionPolicy] of Object.entries(this.policy.regions)) {
            let regionEl = regionPolicy.container;
            if (regionEl === undefined) {
                const query = `[data-region="${regionName}"]`;
                const found = this.root.querySelector(query);
                if (found instanceof HTMLElement) {
                    regionEl = found;
                } else {
                    regionEl = document.createElement('div');
                    regionEl.setAttribute('data-region', regionName);
                    regionEl.className = `mesh-region mesh-region-${regionName}`;
                    this.root.appendChild(regionEl);
                }
            }
            this.regionElements.set(regionName, regionEl);

            const slots = regionPolicy.slots ?? [];
            for (const slotName of slots) {
                const fullSlotKey = `${regionName}.${slotName}`;
                let slotEl: HTMLElement | null = null;
                const foundSlot = regionEl.querySelector(`[data-slot="${fullSlotKey}"], [data-slot="${slotName}"]`);
                if (foundSlot instanceof HTMLElement) {
                    slotEl = foundSlot;
                } else {
                    slotEl = document.createElement('div');
                    slotEl.setAttribute('data-slot', fullSlotKey);
                    slotEl.className = `mesh-slot mesh-slot-${slotName}`;
                    regionEl.appendChild(slotEl);
                }
                this.slotElements.set(fullSlotKey, slotEl);
                this.slotElements.set(slotName, slotEl);
            }
        }
    }

    async requestSurface(
        appId: string,
        request: SurfaceRequest,
        ctx?: AppContext
    ): Promise<SurfaceResult> {
        switch (request.role) {
            case 'page':
                return this.placePageSurface(appId, request, ctx);
            case 'panel':
                return this.placePanelSurface(appId, request, ctx);
            case 'banner':
                return this.placeBannerSurface(appId, request, ctx);
            case 'popup':
                return this.placePopupSurface(appId, request, ctx);
            case 'overlay':
                return this.placeOverlaySurface(appId, request, ctx);
            case 'background':
                return this.placeBackgroundSurface(appId, request, ctx);
            default:
                return { granted: false, reason: 'role_disabled' };
        }
    }

    private async placePageSurface(
        appId: string,
        request: SurfaceRequest,
        ctx?: AppContext
    ): Promise<SurfaceResult> {
        // Look for region named 'content' or a region configured to accept 'page' role
        let contentRegionEl: HTMLElement | undefined = this.regionElements.get('content');
        if (contentRegionEl === undefined) {
            for (const [regionName, regionPolicy] of Object.entries(this.policy.regions)) {
                if (regionPolicy.roles?.includes('page')) {
                    contentRegionEl = this.regionElements.get(regionName);
                    break;
                }
            }
        }

        if (contentRegionEl === undefined) {
            return { granted: false, reason: 'no_matching_region' };
        }

        const container = document.createElement('div');
        container.className = 'mesh-surface mesh-surface-page';
        container.setAttribute('data-app-id', appId);
        contentRegionEl.appendChild(container);

        const surfaceId = `surface-${++this.surfaceIdCounter}`;
        const record: SurfaceRecord = {
            id: surfaceId,
            appId,
            role: 'page',
            slot: request.slot,
            container,
            parentElement: contentRegionEl,
            nextSibling: container.nextSibling,
            dismiss: () => this.removeSurface(surfaceId),
            isAttached: true,
        };
        this.surfaceRecords.set(surfaceId, record);

        if (request.mount) {
            await request.mount(container);
        }

        return {
            granted: true,
            container,
            dismiss: record.dismiss,
        };
    }

    private async placePanelSurface(
        appId: string,
        request: SurfaceRequest,
        ctx?: AppContext
    ): Promise<SurfaceResult> {
        let targetEl: HTMLElement | undefined = undefined;

        if (request.slot !== undefined) {
            targetEl = this.slotElements.get(request.slot);
            if (targetEl === undefined) {
                // If not found in slots, check if slot maps to a named region that accepts panels
                const regionEl = this.regionElements.get(request.slot);
                const regionPolicy = this.policy.regions[request.slot];
                if (regionEl !== undefined && (regionPolicy?.roles === undefined || regionPolicy.roles.includes('panel'))) {
                    targetEl = regionEl;
                }
            }

            if (targetEl === undefined) {
                return { granted: false, reason: 'slot_not_found' };
            }
        } else {
            // No slot specified: look for first region accepting panels
            for (const [regionName, regionPolicy] of Object.entries(this.policy.regions)) {
                if (regionPolicy.roles?.includes('panel')) {
                    targetEl = this.regionElements.get(regionName);
                    break;
                }
            }
            if (targetEl === undefined) {
                return { granted: false, reason: 'no_matching_region' };
            }
        }

        const container = document.createElement('div');
        container.className = 'mesh-surface mesh-surface-panel';
        container.setAttribute('data-app-id', appId);
        if (request.slot !== undefined) {
            container.setAttribute('data-slot', request.slot);
        }
        targetEl.appendChild(container);

        const surfaceId = `surface-${++this.surfaceIdCounter}`;
        const record: SurfaceRecord = {
            id: surfaceId,
            appId,
            role: 'panel',
            slot: request.slot,
            container,
            parentElement: targetEl,
            nextSibling: container.nextSibling,
            dismiss: () => this.removeSurface(surfaceId),
            isAttached: true,
        };
        this.surfaceRecords.set(surfaceId, record);

        if (request.mount) {
            await request.mount(container);
        }

        return {
            granted: true,
            container,
            dismiss: record.dismiss,
        };
    }

    private async placeBannerSurface(
        appId: string,
        request: SurfaceRequest,
        ctx?: AppContext
    ): Promise<SurfaceResult> {
        if (this.policy.banners === false || this.policy.banners === 'disabled') {
            return { granted: false, reason: 'role_disabled' };
        }

        // Banners are queued: only one banner is displayed at a time, oldest first.
        if (this.activeBannerRecord === null) {
            return this.mountBannerImmediately(appId, request, ctx);
        }

        return new Promise<SurfaceResult>((resolve) => {
            const queued: QueuedBanner = {
                appId,
                request,
                ctx,
                resolve,
                cancelled: false,
            };
            this.bannerQueue.push(queued);
        });
    }

    private async mountBannerImmediately(
        appId: string,
        request: SurfaceRequest,
        ctx?: AppContext
    ): Promise<SurfaceResult> {
        const container = document.createElement('div');
        container.className = 'mesh-surface mesh-surface-banner';
        container.setAttribute('data-app-id', appId);
        this.bannerHost.appendChild(container);

        const surfaceId = `surface-${++this.surfaceIdCounter}`;
        const dismiss = () => {
            this.removeSurface(surfaceId);
            if (this.activeBannerRecord?.id === surfaceId) {
                this.activeBannerRecord = null;
                this.processNextQueuedBanner();
            }
        };

        const record: SurfaceRecord = {
            id: surfaceId,
            appId,
            role: 'banner',
            slot: request.slot,
            container,
            parentElement: this.bannerHost,
            nextSibling: null,
            dismiss,
            isAttached: true,
        };
        this.surfaceRecords.set(surfaceId, record);
        this.activeBannerRecord = record;

        if (request.mount) {
            await request.mount(container);
        }

        return {
            granted: true,
            container,
            dismiss,
        };
    }

    private processNextQueuedBanner(): void {
        while (this.bannerQueue.length > 0) {
            const next = this.bannerQueue.shift();
            if (next === undefined || next.cancelled) {
                continue;
            }
            void this.mountBannerImmediately(next.appId, next.request, next.ctx).then((result) => {
                next.resolve(result);
            });
            break;
        }
    }

    private async placePopupSurface(
        appId: string,
        request: SurfaceRequest,
        ctx?: AppContext
    ): Promise<SurfaceResult> {
        if (this.policy.popups === false || this.policy.popups === 'disabled') {
            return { granted: false, reason: 'role_disabled' };
        }

        // Popups: one at a time. A new one supersedes the current.
        if (this.activePopup !== null) {
            this.activePopup.cleanup();
            this.activePopup = null;
        }

        const container = document.createElement('div');
        container.className = 'mesh-surface mesh-surface-popup';
        container.setAttribute('data-app-id', appId);
        this.popupHost.appendChild(container);

        const surfaceId = `surface-${++this.surfaceIdCounter}`;

        const dismiss = () => {
            if (this.activePopup?.container === container) {
                this.activePopup.cleanup();
                this.activePopup = null;
            }
            this.removeSurface(surfaceId);
        };

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                dismiss();
            }
        };

        const onPointerDown = (event: Event) => {
            const target = event.target;
            if (target instanceof Node) {
                const insideContainer = container.contains(target);
                const insideAnchor = request.anchor !== undefined && request.anchor.contains(target);
                if (!insideContainer && !insideAnchor) {
                    dismiss();
                }
            }
        };

        window.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('click', onPointerDown, true);

        const cleanup = () => {
            window.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('click', onPointerDown, true);
            if (container.parentNode !== null) {
                container.remove();
            }
        };

        this.activePopup = {
            appId,
            container,
            anchor: request.anchor,
            cleanup,
        };

        const record: SurfaceRecord = {
            id: surfaceId,
            appId,
            role: 'popup',
            slot: request.slot,
            container,
            parentElement: this.popupHost,
            nextSibling: null,
            dismiss,
            isAttached: true,
        };
        this.surfaceRecords.set(surfaceId, record);

        if (request.mount) {
            await request.mount(container);
        }

        return {
            granted: true,
            container,
            dismiss,
        };
    }

    private async placeOverlaySurface(
        appId: string,
        request: SurfaceRequest,
        ctx?: AppContext
    ): Promise<SurfaceResult> {
        if (this.policy.overlays === false || this.policy.overlays === 'disabled') {
            return { granted: false, reason: 'role_disabled' };
        }

        // Overlays: one at a time. A new one supersedes the current.
        if (this.activeOverlay !== null) {
            this.activeOverlay.cleanup();
            this.activeOverlay = null;
        }

        // Record currently focused element to restore focus on close
        const activeNode = document.activeElement;
        const opener = activeNode instanceof HTMLElement ? activeNode : null;

        const backdrop = document.createElement('div');
        backdrop.className = 'mesh-overlay-backdrop';

        const container = document.createElement('div');
        container.className = 'mesh-surface mesh-surface-overlay';
        container.setAttribute('role', 'dialog');
        container.setAttribute('aria-modal', 'true');
        container.setAttribute('tabindex', '-1');
        container.setAttribute('data-app-id', appId);

        backdrop.appendChild(container);
        this.overlayHost.appendChild(backdrop);

        const surfaceId = `surface-${++this.surfaceIdCounter}`;

        const dismiss = () => {
            if (this.activeOverlay?.container === container) {
                this.activeOverlay.cleanup();
                this.activeOverlay = null;
            }
            this.removeSurface(surfaceId);
        };

        // Trap focus and close on Escape
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                dismiss();
                return;
            }

            if (event.key === 'Tab') {
                const focusables = getFocusableElements(container);
                if (focusables.length === 0) {
                    event.preventDefault();
                    container.focus();
                    return;
                }

                const first = focusables[0];
                const last = focusables[focusables.length - 1];

                if (event.shiftKey) {
                    if (document.activeElement === first || document.activeElement === container) {
                        event.preventDefault();
                        last?.focus();
                    }
                } else {
                    if (document.activeElement === last) {
                        event.preventDefault();
                        first?.focus();
                    }
                }
            }
        };

        window.addEventListener('keydown', onKeyDown);

        const cleanup = () => {
            window.removeEventListener('keydown', onKeyDown);
            if (backdrop.parentNode !== null) {
                backdrop.remove();
            }
            // Restore focus to the opener element that initiated the overlay
            if (opener !== null) {
                opener.focus();
            }
        };

        this.activeOverlay = {
            appId,
            backdrop,
            container,
            opener,
            cleanup,
        };

        const record: SurfaceRecord = {
            id: surfaceId,
            appId,
            role: 'overlay',
            slot: request.slot,
            container,
            parentElement: this.overlayHost,
            nextSibling: null,
            dismiss,
            isAttached: true,
        };
        this.surfaceRecords.set(surfaceId, record);

        if (request.mount) {
            await request.mount(container);
        }

        // Set initial focus within the overlay
        const focusableNodes = getFocusableElements(container);
        if (focusableNodes.length > 0) {
            const first = focusableNodes[0];
            first?.focus();
        } else {
            container.focus();
        }

        return {
            granted: true,
            container,
            dismiss,
        };
    }

    private async placeBackgroundSurface(
        appId: string,
        request: SurfaceRequest,
        ctx?: AppContext
    ): Promise<SurfaceResult> {
        // Background surfaces have no visual presence in the DOM
        const dummyContainer = document.createElement('div');
        dummyContainer.setAttribute('data-role', 'background');
        dummyContainer.setAttribute('data-app-id', appId);

        const surfaceId = `surface-${++this.surfaceIdCounter}`;
        const record: SurfaceRecord = {
            id: surfaceId,
            appId,
            role: 'background',
            slot: request.slot,
            container: dummyContainer,
            parentElement: dummyContainer,
            nextSibling: null,
            dismiss: () => this.removeSurface(surfaceId),
            isAttached: false,
        };
        this.surfaceRecords.set(surfaceId, record);

        if (request.mount) {
            await request.mount(dummyContainer);
        }

        return {
            granted: true,
            container: dummyContainer,
            dismiss: record.dismiss,
        };
    }

    private removeSurface(surfaceId: string): void {
        const record = this.surfaceRecords.get(surfaceId);
        if (record === undefined) return;

        if (record.isAttached && record.container.parentNode !== null) {
            record.container.remove();
        }
        disposeElement(record.container);
        this.surfaceRecords.delete(surfaceId);
    }

    /**
     * Detaches visible DOM nodes of the given App when it transitions to background.
     *
     * Crucial: DOM elements are NOT destroyed or disposed; they are merely detached
     * from the layout tree so that live streams, form state, and subtrees stay warm.
     */
    detachAppSurfaces(appId: string): void {
        if (this.activeOverlay?.appId === appId) {
            this.activeOverlay.cleanup();
            this.activeOverlay = null;
        }
        if (this.activePopup?.appId === appId) {
            this.activePopup.cleanup();
            this.activePopup = null;
        }

        for (const record of this.surfaceRecords.values()) {
            if (record.appId === appId && record.role !== 'background' && record.slot === undefined && record.isAttached) {
                if (record.container.parentNode !== null) {
                    record.container.remove();
                }
                record.isAttached = false;
            }
        }
    }

    /**
     * Re-attaches preserved DOM nodes of the given App when it returns to foreground.
     *
     * Restores screen placement without remounting or re-rendering components.
     */
    restoreAppSurfaces(appId: string): void {
        for (const record of this.surfaceRecords.values()) {
            if (record.appId === appId && record.role !== 'background' && record.slot === undefined && !record.isAttached) {
                if (record.parentElement !== null) {
                    if (record.nextSibling !== null && record.parentElement.contains(record.nextSibling)) {
                        record.parentElement.insertBefore(record.container, record.nextSibling);
                    } else {
                        record.parentElement.appendChild(record.container);
                    }
                    record.isAttached = true;
                }
            }
        }
    }

    /**
     * Teardown and dispose all surfaces associated with an unloading App.
     */
    teardownAppSurfaces(appId: string): void {
        if (this.activeOverlay?.appId === appId) {
            this.activeOverlay.cleanup();
            this.activeOverlay = null;
        }
        if (this.activePopup?.appId === appId) {
            this.activePopup.cleanup();
            this.activePopup = null;
        }
        if (this.activeBannerRecord?.appId === appId) {
            this.activeBannerRecord.dismiss();
            this.activeBannerRecord = null;
        }

        // Cancel pending queued banners for this app
        for (const queued of this.bannerQueue) {
            if (queued.appId === appId) {
                queued.cancelled = true;
                queued.resolve({ granted: false, reason: 'cancelled' });
            }
        }
        this.bannerQueue = this.bannerQueue.filter((q) => !q.cancelled);

        const toDelete: string[] = [];
        for (const [id, record] of this.surfaceRecords.entries()) {
            if (record.appId === appId) {
                if (record.container.parentNode !== null) {
                    record.container.remove();
                }
                disposeElement(record.container);
                toDelete.push(id);
            }
        }
        for (const id of toDelete) {
            this.surfaceRecords.delete(id);
        }
    }

    dispose(): void {
        if (this.activeOverlay !== null) {
            this.activeOverlay.cleanup();
            this.activeOverlay = null;
        }
        if (this.activePopup !== null) {
            this.activePopup.cleanup();
            this.activePopup = null;
        }
        for (const record of this.surfaceRecords.values()) {
            if (record.container.parentNode !== null) {
                record.container.remove();
            }
            disposeElement(record.container);
        }
        this.surfaceRecords.clear();
        this.bannerQueue.length = 0;
    }
}
