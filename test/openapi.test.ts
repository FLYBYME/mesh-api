import { describe, it, expect } from 'vitest';
import { defineContract, defaultPrint, z } from '@flybyme/mesh';
import { buildOpenApiDocument } from '../src/exposure/openapi.js';
import type { ExposeEntry } from '../src/exposure/types.js';

// --- Fixture Contracts ---

const listCardsContract = defineContract({
    domain: 'kanban',
    action: 'list_cards',
    description: 'List all cards with optional status and limit filters',
    inputSchema: z.object({
        status: z.enum(['todo', 'in_progress', 'done']).optional().describe('Filter by card status'),
        limit: z.number().optional().describe('Maximum number of items'),
    }),
    outputSchema: z.object({
        cards: z.array(
            z.object({
                id: z.string(),
                title: z.string(),
                status: z.string(),
            })
        ),
    }),
    rest: { method: 'GET', path: '/kanban/cards' },
    print: defaultPrint,
});

const getCardContract = defineContract({
    domain: 'kanban',
    action: 'get_card',
    description: 'Get details of a single card by ID',
    inputSchema: z.object({
        cardId: z.string().describe('Unique card identifier'),
        includeHistory: z.boolean().optional().describe('Whether to include audit history'),
    }),
    outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        history: z.array(z.string()).optional(),
    }),
    rest: { method: 'GET', path: '/kanban/cards/:cardId' },
    print: defaultPrint,
});

const createCardContract = defineContract({
    domain: 'kanban',
    action: 'create_card',
    description: 'Create a new card on the board',
    inputSchema: z.object({
        title: z.string().describe('Title of the card'),
        repo: z.string().describe('Associated repository'),
        priority: z.number().optional(),
    }),
    outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        repo: z.string(),
    }),
    rest: { method: 'POST', path: '/kanban/cards' },
    print: defaultPrint,
    destructive: true,
});

const updateCardContract = defineContract({
    domain: 'kanban',
    action: 'update_card',
    description: 'Update an existing card',
    inputSchema: z.object({
        cardId: z.string().describe('Card ID to update'),
        title: z.string().optional(),
        status: z.string().optional(),
    }),
    outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
    }),
    rest: { method: 'PATCH', path: '/kanban/cards/:cardId' },
    print: defaultPrint,
    destructive: true,
});

const deleteCardContract = defineContract({
    domain: 'kanban',
    action: 'delete_card',
    description: 'Delete a card from the board',
    inputSchema: z.object({
        cardId: z.string().describe('Card ID to delete'),
    }),
    outputSchema: z.object({
        deleted: z.boolean(),
    }),
    rest: { method: 'DELETE', path: '/kanban/cards/:cardId' },
    print: defaultPrint,
    destructive: true,
});

const adminPurgeContract = defineContract({
    domain: 'admin',
    action: 'purge_all',
    description: 'Admin-only purge of all system entities',
    inputSchema: z.object({
        confirm: z.boolean(),
    }),
    outputSchema: z.object({
        success: z.boolean(),
    }),
    rest: { method: 'POST', path: '/admin/purge' },
    print: defaultPrint,
    destructive: true,
});

const internalUnexposedContract = defineContract({
    domain: 'internal',
    action: 'secret_info',
    description: 'Internal contract not exposed externally',
    inputSchema: z.object({}),
    outputSchema: z.object({ secret: z.string() }),
    rest: { method: 'GET', path: '/internal/secret' },
    print: defaultPrint,
});

