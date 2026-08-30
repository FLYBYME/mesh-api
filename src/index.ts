// `@flybyme/mesh-api` -- the EXPOSURE half: REST, MCP, OpenAPI, sessions, client codegen.
//
// The browser runtime lives behind `@flybyme/mesh-api/runtime` and is deliberately NOT re-exported
// here. A single entry re-exporting both crashed any Node consumer at startup with
// `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".css"`, because the component modules carry
// real `import './x.css'` side effects that only a bundler can resolve. `tsc` stayed clean the
// whole time -- the types resolve fine -- so it surfaced only when a server actually ran.
//
// This is the split `spec/00-overview.md` already describes, now enforced by the module graph
// rather than by intention: a headless service pays nothing for a UI it never serves, and the
// browser half never pulls in express.
// Exposure & Module Extension
export type {
    AuthLevel,
    AuthExposeEntry,
    PermissionExposeEntry,
    ExposeEntry,
    EventExposeEntry,
    WebConfig,
} from './exposure/types.js';
export { WebServiceModule } from './exposure/WebServiceModule.js';
export { mountRest, type MountRestOptions } from './exposure/rest.js';
export { toHttpError, type HttpErrorBody } from './exposure/errors.js';
export { coerceToSchema, objectShapeOf, formatZodError } from './exposure/input.js';
export {
    unwrapSchema,
    isFieldOptional,
    isInputEmptyOrAllOptional,
    getObjectShape,
    getEnumOptions,
    getZodTypeName,
    classifyFormField,
    type UnwrappedSchema,
    type FormFieldClassification,
} from './exposure/schema.js';

// Authentication & Session
export type {
    SessionUser,
    SessionRecord,
    SessionStore,
    AuthorizeInput,
    AuthorizeSuccess,
    AuthorizeFailure,
    AuthorizeResult,
    AuthorizeHook,
} from './auth/types.js';
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
export {
    ADMIN_ROLE,
    checkAuth,
    matchPermission,
    extractRequestedScope,
    validateExposeEntry,
    executeGate,
    type GateExecutionResult,
} from './auth/gate.js';

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