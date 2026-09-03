/**
 * @flybyme/mesh-api — the `api` ServiceModule.
 *
 * Rebuilt from nothing on 2026-09-03. The tree it replaces is tagged `archive/pre-rewrite`; it was
 * deleted rather than ported because it was never a fixed point — mesh-web leads and mesh-api
 * adapts (mesh-web spec/status.md).
 *
 * What this is, per mesh-web spec/service-modules.md §2: a listener and a cache. It binds a port,
 * turns exposed contracts into REST, SSE and WebSockets, and across requests holds exactly two
 * things — the exposure map, and the ticket cache. Per request it is stateless, and nothing may
 * assume sticky routing.
 *
 * What this is not: the browser runtime. That lived here once and is now mesh-web's entire subject.
 */
export * from './exposure/types.js';
export * from './exposure/descriptor.js';
export * from './auth/gate.js';
export * from './auth/tickets.js';
export * from './server/broker.js';
export * from './server/input.js';
export * from './server/rest.js';
export * from './server/server.js';
export * from './exposure/events.js';
export * from './server/delivery.js';
export * from './server/sse.js';
export * from './module/contracts.js';
export * from './module/identity.js';
export * from './module/module.js';
