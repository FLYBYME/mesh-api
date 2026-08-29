/**
 * Coordinate pair for scroll positions.
 */
export interface ScrollPosition {
    readonly x: number;
    readonly y: number;
}

/**
 * Manages scroll restoration across History API push/replace and back/forward navigation.
 *
 * Per spec/07:
 * - Scroll position is restored on back/forward.
 * - Scroll position is reset to (0, 0) on a new push navigation.
 * - Focus is moved to the primary content heading upon navigation for accessibility.
 */
export class ScrollManager {
    private readonly positions = new Map<string, ScrollPosition>();

    save(key: string, win?: Window): void {
        const targetWin = win ?? (typeof window !== 'undefined' ? window : undefined);
        if (!targetWin) return;

        const x = targetWin.scrollX ?? targetWin.pageXOffset ?? 0;
        const y = targetWin.scrollY ?? targetWin.pageYOffset ?? 0;
        this.positions.set(key, { x, y });
    }

    restore(key: string, win?: Window): void {
        const targetWin = win ?? (typeof window !== 'undefined' ? window : undefined);
        if (!targetWin) return;

        const pos = this.positions.get(key) ?? { x: 0, y: 0 };
        targetWin.scrollTo(pos.x, pos.y);
    }

    reset(win?: Window): void {
        const targetWin = win ?? (typeof window !== 'undefined' ? window : undefined);
        if (!targetWin) return;
        targetWin.scrollTo(0, 0);
    }

    get(key: string): ScrollPosition | undefined {
        return this.positions.get(key);
    }

    clear(): void {
        this.positions.clear();
    }

    /**
     * Focuses the main content heading upon route transition.
     */
    focusMainContent(root?: HTMLElement, doc?: Document): void {
        const targetDoc = doc ?? (typeof document !== 'undefined' ? document : undefined);
        if (!targetDoc) return;

        const searchRoot = root ?? targetDoc;
        const heading = searchRoot.querySelector<HTMLElement>(
            'main h1, [data-mesh-content-heading], [role="heading"], h1, h2'
        );

        if (heading) {
            if (!heading.hasAttribute('tabindex')) {
                heading.setAttribute('tabindex', '-1');
            }
            heading.focus();
        }
    }
}
