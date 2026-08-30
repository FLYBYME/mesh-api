import type { ReactiveScope } from '../reactivity/types.js';
import { effect } from '../reactivity/effect.js';
import { computed } from '../reactivity/computed.js';
import { createScope } from '../reactivity/scope.js';
import { getActiveScopeContext, setActiveScopeContext } from '../reactivity/context.js';
import { disposeElement, attachScope } from '../dom/scope.js';
import type { AppContext } from '../app/types.js';
import type { ScopedRouter, ViewDefinition } from './types.js';
import { matchViewPattern } from './match.js';

/**
 * Mounts a set of view definitions into a page surface container.
 *
 * Implements fine-grained view switching:
 * When navigating between paths matching the same view (e.g. `/card/1` to `/card/2`),
 * the existing DOM subtree and its ReactiveScope are preserved, and only the `params`
 * signal re-evaluates. The view component is only unmounted/remounted when the matching
 * view definition changes.
 */
export function mountViews<TApi = unknown>(
    container: HTMLElement,
    views: readonly ViewDefinition<TApi>[],
    scopedRouter: ScopedRouter,
    ctx?: AppContext<TApi>
): () => void {
    let activeViewPath: string | null = null;
    let activeScope: ReactiveScope | null = null;
    const outerScopeContext = getActiveScopeContext();

    const viewParams = computed(() => {
        const cp = scopedRouter.currentPath();
        const routerParams = scopedRouter.params();
        for (const viewDef of views) {
            const res = matchViewPattern(viewDef.path, cp);
            if (res !== null && res.matched) {
                return { ...routerParams, ...res.params };
            }
        }
        return routerParams;
    });

    const disposeEffect = effect(() => {
        const currentPath = scopedRouter.currentPath();

        // 1. Find matching view definition
        let matchedView: ViewDefinition<TApi> | undefined = undefined;
        for (const viewDef of views) {
            const res = matchViewPattern(viewDef.path, currentPath);
            if (res !== null && res.matched) {
                matchedView = viewDef;
                break;
            }
        }

        // 2. If same view is already active, do nothing: params signal update drives reactive DOM
        if (matchedView !== undefined && matchedView.path === activeViewPath) {
            return;
        }

        // 3. View changed: teardown previous view subtree and its isolated scope
        activeViewPath = matchedView !== undefined ? matchedView.path : null;
        if (activeScope !== null) {
            activeScope.dispose();
            activeScope = null;
        }
        disposeElement(container);
        container.replaceChildren();

        if (matchedView === undefined) {
            return;
        }

        // 4. Mount new view within an isolated ReactiveScope attached to outer context
        const prevScope = setActiveScopeContext(outerScopeContext);
        const viewScope = createScope();
        setActiveScopeContext(prevScope);

        activeScope = viewScope;

        const rendered = viewScope.run(() =>
            matchedView!.view(
                {
                    params: viewParams,
                    query: scopedRouter.query,
                    router: scopedRouter,
                    ctx,
                },
                ctx
            )
        );

        if (rendered instanceof Node) {
            attachScope(rendered, viewScope);
            container.appendChild(rendered);
        } else if (typeof rendered === 'string' || typeof rendered === 'number') {
            const textNode = document.createTextNode(String(rendered));
            attachScope(textNode, viewScope);
            container.appendChild(textNode);
        }
    });

    return () => {
        disposeEffect();
        if (activeScope !== null) {
            activeScope.dispose();
            activeScope = null;
        }
        disposeElement(container);
        container.replaceChildren();
        activeViewPath = null;
    };
}