describe('OpenAPI 3.1 Document Generation (buildOpenApiDocument)', () => {
    const exposed: ExposeEntry[] = [
        { contract: listCardsContract, auth: 'public' },
        { contract: getCardContract, auth: 'public' },
        { contract: createCardContract, auth: 'user' },
        { contract: updateCardContract, auth: 'user' },
        { contract: deleteCardContract, auth: 'user' },
        { contract: adminPurgeContract, auth: 'admin' },
        // internalUnexposedContract is omitted
    ];

    const info = {
        title: 'Kanban API',
        version: '1.0.0',
        description: 'OpenAPI specification for Kanban mesh services',
    };

    it('generates a valid OpenAPI 3.1 document with correct top-level structure', () => {
        const doc = buildOpenApiDocument(exposed, info);

        expect(doc.openapi).toBe('3.1.0');
        expect(doc.info.title).toBe('Kanban API');
        expect(doc.info.version).toBe('1.0.0');
        expect(doc.info.description).toBe('OpenAPI specification for Kanban mesh services');

        expect(doc.components.securitySchemes['sessionAuth']).toBeDefined();
        expect(doc.components.schemas['HttpError']).toBeDefined();

        // Round-trips cleanly as JSON
        const jsonStr = JSON.stringify(doc);
        const parsed = JSON.parse(jsonStr);
        expect(parsed.openapi).toBe('3.1.0');
    });

    it('does NOT include paths for unexposed contracts', () => {
        const doc = buildOpenApiDocument(exposed, info);

        expect(doc.paths['/internal/secret']).toBeUndefined();
    });

    it('maps :param path segments to OpenAPI {param} and classifies path vs query parameters on GET', () => {
        const doc = buildOpenApiDocument(exposed, info);

        const pathItem = doc.paths['/kanban/cards/{cardId}'];
        expect(pathItem).toBeDefined();

        const getOp = pathItem?.['get'];
        expect(getOp).toBeDefined();
        expect(getOp?.operationId).toBe('kanban_get_card');
        expect(getOp?.summary).toBe('kanban.get_card');
        expect(getOp?.description).toBe('Get details of a single card by ID');

        // Path parameter: cardId
        const pathParam = getOp?.parameters?.find((p) => p.name === 'cardId');
        expect(pathParam).toBeDefined();
        expect(pathParam?.in).toBe('path');
        expect(pathParam?.required).toBe(true);

        // Query parameter: includeHistory
        const queryParam = getOp?.parameters?.find((p) => p.name === 'includeHistory');
        expect(queryParam).toBeDefined();
        expect(queryParam?.in).toBe('query');
        expect(queryParam?.required).toBe(false);

        // GET request must have no request body
        expect(getOp?.requestBody).toBeUndefined();
    });

    it('places non-path input fields into requestBody for mutating operations (POST/PATCH)', () => {
        const doc = buildOpenApiDocument(exposed, info);

        // POST /kanban/cards (no path params, all input in body)
        const postOp = doc.paths['/kanban/cards']?.['post'];
        expect(postOp).toBeDefined();
        expect(postOp?.operationId).toBe('kanban_create_card');
        expect(postOp?.parameters).toBeUndefined();
        expect(postOp?.requestBody).toBeDefined();
        expect(postOp?.requestBody?.required).toBe(true);

        const schema = postOp?.requestBody?.content['application/json']?.schema;
        expect(schema).toBeDefined();
        const props = schema?.['properties'] as Record<string, unknown>;
        expect(props?.['title']).toBeDefined();
        expect(props?.['repo']).toBeDefined();
        expect(props?.['priority']).toBeDefined();
        const reqFields = schema?.['required'] as string[];
        expect(reqFields).toContain('title');
        expect(reqFields).toContain('repo');
        expect(reqFields).not.toContain('priority');

        // PATCH /kanban/cards/{cardId} (cardId in path, title/status in body)
        const patchOp = doc.paths['/kanban/cards/{cardId}']?.['patch'];
        expect(patchOp).toBeDefined();
        const patchPathParam = patchOp?.parameters?.find((p) => p.name === 'cardId');
        expect(patchPathParam).toBeDefined();
        expect(patchPathParam?.in).toBe('path');

        const patchBodySchema = patchOp?.requestBody?.content['application/json']?.schema;
        const patchProps = patchBodySchema?.['properties'] as Record<string, unknown>;
        expect(patchProps?.['title']).toBeDefined();
        expect(patchProps?.['status']).toBeDefined();
        // cardId must NOT be in body schema
        expect(patchProps?.['cardId']).toBeUndefined();
    });

    it('omits requestBody on DELETE when all parameters are in the path', () => {
        const doc = buildOpenApiDocument(exposed, info);

        const deleteOp = doc.paths['/kanban/cards/{cardId}']?.['delete'];
        expect(deleteOp).toBeDefined();
        expect(deleteOp?.parameters).toHaveLength(1);
        expect(deleteOp?.parameters?.[0]?.name).toBe('cardId');
        expect(deleteOp?.requestBody).toBeUndefined();
    });

    it('merges multiple methods on the same path into one path item object', () => {
        const doc = buildOpenApiDocument(exposed, info);

        const cardsPath = doc.paths['/kanban/cards'];
        expect(cardsPath).toBeDefined();
        expect(cardsPath?.['get']).toBeDefined();
        expect(cardsPath?.['post']).toBeDefined();

        const cardDetailPath = doc.paths['/kanban/cards/{cardId}'];
        expect(cardDetailPath).toBeDefined();
        expect(cardDetailPath?.['get']).toBeDefined();
        expect(cardDetailPath?.['patch']).toBeDefined();
        expect(cardDetailPath?.['delete']).toBeDefined();
    });

    it('reflects auth gate: public routes have security: [], user/admin routes require sessionAuth', () => {
        const doc = buildOpenApiDocument(exposed, info);

        const publicGet = doc.paths['/kanban/cards']?.['get'];
        expect(publicGet?.security).toEqual([]);

        const userPost = doc.paths['/kanban/cards']?.['post'];
        expect(userPost?.security).toEqual([{ sessionAuth: [] }]);

        const adminPost = doc.paths['/admin/purge']?.['post'];
        expect(adminPost?.security).toEqual([{ sessionAuth: [] }]);
    });

    it('surfaces destructive contracts with x-destructive: true', () => {
        const doc = buildOpenApiDocument(exposed, info);

        const createOp = doc.paths['/kanban/cards']?.['post'];
        expect(createOp?.['x-destructive']).toBe(true);

        const purgeOp = doc.paths['/admin/purge']?.['post'];
        expect(purgeOp?.['x-destructive']).toBe(true);

        const listOp = doc.paths['/kanban/cards']?.['get'];
        expect(listOp?.['x-destructive']).toBeUndefined();
    });

    it('includes standard response schemas: 200 output schema and 4xx/5xx HttpError refs', () => {
        const doc = buildOpenApiDocument(exposed, info);

        const postOp = doc.paths['/kanban/cards']?.['post'];
        expect(postOp?.responses['200']).toBeDefined();
        expect(postOp?.responses['400']).toEqual({
            description: 'Bad Request',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HttpError' } } },
        });
        expect(postOp?.responses['401']).toEqual({
            description: 'Authentication required',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HttpError' } } },
        });
        expect(postOp?.responses['500']).toEqual({
            description: 'Internal Server Error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HttpError' } } },
        });

        // Admin route has 403 Forbidden
        const adminOp = doc.paths['/admin/purge']?.['post'];
        expect(adminOp?.responses['403']).toBeDefined();
    });
});
