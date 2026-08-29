import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { defineContract, defaultPrint, z } from '@flybyme/mesh';
import { generateClient, generateClientToFile, zodTypeToTs } from '../src/cli/generate-client.js';
import { CSRF_HEADER } from '../src/auth/session.js';
import type { ExposeEntry } from '../src/exposure/types.js';

// --- Fixture Contracts ---

enum PriorityEnum {
    Low = 'low',
    Medium = 'medium',
    High = 'high',
}

const cardCreateContract = defineContract({
    domain: 'kanban',
    action: 'card_create',
    description: 'Create a new Kanban card',
    inputSchema: z.object({
        title: z.string(),
        repo: z.string(),
        priority: z.nativeEnum(PriorityEnum).optional(),
        tags: z.array(z.string()).default([]),
        metadata: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
        createdAt: z.date().optional(),
        assignee: z
            .object({
                id: z.string(),
                name: z.string(),
            })
            .nullable()
            .optional(),
    }),
    outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        repo: z.string(),
        priority: z.enum(['low', 'medium', 'high']),
        tags: z.array(z.string()),
        active: z.boolean(),
        version: z.literal(1),
    }),
    rest: { method: 'POST', path: '/kanban/cards' },
    print: defaultPrint,
    destructive: true,
});

const cardGetContract = defineContract({
    domain: 'kanban',
    action: 'card_get',
    description: 'Fetch card by ID',
    inputSchema: z.object({
        cardId: z.string(),
        includeAudit: z.boolean().optional(),
    }),
    outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
    }),
    rest: { method: 'GET', path: '/kanban/cards/:cardId' },
    print: defaultPrint,
});

const userListContract = defineContract({
    domain: 'users',
    action: 'list',
    description: 'List users',
    inputSchema: z.object({
        role: z.enum(['admin', 'user', 'guest']).optional(),
        limit: z.number().default(20),
    }),
    outputSchema: z.object({
        users: z.array(
            z.object({
                id: z.string(),
                email: z.string(),
            })
        ),
        total: z.number(),
    }),
    rest: { method: 'GET', path: '/users' },
    print: defaultPrint,
});

const emptyContract = defineContract({
    domain: 'system',
    action: 'ping',
    description: 'System ping',
    inputSchema: z.object({}),
    outputSchema: z.object({
        pong: z.boolean(),
    }),
    rest: { method: 'GET', path: '/system/ping' },
    print: defaultPrint,
});

