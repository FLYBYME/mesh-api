/**
 * DEFAULT_BASE_PATH: where the REST API mounts, and therefore where a generated client points.
 *
 * These two defaults have to agree, and when they did not the failure was silent and confusing:
 * `createWebServer` mounted routes under `/api` while `generateClient` defaulted its `baseUrl` to
 * `''`, so a client generated without an explicit option fetched `/kanban/cards` and got a 404
 * from a server serving `/api/kanban/cards`. Nothing in either file was individually wrong, which
 * is exactly why the constant now lives in one place that both import.
 */
export const DEFAULT_BASE_PATH = '/api';
