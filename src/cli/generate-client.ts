#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { z, type ToolContract, globalContractRegistry } from '@flybyme/mesh';
import { CSRF_HEADER } from '../auth/session.js';
import type { ExposeEntry } from '../exposure/types.js';

export interface CodegenContext {
    readonly toolKey: string;
    readonly path: readonly string[];
    readonly indent: number;
}

export interface GenerateClientOptions {
    readonly baseUrl?: string;
}

function toPascalCase(str: string): string {
    return str
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

function isFieldOptional(schema: unknown): boolean {
    if (!(schema instanceof z.ZodType)) return false;
    if (schema instanceof z.ZodOptional) return true;
    if (schema instanceof z.ZodDefault) return true;
    if (schema instanceof z.ZodEffects) return isFieldOptional(schema.innerType());
    if (schema instanceof z.ZodReadonly) return isFieldOptional(schema.unwrap());
    return false;
}

function isInputEmptyOrAllOptional(schema: unknown): boolean {
    if (!(schema instanceof z.ZodType)) return true;
    if (schema instanceof z.ZodVoid || schema instanceof z.ZodUndefined) return true;
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return true;
    if (schema instanceof z.ZodEffects) return isInputEmptyOrAllOptional(schema.innerType());
    if (schema instanceof z.ZodReadonly) return isInputEmptyOrAllOptional(schema.unwrap());
    if (schema instanceof z.ZodObject) {
        const entries = Object.entries(schema.shape);
        if (entries.length === 0) return true;
        return entries.every(([, field]) => isFieldOptional(field));
    }
    return false;
}

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

    const typeName = schema.constructor?.name || 'ZodType';
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

/**
 * Generates self-contained TypeScript client code with zero zod or mesh runtime dependencies.
 */
export function generateClient(
    exposed: readonly (ExposeEntry | ToolContract)[],
    options?: GenerateClientOptions
): string {
    const contracts: ToolContract[] = [];
    const seen = new Set<string>();

    for (const item of exposed) {
        const contract = getContract(item);
        const key = `${contract.domain}.${contract.action}`;
        if (!seen.has(key)) {
            seen.add(key);
            contracts.push(contract);
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

    // Emit ApiClient interface
    out.push(`export interface ApiClient {`);
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
    out.push(`  const baseUrl = options.baseUrl ?? ${JSON.stringify(options?.baseUrl ?? '')};`);
    out.push(`  const customFetch = options.fetch ?? globalThis.fetch;`);
    out.push(``);
    out.push(`  return {`);

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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('generate-client.js')) {
    runCli(process.argv.slice(2)).catch((err: unknown) => {
        console.error('Error generating client:', err);
        process.exit(1);
    });
}