describe('Typed Client Generator (src/cli/generate-client.ts)', () => {
    const exposed: ExposeEntry[] = [
        { contract: cardCreateContract, auth: 'user' },
        { contract: cardGetContract, auth: 'user' },
        { contract: userListContract, auth: 'public' },
        { contract: emptyContract, auth: 'public' },
    ];

    it('emits code containing ZERO imports of zod or mesh and ZERO any', () => {
        const code = generateClient(exposed);

        // No imports of zod, @flybyme/mesh, or external libraries
        expect(code).not.toMatch(/import\s+.*from\s+['"]zod['"]/);
        expect(code).not.toMatch(/import\s+.*from\s+['"]@flybyme\/mesh['"]/);
        expect(code).not.toMatch(/import\s+.*from\s+['"]@flybyme\/mesh-api['"]/);

        // Zero `any` keywords (like `as any`, `: any`, `any[]`)
        expect(code).not.toMatch(/:\s*any\b/);
        expect(code).not.toMatch(/\bas\s+any\b/);
        expect(code).not.toMatch(/<any>/);
        expect(code).not.toMatch(/\bany\[\]/);

        // Zero `as unknown as` or `as never`
        expect(code).not.toMatch(/\bas\s+unknown\s+as\b/);
        expect(code).not.toMatch(/\bas\s+never\b/);
    });

    it('translates schema types correctly: number, optional ?, enum, union, record, date, default', () => {
        const code = generateClient(exposed);

        // KanbanCardCreateInput
        expect(code).toContain('export interface KanbanCardCreateInput');
        expect(code).toContain('title: string;');
        expect(code).toContain('repo: string;');
        expect(code).toContain('priority?: "low" | "medium" | "high";');
        expect(code).toContain('tags?: string[];'); // default([]) makes it optional
        expect(code).toContain('metadata?: Record<string, string | number>;');
        expect(code).toContain('createdAt?: Date | string;');
        expect(code).toContain('id: string;');
        expect(code).toContain('name: string;');

        // KanbanCardCreateOutput
        expect(code).toContain('export interface KanbanCardCreateOutput');
        expect(code).toContain('priority: "low" | "medium" | "high";');
        expect(code).toContain('version: 1;'); // literal 1
        expect(code).toContain('active: boolean;');

        // UsersListInput
        expect(code).toContain('export interface UsersListInput');
        expect(code).toContain('role?: "admin" | "user" | "guest";');
        expect(code).toContain('limit?: number;'); // default(20) makes it optional
    });

    it('groups methods by domain under api.<domain>.<action>', () => {
        const code = generateClient(exposed);

        expect(code).toContain('export interface ApiClient {');
        expect(code).toContain('readonly kanban: {');
        expect(code).toContain('readonly card_create: (input: KanbanCardCreateInput) => Promise<KanbanCardCreateOutput>;');
        expect(code).toContain('readonly card_get: (input: KanbanCardGetInput) => Promise<KanbanCardGetOutput>;');
        expect(code).toContain('readonly users: {');
        expect(code).toContain('readonly list: (input?: UsersListInput) => Promise<UsersListOutput>;');
        expect(code).toContain('readonly system: {');
        expect(code).toContain('readonly ping: (input?: SystemPingInput) => Promise<SystemPingOutput>;');

        expect(code).toContain('export function createApiClient(options: ApiClientOptions = {}): ApiClient');
        expect(code).toContain('export const api = createApiClient();');
    });

    it('embeds the real CSRF header constant from src/auth/session.ts on state-changing calls', () => {
        const code = generateClient(exposed);

        expect(code).toContain(`const CSRF_HEADER_NAME = "${CSRF_HEADER}";`);
        expect(code).toContain('headers[CSRF_HEADER_NAME] = csrf;');
        expect(code).toContain("credentials: 'include'");
    });

    it('emits unknown and logs a warning for unsupported zod types, never emitting any', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const unsupportedContract = defineContract({
            domain: 'weird',
            action: 'custom',
            description: 'Contract with unsupported zod types',
            inputSchema: z.object({
                // z.bigint is unsupported in client JSON serialization
                big: z.bigint(),
                // z.symbol is unsupported
                sym: z.symbol(),
            }),
            outputSchema: z.object({
                out: z.string(),
            }),
            rest: { method: 'POST', path: '/weird/custom' },
            print: defaultPrint,
        });

        const code = generateClient([unsupportedContract]);

        expect(code).toContain('big: unknown;');
        expect(code).toContain('sym: unknown;');
        expect(code).not.toContain(': any;');

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[mesh-api codegen] Unsupported Zod type 'ZodBigInt' at weird.custom.inputSchema.big; emitted 'unknown'")
        );
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[mesh-api codegen] Unsupported Zod type 'ZodSymbol' at weird.custom.inputSchema.sym; emitted 'unknown'")
        );

        warnSpy.mockRestore();
    });

    it('surfaces HttpError error bodies as typed ApiError at runtime', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-client-test-'));
        const clientFile = path.join(tempDir, 'api.ts');

        generateClientToFile(exposed, clientFile);

        // Import the generated file dynamically in runtime
        const generatedModule = await import(clientFile);
        const { createApiClient, ApiError } = generatedModule;

        // Mock fetch that returns a 404 HttpError
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            json: async () => ({
                error: {
                    code: 'CARD_NOT_FOUND',
                    message: 'Card 123 does not exist',
                },
            }),
        });

        const client = createApiClient({
            fetch: mockFetch,
            baseUrl: 'http://localhost:3000',
        });

        try {
            await client.kanban.card_get({ cardId: '123' });
            expect.unreachable('Should have thrown ApiError');
        } catch (err: unknown) {
            expect(err).toBeInstanceOf(ApiError);
            const apiErr = err as InstanceType<typeof ApiError>;
            expect(apiErr.status).toBe(404);
            expect(apiErr.code).toBe('CARD_NOT_FOUND');
            expect(apiErr.message).toBe('Card 123 does not exist');
        }

        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('sends CSRF token and credentials: include on state-changing requests', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-client-csrf-'));
        const clientFile = path.join(tempDir, 'api.ts');

        generateClientToFile(exposed, clientFile);

        const generatedModule = await import(clientFile);
        const { createApiClient } = generatedModule;

        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                id: 'c1',
                title: 'Card 1',
                repo: 'repo1',
                priority: 'low',
                tags: [],
                active: true,
                version: 1,
            }),
        });

        const client = createApiClient({
            fetch: mockFetch,
            baseUrl: 'https://api.mesh.test',
            csrfToken: 'test-csrf-token-123',
        });

        await client.kanban.card_create({
            title: 'Card 1',
            repo: 'repo1',
        });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(calledUrl).toBe('https://api.mesh.test/kanban/cards');
        expect(calledInit.method).toBe('POST');
        expect(calledInit.credentials).toBe('include');
        expect((calledInit.headers as Record<string, string>)[CSRF_HEADER]).toBe('test-csrf-token-123');
        expect((calledInit.headers as Record<string, string>)['Content-Type']).toBe('application/json');

        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('type-checks generated code using the real TypeScript compiler (tsc --noEmit)', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-client-tsc-'));
        const clientFile = path.join(tempDir, 'api.ts');
        const consumerFile = path.join(tempDir, 'consumer.ts');
        const tsconfigFile = path.join(tempDir, 'tsconfig.json');

        generateClientToFile(exposed, clientFile);

        // Consumer script that exercises the generated client types and API
        const consumerContent = `
import { api, createApiClient, ApiError, type KanbanCardCreateInput, type KanbanCardCreateOutput } from './api.js';

async function main() {
  const customClient = createApiClient({
    baseUrl: 'http://localhost:3000',
    csrfToken: async () => 'dynamic-token',
  });

  const input: KanbanCardCreateInput = {
    title: 'Deploy to edge',
    repo: 'flybyme/infra',
    priority: 'high',
    tags: ['ops', 'edge'],
    metadata: { env: 'production', clusterId: 42 },
    createdAt: new Date(),
    assignee: { id: 'usr_1', name: 'Bob' },
  };

  const card: KanbanCardCreateOutput = await api.kanban.card_create(input);
  console.log(card.id, card.title, card.priority, card.version);

  const fetched = await customClient.kanban.card_get({ cardId: card.id, includeAudit: true });
  console.log(fetched.status);

  const users = await api.users.list({ role: 'admin' });
  console.log(users.total);

  const ping = await api.system.ping();
  console.log(ping.pong);
}
`;

        const tsconfigContent = JSON.stringify(
            {
                compilerOptions: {
                    target: 'ESNext',
                    module: 'ESNext',
                    moduleResolution: 'Bundler',
                    strict: true,
                    noEmit: true,
                    skipLibCheck: true,
                },
                include: ['./*.ts'],
            },
            null,
            2
        );

        fs.writeFileSync(consumerFile, consumerContent, 'utf-8');
        fs.writeFileSync(tsconfigFile, tsconfigContent, 'utf-8');

        // Run the real TypeScript compiler on the generated files
        expect(() => {
            execSync(`npx tsc --project ${tsconfigFile}`, {
                stdio: 'pipe',
                encoding: 'utf-8',
            });
        }).not.toThrow();

        // Now test that renaming or modifying a contract type causes a compile failure
        const brokenConsumerContent = `
import { api, type KanbanCardCreateInput } from './api.js';

// Error: 'nonExistentField' is not in KanbanCardCreateInput
const badInput: KanbanCardCreateInput = {
  title: 'Bad',
  repo: 'test',
  nonExistentField: 123,
};
`;
        fs.writeFileSync(consumerFile, brokenConsumerContent, 'utf-8');

        expect(() => {
            execSync(`npx tsc --project ${tsconfigFile}`, {
                stdio: 'pipe',
                encoding: 'utf-8',
            });
        }).toThrow();

        fs.rmSync(tempDir, { recursive: true, force: true });
    });
});
