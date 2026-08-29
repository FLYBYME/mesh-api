/**
 * Determines whether a mouse click on an anchor element should be intercepted
 * by the client-side router versus allowed to fall through to native browser navigation.
 *
 * Rules per spec/07:
 * - Only left-clicks (button === 0) without modifier keys (cmd/ctrl/shift/alt) are intercepted.
 * - Middle-click (button === 1), right-click (button === 2) fall through.
 * - Modified clicks (cmd-click, ctrl-click) fall through to support "open in new tab".
 * - `target="_blank"`, `target="_parent"`, `target="_top"` fall through.
 * - `download` attributes and external origins fall through.
 * - `data-external` or `rel="external"` attributes fall through.
 */
export function shouldInterceptLinkClick(
    event: MouseEvent,
    anchor: HTMLAnchorElement,
    currentOrigin?: string
): boolean {
    if (event.defaultPrevented) return false;
    if (event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;

    // Check target attribute
    const target = anchor.getAttribute('target');
    if (target && target.toLowerCase() !== '_self') {
        return false;
    }

    // Check download attribute
    if (anchor.hasAttribute('download')) {
        return false;
    }

    // Check external opt-out attributes
    if (anchor.hasAttribute('data-external') || anchor.rel?.includes('external')) {
        return false;
    }

    const href = anchor.getAttribute('href');
    if (!href || href === '' || href.startsWith('#') || href.startsWith('javascript:')) {
        return false;
    }

    // Origin verification
    try {
        const base = currentOrigin ?? (typeof window !== 'undefined' ? window.location.href : 'http://localhost');
        const resolvedUrl = new URL(href, base);
        const originToMatch = currentOrigin ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost');

        if (resolvedUrl.origin !== originToMatch) {
            return false;
        }

        if (resolvedUrl.protocol !== 'http:' && resolvedUrl.protocol !== 'https:') {
            return false;
        }
    } catch {
        return false;
    }

    return true;
}

/**
 * Attaches a global click event listener that delegates link clicks to the router.
 */
export function attachLinkInterceptor(
    target: HTMLElement | Document | Window,
    onNavigate: (href: string) => void | Promise<void>
): () => void {
    const handler = (event: Event) => {
        if (!(event instanceof MouseEvent)) return;

        const eventTarget = event.target;
        if (!(eventTarget instanceof Node)) return;

        let anchor: HTMLAnchorElement | null = null;
        if (eventTarget instanceof Element) {
            anchor = eventTarget.closest<HTMLAnchorElement>('a[href]');
        }

        if (anchor === null) return;

        const origin = typeof window !== 'undefined' && window.location ? window.location.origin : undefined;

        if (shouldInterceptLinkClick(event, anchor, origin)) {
            event.preventDefault();
            const href = anchor.getAttribute('href');
            if (href !== null) {
                void onNavigate(href);
            }
        }
    };

    target.addEventListener('click', handler as EventListener, false);

    return () => {
        target.removeEventListener('click', handler as EventListener, false);
    };
}
