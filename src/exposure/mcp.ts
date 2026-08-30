import type { ExposureBroker } from './broker.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { toolKey } from '@flybyme/mesh';
import type { ExposeEntry } from './types.js';
import { objectShapeOf } from './input.js';
import { executeGate, validateExposeEntry } from '../auth/gate.js';
import type { SessionRecord, AuthorizeHook } from '../auth/types.js';

/**
 * Metadata describing the MCP server implementation.
 */
export interface McpServerInfo {
    readonly name: string;
    readonly version: string;
    readonly description?: string;
}

/**
 * Accessor function resolving the caller's session for an MCP tool execution.
 */
export type McpSessionAccessor = (extra?: unknown) => SessionRecord | undefined | Promise<SessionRecord | undefined>;

/**
 * Options configuring MCP server behavior.
 */
export interface McpServerOptions {
    /**
     * Session record or accessor function providing caller identity.
     * Transport-level auth for MCP is unresolved, so caller identity is
     * passed here to enforce the same checkAuth gate as REST.
     */
    readonly session?: SessionRecord | McpSessionAccessor;
    /**
     * Optional authorization hook for fine-grained permission resolution.
     */
    readonly authorize?: AuthorizeHook;
}

/**
 * buildMcpServer: projects the exposed ToolContracts into an McpServer instance.
 *
 * One MCP tool per exposed contract, named `<domain>.<action>`. Contracts not in
 * the expose list are unreachable. Input validation uses the contract's own Zod
 * shape via objectShapeOf; contracts with non-object input schemas throw at build
 * time so the error is caught at startup rather than on call.
 */
export function buildMcpServer(
    broker: ExposureBroker,
    exposed: readonly ExposeEntry[],
    info: McpServerInfo,
    options?: McpServerOptions
): McpServer {
    const server = new McpServer(info);

    for (const entry of exposed) {
        validateExposeEntry(entry);
        const { contract } = entry;
        const toolName = toolKey(contract);

        const shape = objectShapeOf(contract.inputSchema);
        if (!shape) {
            throw new Error(`[mcp] contract '${toolName}' inputSchema must be an object schema to expose over MCP`);
        }

        const annotations: ToolAnnotations = {};
        if (contract.destructive !== undefined) {
            annotations.destructiveHint = contract.destructive;
            annotations.readOnlyHint = !contract.destructive;
        }

        server.registerTool(
            toolName,
            {
                title: toolName,
                description: contract.description,
                inputSchema: shape,
                ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
            },
            async (args: Record<string, unknown>, extra: unknown) => {
                const session = typeof options?.session === 'function'
                    ? await options.session(extra)
                    : options?.session;

                const gateResult = await executeGate(entry, session, args, options?.authorize);

                const user = session?.user;
                const effectiveTenantId = gateResult.resolvedScope ?? user?.tenant_id;
                const meta = {
                    ...(user ? {
                        user: {
                            ...user,
                            id: user.id,
                            tenant_id: effectiveTenantId ?? user.tenant_id,
                            ...(user.roles ? { roles: [...user.roles] } : {}),
                        },
                    } : {}),
                    ...(gateResult.extraMeta ?? {}),
                };
                const result = await broker.call(toolName, args, { meta });

                const text = contract.print ? contract.print(result) : JSON.stringify(result, null, 2);
                const contentBlock: { type: 'text'; text: string } = {
                    type: 'text',
                    text,
                };
                return {
                    content: [contentBlock],
                };
            }
        );
    }

    return server;
}
