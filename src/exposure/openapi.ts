import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ExposeEntry } from './types.js';

export interface OpenApiInfo {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
}

export interface OpenApiParameter {
    readonly name: string;
    readonly in: 'path' | 'query' | 'header' | 'cookie';
    readonly required: boolean;
    readonly schema: Record<string, unknown>;
    readonly description?: string;
}

export interface OpenApiRequestBody {
    readonly required: boolean;
    readonly content: {
        readonly 'application/json': {
            readonly schema: Record<string, unknown>;
        };
    };
}

export interface OpenApiOperation {
    readonly operationId: string;
    readonly summary: string;
    readonly description: string;
    readonly tags: readonly string[];
    readonly 'x-destructive'?: boolean;
    readonly security: readonly (Record<string, readonly string[]>)[];
    readonly parameters?: readonly OpenApiParameter[];
    readonly requestBody?: OpenApiRequestBody;
    readonly responses: Record<string, unknown>;
}

export interface OpenApiDocument {
    readonly openapi: '3.1.0';
    readonly info: OpenApiInfo;
    readonly paths: Record<string, Record<string, OpenApiOperation>>;
    readonly components: {
        readonly securitySchemes: Record<string, unknown>;
        readonly schemas: Record<string, unknown>;
    };
}

function isRecord(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function getObjectProperties(schema: unknown): Record<string, Record<string, unknown>> {
    if (!isRecord(schema)) return {};
    const props = schema['properties'];
    if (!isRecord(props)) return {};
    const result: Record<string, Record<string, unknown>> = {};
    for (const [key, val] of Object.entries(props)) {
        if (isRecord(val)) {
            result[key] = val;
        }
    }
    return result;
}

function getRequiredFields(schema: unknown): string[] {
    if (!isRecord(schema)) return [];
    const req = schema['required'];
    if (!Array.isArray(req)) return [];
    return req.filter((item): item is string => typeof item === 'string');
}

/**
 * buildOpenApiDocument: produces an OpenAPI 3.1 document for the exposed contract set.
 *
 * Schemas are converted via zod-to-json-schema. Path segments with `:param` become
 * OpenAPI `{param}` path parameters; on GET operations remaining input fields become
 * query parameters, while on mutating operations they become the JSON request body.
 */
export function buildOpenApiDocument(
    exposed: readonly ExposeEntry[],
    info: OpenApiInfo
): OpenApiDocument {
    const paths: Record<string, Record<string, OpenApiOperation>> = {};

    for (const entry of exposed) {
        const { contract } = entry;
        const pathMatches = contract.rest.path.match(/:([a-zA-Z0-9_]+)/g);
        const pathParamNames = pathMatches ? pathMatches.map(p => p.slice(1)) : [];
        const openApiPath = contract.rest.path.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');

        const inputSchemaJson = zodToJsonSchema(contract.inputSchema, { target: 'openApi3' });
        const properties = getObjectProperties(inputSchemaJson);
        const requiredFields = getRequiredFields(inputSchemaJson);

        const parameters: OpenApiParameter[] = [];

        // Path parameters (always required in OpenAPI 3.1)
        for (const paramName of pathParamNames) {
            const propSchema = properties[paramName] ?? { type: 'string' };
            const desc = typeof propSchema['description'] === 'string' ? propSchema['description'] : undefined;
            parameters.push({
                name: paramName,
                in: 'path',
                required: true,
                schema: propSchema,
                ...(desc ? { description: desc } : {}),
            });
        }

        // Query parameters for GET requests
        if (contract.rest.method === 'GET') {
            for (const [key, propSchema] of Object.entries(properties)) {
                if (pathParamNames.includes(key)) continue;
                const isReq = requiredFields.includes(key);
                const desc = typeof propSchema['description'] === 'string' ? propSchema['description'] : undefined;
                parameters.push({
                    name: key,
                    in: 'query',
                    required: isReq,
                    schema: propSchema,
                    ...(desc ? { description: desc } : {}),
                });
            }
        }

        // Request body for non-GET requests
        let requestBody: OpenApiRequestBody | undefined = undefined;
        if (contract.rest.method !== 'GET') {
            const bodyProps: Record<string, unknown> = {};
            const bodyRequired: string[] = [];
            for (const [key, propSchema] of Object.entries(properties)) {
                if (pathParamNames.includes(key)) continue;
                bodyProps[key] = propSchema;
                if (requiredFields.includes(key)) {
                    bodyRequired.push(key);
                }
            }
            if (Object.keys(bodyProps).length > 0) {
                requestBody = {
                    required: bodyRequired.length > 0,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: bodyProps,
                                ...(bodyRequired.length > 0 ? { required: bodyRequired } : {}),
                                additionalProperties: false,
                            },
                        },
                    },
                };
            }
        }

        const outputSchemaJson = zodToJsonSchema(contract.outputSchema, { target: 'openApi3' });

        const responses: Record<string, unknown> = {
            '200': {
                description: 'Successful response',
                content: {
                    'application/json': {
                        schema: outputSchemaJson,
                    },
                },
            },
            '400': {
                description: 'Bad Request',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/HttpError' },
                    },
                },
            },
        };

        if (entry.auth === 'user' || entry.auth === 'admin') {
            responses['401'] = {
                description: 'Authentication required',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/HttpError' },
                    },
                },
            };
        }

        if (entry.auth === 'admin') {
            responses['403'] = {
                description: 'Forbidden',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/HttpError' },
                    },
                },
            };
        }

        responses['500'] = {
            description: 'Internal Server Error',
            content: {
                'application/json': {
                    schema: { $ref: '#/components/schemas/HttpError' },
                },
            },
        };

        const methodLower = contract.rest.method.toLowerCase();
        const operation: OpenApiOperation = {
            operationId: `${contract.domain}_${contract.action}`,
            summary: `${contract.domain}.${contract.action}`,
            description: contract.description,
            tags: [contract.domain],
            ...(contract.destructive !== undefined ? { 'x-destructive': contract.destructive } : {}),
            security: entry.auth === 'public' ? [] : [{ sessionAuth: [] }],
            ...(parameters.length > 0 ? { parameters } : {}),
            ...(requestBody ? { requestBody } : {}),
            responses,
        };

        if (!paths[openApiPath]) {
            paths[openApiPath] = {};
        }
        paths[openApiPath][methodLower] = operation;
    }

    return {
        openapi: '3.1.0',
        info: {
            title: info.title,
            version: info.version,
            ...(info.description ? { description: info.description } : {}),
        },
        paths,
        components: {
            securitySchemes: {
                sessionAuth: {
                    type: 'apiKey',
                    in: 'cookie',
                    name: 'mesh_sid',
                    description: 'Session cookie authentication (mesh_sid)',
                },
            },
            schemas: {
                HttpError: {
                    type: 'object',
                    properties: {
                        error: {
                            type: 'object',
                            properties: {
                                code: { type: 'string' },
                                message: { type: 'string' },
                            },
                            required: ['code', 'message'],
                            additionalProperties: false,
                        },
                    },
                    required: ['error'],
                    additionalProperties: false,
                },
            },
        },
    };
}
