import { ServiceModule } from '@flybyme/mesh';
import type { WebConfig } from './types.js';

/**
 * WebServiceModule: abstract base class for a mesh service that faces the web.
 *
 * Extends mesh's `ServiceModule` with web exposure configuration (`mountWeb`). Lives in
 * `mesh-api` rather than `@flybyme/mesh` core so core stays free of express/MCP dependencies --
 * a headless service pays nothing for what it never serves.
 */
export abstract class WebServiceModule extends ServiceModule {
    private webConfig?: WebConfig;

    /**
     * mountWeb: declares the public HTTP/MCP/event surface for this service.
     *
     * Calling this twice throws: a service has one public surface, and a silent merge would make
     * the exposed set depend on constructor ordering.
     */
    protected mountWeb(config: WebConfig): void {
        if (this.webConfig !== undefined) {
            throw new Error(`[WebServiceModule] mountWeb() called more than once in domain '${this.domain}'. A service has one public surface.`);
        }
        this.webConfig = config;
    }

    public getWebConfig(): WebConfig | undefined {
        return this.webConfig;
    }
}
