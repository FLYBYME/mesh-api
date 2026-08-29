// Exposure & Module Extension
export type { AuthLevel, ExposeEntry, EventExposeEntry, WebConfig } from './exposure/types.js';
export { WebServiceModule } from './exposure/WebServiceModule.js';
export { mountRest, type MountRestOptions } from './exposure/rest.js';
export { toHttpError, type HttpErrorBody } from './exposure/errors.js';
export { coerceToSchema, objectShapeOf, formatZodError } from './exposure/input.js';

// Authentication & Session
export type { SessionUser, SessionRecord, SessionStore } from './auth/types.js';
export { MemorySessionStore } from './auth/MemorySessionStore.js';
export {
    SESSION_COOKIE,
    CSRF_HEADER,
    type CookieOptions,
    setSessionCookie,
    clearSessionCookie,
    readSessionId,
    csrfTokenMatches,
} from './auth/session.js';
export { ADMIN_ROLE, checkAuth } from './auth/gate.js';

// MCP & OpenAPI projections
export {
    buildMcpServer,
    type McpServerInfo,
    type McpServerOptions,
    type McpSessionAccessor,
} from './exposure/mcp.js';
export {
    buildOpenApiDocument,
    type OpenApiInfo,
    type OpenApiDocument,
    type OpenApiOperation,
    type OpenApiParameter,
    type OpenApiRequestBody,
} from './exposure/openapi.js';

// Typed client codegen
export {
    generateClient,
    generateClientToFile,
    zodTypeToTs,
    type GenerateClientOptions,
    type CodegenContext,
} from './cli/generate-client.js';

// Server Assembly
export { mountAuthRoutes, type AuthRoutesOptions } from './server/authRoutes.js';
export {
    createWebServer,
    type CreateWebServerOptions,
    type CreateWebServerResult,
} from './server/createWebServer.js';

// Reactivity Core
export type {
    Signal,
    ReadonlySignal,
    Resource,
    ReactiveScope,
    EffectFn,
    CleanupFn,
    DisposeFn,
    ResourceMutator,
} from './runtime/reactivity/index.js';
export {
    signal,
    computed,
    effect,
    batch,
    untrack,
    flushSync,
    resource,
    createScope,
} from './runtime/reactivity/index.js';

