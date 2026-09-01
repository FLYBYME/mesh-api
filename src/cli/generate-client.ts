#!/usr/bin/env node
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, type ToolContract, globalContractRegistry } from '@flybyme/mesh';

import { CSRF_HEADER } from '../auth/session.js';
import type { ExposeEntry, EventExposeEntry } from '../exposure/types.js';
import { DEFAULT_BASE_PATH } from '../exposure/paths.js';

export interface CodegenContext {
    readonly toolKey: string;
    readonly path: readonly string[];
    readonly indent: number;
}

export interface GenerateClientOptions {
    readonly baseUrl?: string;
    readonly events?: readonly (EventExposeEntry | string | import('@flybyme/mesh').EventDefinition<z.ZodTypeAny>)[];
}


function toPascalCase(str: string): string {
    return str
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

import { isFieldOptional, isInputEmptyOrAllOptional, getZodTypeName } from '../exposure/schema.js';

/**
 * Walks a Zod schema and emits the corresponding TypeScript type string.
 * Emits `unknown` and logs a warning for unsupported types; never emits `any`.
 */
export function zodTypeToTs(schema: unknown, ctx: CodegenContext): string {
    if (!(schema instanceof z.ZodType)) {
        return 'unknown';
    }
    if (schema instanceof z.ZodString) {
        return 'string';
    }
    if (schema instanceof z.ZodNumber) {
        return 'number';
    }
    if (schema instanceof z.ZodBoolean) {
        return 'boolean';
    }
    if (schema instanceof z.ZodLiteral) {
        const val = schema.value;
        if (typeof val === 'string') return JSON.stringify(val);
        if (typeof val === 'number' || typeof val === 'boolean') return String(val);
        if (typeof val === 'bigint') return `${val}n`;
        if (val === null) return 'null';
        if (val === undefined) return 'undefined';
        return 'unknown';
    }
    if (schema instanceof z.ZodEnum) {
        return schema.options.map((opt: string) => JSON.stringify(opt)).join(' | ');
    }
    if (schema instanceof z.ZodNativeEnum) {
        const values = Object.values(schema.enum);
        const filtered = values.filter((v: unknown) => {
            if (typeof v === 'number') return true;
            return !schema.enum[String(v)];
        });
        return filtered.map((v: unknown) => typeof v === 'string' ? JSON.stringify(v) : String(v)).join(' | ');
    }
    if (schema instanceof z.ZodArray) {
        const elem = zodTypeToTs(schema.element, { ...ctx, path: [...ctx.path, '[]'] });
        if (elem.includes(' | ') || elem.includes(' & ')) {
            return `(${elem})[]`;
        }
        return `${elem}[]`;
    }
    if (schema instanceof z.ZodOptional) {
        const inner = zodTypeToTs(schema.unwrap(), ctx);
        return `${inner} | undefined`;
    }
    if (schema instanceof z.ZodNullable) {
        const inner = zodTypeToTs(schema.unwrap(), ctx);
        return `${inner} | null`;
    }
    if (schema instanceof z.ZodDefault) {
        return zodTypeToTs(schema.removeDefault(), ctx);
    }
    if (schema instanceof z.ZodUnion) {
        return schema.options.map((opt: z.ZodTypeAny, i: number) =>
            zodTypeToTs(opt, { ...ctx, path: [...ctx.path, `union[${i}]`] })
        ).join(' | ');
    }
    if (schema instanceof z.ZodDiscriminatedUnion) {
        return schema.options.map((opt: z.ZodObject<z.ZodRawShape>, i: number) =>
            zodTypeToTs(opt, { ...ctx, path: [...ctx.path, `discriminatedUnion[${i}]`] })
        ).join(' | ');
    }
    if (schema instanceof z.ZodRecord) {
        const keyType = schema.keySchema
            ? zodTypeToTs(schema.keySchema, { ...ctx, path: [...ctx.path, '[key]'] })
            : 'string';
        const valType = zodTypeToTs(schema.valueSchema, { ...ctx, path: [...ctx.path, '[value]'] });
        return `Record<${keyType}, ${valType}>`;
    }
    if (schema instanceof z.ZodDate) {
        return 'Date | string';
    }
    if (schema instanceof z.ZodVoid || schema instanceof z.ZodUndefined) {
        return 'void';
    }
    if (schema instanceof z.ZodNull) {
        return 'null';
    }
    if (schema instanceof z.ZodEffects) {
        return zodTypeToTs(schema.innerType(), ctx);
    }
    if (schema instanceof z.ZodTuple) {
        const items = schema.items.map((item: z.ZodTypeAny, i: number) =>
            zodTypeToTs(item, { ...ctx, path: [...ctx.path, `tuple[${i}]`] })
        );
        return `[${items.join(', ')}]`;
    }
    if (schema instanceof z.ZodIntersection) {
        const left = zodTypeToTs(schema._def.left, ctx);
        const right = zodTypeToTs(schema._def.right, ctx);
        return `(${left}) & (${right})`;
    }
    if (schema instanceof z.ZodReadonly) {
        return zodTypeToTs(schema.unwrap(), ctx);
    }
    if (schema instanceof z.ZodBranded) {
        return zodTypeToTs(schema.unwrap(), ctx);
    }
    if (schema instanceof z.ZodCatch) {
        return zodTypeToTs(schema.removeCatch(), ctx);
    }
    if (schema instanceof z.ZodPipeline) {
        return zodTypeToTs(schema._def.out, ctx);
    }
    if (schema instanceof z.ZodObject) {
        const shape = schema.shape;
        const entries = Object.entries(shape);
        if (entries.length === 0) return '{}';
        const indentStr = '  '.repeat(ctx.indent + 1);
        const closeIndent = '  '.repeat(ctx.indent);
        const lines: string[] = ['{'];
        for (const [key, field] of entries) {
            const isOpt = isFieldOptional(field);
            const unwrappedField = (field instanceof z.ZodOptional)
                ? field.unwrap()
                : (field instanceof z.ZodDefault)
                ? field.removeDefault()
                : field;
            const fieldTs = zodTypeToTs(unwrappedField, {
                ...ctx,
                path: [...ctx.path, key],
                indent: ctx.indent + 1,
            });
            const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
            lines.push(`${indentStr}${safeKey}${isOpt ? '?' : ''}: ${fieldTs};`);
        }
        lines.push(`${closeIndent}}`);
        return lines.join('\n');
    }
    if (schema instanceof z.ZodUnknown) {
        return 'unknown';
    }

    const typeName = getZodTypeName(schema);
    const fieldLoc = ctx.path.length > 0 ? `${ctx.toolKey}.${ctx.path.join('.')}` : ctx.toolKey;
    console.warn(`[mesh-api codegen] Unsupported Zod type '${typeName}' at ${fieldLoc}; emitted 'unknown'`);
    return 'unknown';
}

function getContract(item: ExposeEntry | ToolContract): ToolContract {
    if ('contract' in item) {
        return item.contract;
    }
    return item;
}

export function generateClient(
    exposed:
        | readonly (ExposeEntry | ToolContract)[]
        | {
              readonly expose: readonly (ExposeEntry | ToolContract)[];
              readonly events?: readonly (EventExposeEntry | string | import('@flybyme/mesh').EventDefinition<z.ZodTypeAny>)[];
          },
    options?: GenerateClientOptions
): string {
    let exposedContracts: readonly (ExposeEntry | ToolContract)[];
    let rawEvents: readonly (EventExposeEntry | string | import('@flybyme/mesh').EventDefinition<z.ZodTypeAny>)[];

    if ('expose' in exposed) {
        exposedContracts = exposed.expose;
        rawEvents = exposed.events ?? options?.events ?? [];
    } else {
        exposedContracts = exposed;
        rawEvents = options?.events ?? [];
    }


    const contracts: ToolContract[] = [];
    const seen = new Set<string>();


    for (const item of exposedContracts) {
        const contract = getContract(item);
        const key = `${contract.domain}.${contract.action}`;
        if (!seen.has(key)) {
            seen.add(key);
            contracts.push(contract);
        }
    }

    interface EventCodegenInfo {
        name: string;
        typeName: string;
        schema?: z.ZodTypeAny;
    }
    const eventsInfo: EventCodegenInfo[] = [];
    const seenEvents = new Set<string>();

    for (const item of rawEvents) {
        let name = '';
        let schema: z.ZodTypeAny | undefined = undefined;

        if (typeof item === 'string') {
            name = item.trim();
        } else if (typeof item === 'object' && item !== null) {
            if ('event' in item) {
                const subEvent = (item as { event: unknown }).event;
                if (typeof subEvent === 'string') {
                    name = subEvent.trim();
                } else if (typeof subEvent === 'object' && subEvent !== null && 'name' in subEvent) {
                    name = (subEvent as { name: string }).name;
                    if ('schema' in subEvent) {
                        schema = (subEvent as { schema: z.ZodTypeAny }).schema;
                    }
                }
                if (!schema && 'schema' in item && (item as { schema: z.ZodTypeAny }).schema) {
                    schema = (item as { schema: z.ZodTypeAny }).schema;
                }
            } else if ('name' in item) {
                name = (item as { name: string }).name;
                if ('schema' in item) {
                    schema = (item as { schema: z.ZodTypeAny }).schema;
                }
            }
        }

        if (name && !seenEvents.has(name)) {
            seenEvents.add(name);
            const typeName = `${toPascalCase(name)}Event`;
            eventsInfo.push({ name, typeName, schema });
        }
    }

    const byDomain = new Map<string, ToolContract[]>();
    for (const contract of contracts) {
        const list = byDomain.get(contract.domain) ?? [];
        list.push(contract);
        byDomain.set(contract.domain, list);
    }

    const out: string[] = [
        `// GENERATED BY @flybyme/mesh-api - DO NOT EDIT`,
        `// One zod schema is the single source of truth for validation, REST, MCP, and this client.`,
        `// Zero runtime dependencies. Plain fetch only.`,
        ``,
        `export class ApiError extends Error {`,
        `  readonly status: number;`,
        `  readonly code: string;`,
        ``,
        `  constructor(status: number, code: string, message: string) {`,
        `    super(message);`,
        `    this.name = 'ApiError';`,
        `    this.status = status;`,
        `    this.code = code;`,
        `  }`,
        `}`,
        ``,
        `export interface ApiClientOptions {`,
        `  baseUrl?: string;`,
        `  csrfToken?: string | (() => string | undefined | Promise<string | undefined>);`,
        `  fetch?: typeof fetch;`,
        `  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);`,
        `}`,
        ``,
        `const CSRF_HEADER_NAME = ${JSON.stringify(CSRF_HEADER)};`,
        ``,
        `function isRecord(val: unknown): val is Record<string, unknown> {`,
        `  return typeof val === 'object' && val !== null && !Array.isArray(val);`,
        `}`,
        ``,
        `function isHttpErrorBody(data: unknown): data is { error: { code: string; message: string } } {`,
        `  if (!isRecord(data)) return false;`,
        `  const inner = data['error'];`,
        `  if (!isRecord(inner)) return false;`,
        `  return typeof inner['code'] === 'string' && typeof inner['message'] === 'string';`,
        `}`,
        ``,
    ];

    // Emit Type Definitions for each contract
    for (const contract of contracts) {
        const toolKeyStr = `${contract.domain}.${contract.action}`;
        const inputTypeName = `${toPascalCase(contract.domain)}${toPascalCase(contract.action)}Input`;
        const outputTypeName = `${toPascalCase(contract.domain)}${toPascalCase(contract.action)}Output`;

        const inputTs = zodTypeToTs(contract.inputSchema, {
            toolKey: toolKeyStr,
            path: ['inputSchema'],
            indent: 0,
        });

        const outputTs = zodTypeToTs(contract.outputSchema, {
            toolKey: toolKeyStr,
            path: ['outputSchema'],
            indent: 0,
        });

        if (inputTs.startsWith('{')) {
            out.push(`export interface ${inputTypeName} ${inputTs}`);
        } else {
            out.push(`export type ${inputTypeName} = ${inputTs};`);
        }

        if (outputTs.startsWith('{')) {
            out.push(`export interface ${outputTypeName} ${outputTs}`);
        } else {
            out.push(`export type ${outputTypeName} = ${outputTs};`);
        }

        out.push(``);
    }

    // Emit Type Definitions for each event with schema
    for (const ev of eventsInfo) {
        if (ev.schema) {
            const evTs = zodTypeToTs(ev.schema, {
                toolKey: ev.name,
                path: ['eventSchema'],
                indent: 0,
            });
            if (evTs.startsWith('{')) {
                out.push(`export interface ${ev.typeName} ${evTs}`);
            } else {
                out.push(`export type ${ev.typeName} = ${evTs};`);
            }
            out.push(``);
        }
    }

    // Emit EventMap interface
    out.push(`export interface EventMap {`);
    for (const ev of eventsInfo) {
        if (ev.schema) {
            out.push(`  ${JSON.stringify(ev.name)}: ${ev.typeName};`);
        } else {
            out.push(`  ${JSON.stringify(ev.name)}: Record<string, unknown>;`);
        }
    }
    out.push(`  [topic: string]: unknown;`);
    out.push(`}`);
    out.push(``);

    // Emit EventBridgeClient interface
    out.push(`export type EventBridgeState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';`);
    out.push(``);
    out.push(`export interface EventBridgeClient<TEvents = EventMap> {`);
    out.push(`  readonly status: EventBridgeState;`);
    out.push(`  readonly isDisposed: boolean;`);
    out.push(`  on<K extends keyof TEvents>(topic: K, handler: (payload: TEvents[K]) => void): () => void;`);
    out.push(`  on<T = unknown>(topic: string, handler: (payload: T) => void): () => void;`);
    out.push(`  close(): void;`);
    out.push(`  dispose(): void;`);
    out.push(`}`);
    out.push(``);

    // Emit createEventBridgeClient implementation
    out.push(`export function createEventBridgeClient<TEvents = EventMap>(options: ApiClientOptions = {}): EventBridgeClient<TEvents> {`);
    out.push(`  const baseUrl = options.baseUrl ?? ${JSON.stringify(options?.baseUrl ?? DEFAULT_BASE_PATH)};`);
    out.push(`  const customFetch = options.fetch ?? globalThis.fetch;`);
    out.push(`  let status: EventBridgeState = 'idle';`);
    out.push(`  let isDisposed = false;`);
    out.push(`  let reconnectAttempt = 0;`);
    out.push(`  let lastEventId: string | undefined = undefined;`);
    out.push(`  let reconnectTimer: ReturnType<typeof setTimeout> | undefined = undefined;`);
    out.push(`  let connectScheduled = false;`);
    out.push(`  let abortController: AbortController | null = null;`);
    out.push(`  const topicHandlers = new Map<string, Set<(payload: unknown) => void>>();`);
    out.push(`  let connectedTopicsKey = '';`);
    out.push(``);
    out.push(`  const getActiveTopics = (): string[] => {`);
    out.push(`    const list: string[] = [];`);
    out.push(`    for (const [topic, handlers] of topicHandlers.entries()) {`);
    out.push(`      if (handlers.size > 0) list.push(topic);`);
    out.push(`    }`);
    out.push(`    return list.sort();`);
    out.push(`  };`);
    out.push(``);
    out.push(`  const scheduleReconnect = (): void => {`);
    out.push(`    if (isDisposed || status === 'closed') return;`);
    out.push(`    const topics = getActiveTopics();`);
    out.push(`    if (topics.length === 0) { status = 'idle'; return; }`);
    out.push(`    status = 'reconnecting';`);
    out.push(`    const baseDelay = 1000 * Math.pow(2, reconnectAttempt);`);
    out.push(`    const cappedDelay = Math.min(30000, baseDelay);`);
    out.push(`    const rand = Math.random();`);
    out.push(`    const delayMs = Math.max(0, Math.round(cappedDelay * (0.75 + rand * 0.5)));`);
    out.push(`    reconnectAttempt++;`);
    out.push(`    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);`);
    out.push(`    reconnectTimer = setTimeout(() => {`);
    out.push(`      reconnectTimer = undefined;`);
    out.push(`      void connect();`);
    out.push(`    }, delayMs);`);
    out.push(`  };`);
    out.push(``);
    out.push(`  const connect = async (): Promise<void> => {`);
    out.push(`    if (isDisposed || status === 'closed') return;`);
    out.push(`    const topics = getActiveTopics();`);
    out.push(`    if (topics.length === 0) { status = 'idle'; return; }`);
    out.push(`    const currentKey = topics.join(',');`);
    out.push(`    connectedTopicsKey = currentKey;`);
    out.push(`    if (abortController !== null) {`);
    out.push(`      abortController.abort();`);
    out.push(`      abortController = null;`);
    out.push(`    }`);
    out.push(`    const controller = new AbortController();`);
    out.push(`    abortController = controller;`);
    out.push(`    status = 'connecting';`);
    out.push(`    const resolvedHeaders: Record<string, string> = {`);
    out.push(`      Accept: 'text/event-stream',`);
    out.push(`      ...(options.headers ? (typeof options.headers === 'function' ? await options.headers() : options.headers) : {}),`);
    out.push(`    };`);
    out.push(`    if (lastEventId !== undefined) {`);
    out.push(`      resolvedHeaders['Last-Event-ID'] = lastEventId;`);
    out.push(`    }`);
    out.push(`    const url = baseUrl + '/events?topics=' + encodeURIComponent(currentKey);`);
    out.push(`    try {`);
    out.push(`      const res = await customFetch(url, {`);
    out.push(`        method: 'GET',`);
    out.push(`        headers: resolvedHeaders,`);
    out.push(`        credentials: 'include',`);
    out.push(`        signal: controller.signal,`);
    out.push(`      });`);
    out.push(`      if (!res.ok) {`);
    out.push(`        if (res.status === 401 || res.status === 403) {`);
    out.push(`          status = 'closed';`);
    out.push(`          return;`);
    out.push(`        }`);
    out.push(`        scheduleReconnect();`);
    out.push(`        return;`);
    out.push(`      }`);
    out.push(`      status = 'connected';`);
    out.push(`      reconnectAttempt = 0;`);
    out.push(`      const reader = res.body?.getReader();`);
    out.push(`      if (!reader) return;`);
    out.push(`      const decoder = new TextDecoder('utf-8');`);
    out.push(`      let streamBuffer = '';`);
    out.push(`      let currentEventName = 'message';`);
    out.push(`      const currentDataLines: string[] = [];`);
    out.push(`      let currentId: string | undefined = undefined;`);
    out.push(`      while (true) {`);
    out.push(`        const { done, value } = await reader.read();`);
    out.push(`        if (done) break;`);
    out.push(`        streamBuffer += decoder.decode(value, { stream: true });`);
    out.push(`        const lines = streamBuffer.split(/\\r\\n|\\r|\\n/);`);
    out.push(`        streamBuffer = lines.pop() ?? '';`);
    out.push(`        for (const line of lines) {`);
    out.push(`          if (line === '') {`);
    out.push(`            if (currentDataLines.length > 0) {`);
    out.push(`              const rawData = currentDataLines.join('\\n');`);
    out.push(`              let parsed: unknown = rawData;`);
    out.push(`              try { parsed = JSON.parse(rawData); } catch { /* non-JSON fallback */ }`);
    out.push(`              const handlers = topicHandlers.get(currentEventName);`);
    out.push(`              if (handlers !== undefined) {`);
    out.push(`                for (const handler of Array.from(handlers)) {`);
    out.push(`                  try { handler(parsed); } catch { /* handler error */ }`);
    out.push(`                }`);
    out.push(`              }`);
    out.push(`            }`);
    out.push(`            if (currentId !== undefined) lastEventId = currentId;`);
    out.push(`            currentEventName = 'message';`);
    out.push(`            currentDataLines.length = 0;`);
    out.push(`            currentId = undefined;`);
    out.push(`          } else if (line.startsWith(':')) {`);
    out.push(`            // heartbeat`);
    out.push(`          } else if (line.startsWith('event:')) {`);
    out.push(`            currentEventName = line.slice(line.startsWith('event: ') ? 7 : 6).trim();`);
    out.push(`          } else if (line.startsWith('data:')) {`);
    out.push(`            currentDataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5));`);
    out.push(`          } else if (line.startsWith('id:')) {`);
    out.push(`            currentId = line.slice(line.startsWith('id: ') ? 4 : 3).trim();`);
    out.push(`          }`);
    out.push(`        }`);
    out.push(`      }`);
    out.push(`      if (!controller.signal.aborted) scheduleReconnect();`);
    out.push(`    } catch {`);
    out.push(`      if (!controller.signal.aborted && !isDisposed && status !== 'closed') {`);
    out.push(`        scheduleReconnect();`);
    out.push(`      }`);
    out.push(`    }`);
    out.push(`  };`);
    out.push(``);
    out.push(`  const triggerConnect = (): void => {`);
    out.push(`    if (connectScheduled || isDisposed || status === 'closed') return;`);
    out.push(`    connectScheduled = true;`);
    out.push(`    queueMicrotask(() => {`);
    out.push(`      connectScheduled = false;`);
    out.push(`      const currentKey = getActiveTopics().join(',');`);
    out.push(`      if (status === 'connected' && currentKey === connectedTopicsKey) return;`);
    out.push(`      void connect();`);
    out.push(`    });`);
    out.push(`  };`);
    out.push(``);
    out.push(`  const client: EventBridgeClient<TEvents> = {`);
    out.push(`    get status(): EventBridgeState { return status; },`);
    out.push(`    get isDisposed(): boolean { return isDisposed; },`);
    out.push(`    on<K extends keyof TEvents>(topic: K | string, handler: (payload: TEvents[K]) => void): () => void {`);
    out.push(`      if (isDisposed) throw new Error('[EventBridgeClient] Cannot subscribe: client is disposed');`);
    out.push(`      const topicStr = String(topic);`);
    out.push(`      let handlers = topicHandlers.get(topicStr);`);
    out.push(`      if (handlers === undefined) {`);
    out.push(`        handlers = new Set();`);
    out.push(`        topicHandlers.set(topicStr, handlers);`);
    out.push(`      }`);
    out.push(`      handlers.add(handler as (payload: unknown) => void);`);
    out.push(`      triggerConnect();`);
    out.push(`      return () => {`);
    out.push(`        const set = topicHandlers.get(topicStr);`);
    out.push(`        if (set !== undefined) {`);
    out.push(`          set.delete(handler as (payload: unknown) => void);`);
    out.push(`          if (set.size === 0) topicHandlers.delete(topicStr);`);
    out.push(`        }`);
    out.push(`      };`);
    out.push(`    },`);
    out.push(`    close(): void {`);
    out.push(`      isDisposed = true;`);
    out.push(`      status = 'closed';`);
    out.push(`      if (reconnectTimer !== undefined) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }`);
    out.push(`      if (abortController !== null) { abortController.abort(); abortController = null; }`);
    out.push(`      topicHandlers.clear();`);
    out.push(`    },`);
    out.push(`    dispose(): void {`);
    out.push(`      this.close();`);
    out.push(`    },`);
    out.push(`  };`);
    out.push(`  return client;`);
    out.push(`}`);
    out.push(``);

    // Emit ApiClient interface
    out.push(`export interface ApiClient {`);
    out.push(`  readonly events: EventBridgeClient<EventMap>;`);
    for (const [domain, domainContracts] of byDomain.entries()) {
        out.push(`  readonly ${domain}: {`);
        for (const contract of domainContracts) {
            const inputTypeName = `${toPascalCase(contract.domain)}${toPascalCase(contract.action)}Input`;
            const outputTypeName = `${toPascalCase(contract.domain)}${toPascalCase(contract.action)}Output`;
            const isOpt = isInputEmptyOrAllOptional(contract.inputSchema);
            out.push(`    readonly ${contract.action}: (input${isOpt ? '?: ' : ': '}${inputTypeName}) => Promise<${outputTypeName}>;`);
        }
        out.push(`  };`);
    }
    out.push(`}`);
    out.push(``);

    // Emit createApiClient factory function
    out.push(`export function createApiClient(options: ApiClientOptions = {}): ApiClient {`);
    out.push(`  const baseUrl = options.baseUrl ?? ${JSON.stringify(options?.baseUrl ?? DEFAULT_BASE_PATH)};`);
    out.push(`  const customFetch = options.fetch ?? globalThis.fetch;`);
    out.push(`  const events = createEventBridgeClient<EventMap>(options);`);
    out.push(``);
    out.push(`  return {`);
    out.push(`    events,`);

    for (const [domain, domainContracts] of byDomain.entries()) {

        out.push(`    ${domain}: {`);
        for (const contract of domainContracts) {
            const inputTypeName = `${toPascalCase(contract.domain)}${toPascalCase(contract.action)}Input`;
            const outputTypeName = `${toPascalCase(contract.domain)}${toPascalCase(contract.action)}Output`;
            const isOpt = isInputEmptyOrAllOptional(contract.inputSchema);
            const pathMatches = contract.rest.path.match(/:([a-zA-Z0-9_]+)/g);
            const pathParamNames = pathMatches ? pathMatches.map(p => p.slice(1)) : [];
            const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(contract.rest.method);

            out.push(`      ${contract.action}: async (input${isOpt ? '?: ' : ': '}${inputTypeName}): Promise<${outputTypeName}> => {`);
            out.push(`        let path = ${JSON.stringify(contract.rest.path)};`);
            out.push(`        const params: Record<string, unknown> = {};`);
            out.push(`        if (input) Object.assign(params, input);`);

            for (const paramName of pathParamNames) {
                out.push(`        if (params[${JSON.stringify(paramName)}] !== undefined) {`);
                out.push(`          path = path.replace(${JSON.stringify(':' + paramName)}, encodeURIComponent(String(params[${JSON.stringify(paramName)}])));`);
                out.push(`          delete params[${JSON.stringify(paramName)}];`);
                out.push(`        }`);
            }

            out.push(`        const headers: Record<string, string> = {`);
            out.push(`          ...(options.headers ? (typeof options.headers === 'function' ? await options.headers() : options.headers) : {}),`);
            out.push(`        };`);

            if (isStateChanging) {
                out.push(`        const csrf = options.csrfToken ? (typeof options.csrfToken === 'function' ? await options.csrfToken() : options.csrfToken) : undefined;`);
                out.push(`        if (csrf) {`);
                out.push(`          headers[CSRF_HEADER_NAME] = csrf;`);
                out.push(`        }`);
            }

            if (contract.rest.method === 'GET') {
                out.push(`        const query = new URLSearchParams();`);
                out.push(`        for (const [key, value] of Object.entries(params)) {`);
                out.push(`          if (value !== undefined && value !== null) {`);
                out.push(`            if (Array.isArray(value)) {`);
                out.push(`              for (const item of value) query.append(key, String(item));`);
                out.push(`            } else {`);
                out.push(`              query.append(key, String(value));`);
                out.push(`            }`);
                out.push(`          }`);
                out.push(`        }`);
                out.push(`        const qs = query.toString();`);
                out.push(`        const url = baseUrl + path + (qs ? '?' + qs : '');`);
                out.push(`        const res = await customFetch(url, {`);
                out.push(`          method: 'GET',`);
                out.push(`          headers,`);
                out.push(`          credentials: 'include',`);
                out.push(`        });`);
            } else {
                out.push(`        let body: string | undefined = undefined;`);
                out.push(`        if (Object.keys(params).length > 0) {`);
                out.push(`          body = JSON.stringify(params);`);
                out.push(`          headers['Content-Type'] = 'application/json';`);
                out.push(`        }`);
                out.push(`        const url = baseUrl + path;`);
                out.push(`        const res = await customFetch(url, {`);
                out.push(`          method: ${JSON.stringify(contract.rest.method)},`);
                out.push(`          headers,`);
                out.push(`          credentials: 'include',`);
                out.push(`          ...(body !== undefined ? { body } : {}),`);
                out.push(`        });`);
            }

            out.push(`        if (!res.ok) {`);
            out.push(`          let code = 'HTTP_' + res.status;`);
            out.push(`          let message = res.statusText || 'Request failed';`);
            out.push(`          try {`);
            out.push(`            const errData: unknown = await res.json();`);
            out.push(`            if (isHttpErrorBody(errData)) {`);
            out.push(`              code = errData.error.code;`);
            out.push(`              message = errData.error.message;`);
            out.push(`            }`);
            out.push(`          } catch {`);
            out.push(`            // Non-JSON error body fallback`);
            out.push(`          }`);
            out.push(`          throw new ApiError(res.status, code, message);`);
            out.push(`        }`);
            out.push(`        const data: unknown = await res.json();`);
            out.push(`        return data as ${outputTypeName};`);
            out.push(`      },`);
        }
        out.push(`    },`);
    }

    out.push(`  };`);
    out.push(`}`);
    out.push(``);
    out.push(`export const api = createApiClient();`);
    out.push(``);

    return out.join('\n');
}

/**
 * Generates and writes client code to a specified destination path.
 */
export function generateClientToFile(
    exposed: readonly (ExposeEntry | ToolContract)[],
    outputPath: string,
    options?: GenerateClientOptions
): void {
    const code = generateClient(exposed, options);
    const targetFile = path.resolve(process.cwd(), outputPath);
    const targetDir = path.dirname(targetFile);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.writeFileSync(targetFile, code, 'utf-8');
    console.log(`Generated client written to ${targetFile}`);
}

export async function runCli(argv: string[]): Promise<void> {
    let outPath: string | undefined;
    let entryPath: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--out' || arg === '-o') {
            outPath = argv[++i];
        } else if (arg === '--entry' || arg === '-e' || arg === '--contracts') {
            entryPath = argv[++i];
        } else if (!arg?.startsWith('-') && !outPath) {
            outPath = arg;
        }
    }

    if (!outPath) {
        console.error('Usage: mesh-api-generate-client [options] <out-file>');
        console.error('Options:');
        console.error('  -o, --out <path>        Output .ts file path');
        console.error('  -e, --entry <path>      Entry file to load contracts from');
        process.exit(1);
    }

    if (entryPath) {
        const resolved = path.resolve(process.cwd(), entryPath);
        await import(resolved);
    }

    const contracts = Array.from(globalContractRegistry.values());
    if (contracts.length === 0) {
        console.warn('[mesh-api codegen] Warning: No contracts found in globalContractRegistry.');
    }

    generateClientToFile(contracts, outPath);
}

/**
 * Is this module the entry point?
 *
 * Compared as real paths, because npm installs a bin as a **symlink**:
 * `node_modules/.bin/mesh-api-generate-client -> ../@flybyme/mesh-api/dist/cli/generate-client.js`.
 * Node reports `process.argv[1]` as the symlink it was invoked through while `import.meta.url` is
 * the resolved file, so comparing them directly is false exactly when the CLI is used the way it
 * is meant to be used:
 *
 *     argv1       = node_modules/.bin/mesh-api-generate-client
 *     import.meta = .../dist/cli/generate-client.js
 *
 * The old guard also accepted any `argv[1]` ending `generate-client.js`, which covered running the
 * file by path and hid the symlink case entirely. Between them the command exited 0 having done
 * nothing — quieter than the `import: not found` it replaced, and worse, because a silent success
 * is indistinguishable from a working one in a script.
 */
function isEntryPoint(): boolean {
    const entry = process.argv[1];
    if (entry === undefined) return false;
    try {
        return realpathSync(entry) === fileURLToPath(import.meta.url);
    } catch {
        // argv[1] is not a path we can resolve — a REPL, an eval, a deleted file. Not the entry.
        return false;
    }
}

if (isEntryPoint()) {
    runCli(process.argv.slice(2)).catch((err: unknown) => {
        console.error('Error generating client:', err);
        process.exit(1);
    });
}
