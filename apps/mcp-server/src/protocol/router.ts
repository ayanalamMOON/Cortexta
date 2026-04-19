import type { McpLogger } from "../logger";
import type {
    JsonRpcError,
    JsonRpcRequest,
    JsonRpcResponse,
    McpToolCallResult,
    McpToolDescriptor
} from "./types";

interface McpProtocolRouterOptions {
    serverName: string;
    serverVersion: string;
    protocolVersion: string;
    tools: McpToolDescriptor[];
    executeTool: (name: string, args: unknown) => Promise<McpToolCallResult>;
    logger: McpLogger;
}

function makeError(code: number, message: string, data?: unknown): JsonRpcError {
    return {
        code,
        message,
        data
    };
}

function response(id: JsonRpcRequest["id"], payload: { result?: unknown; error?: JsonRpcError }): JsonRpcResponse {
    return {
        jsonrpc: "2.0",
        id: id ?? null,
        ...payload
    };
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const data = value as JsonRpcRequest;
    return data.jsonrpc === "2.0" && typeof data.method === "string";
}

function ensureParamsRecord(value: unknown): Record<string, unknown> | undefined {
    if (value === undefined) {
        return {};
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    return value as Record<string, unknown>;
}

export class McpProtocolRouter {
    private initialized = false;

    private clientAcknowledged = false;

    constructor(private readonly options: McpProtocolRouterOptions) { }

    async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
        if (!isJsonRpcRequest(message)) {
            return response(null, {
                error: makeError(-32600, "Invalid Request")
            });
        }

        const isNotification = message.id === undefined;

        if (message.method === "notifications/initialized") {
            this.clientAcknowledged = true;
            this.options.logger.info("mcp.client.initialized");
            return undefined;
        }

        if (message.method === "initialize") {
            this.initialized = true;
            return response(message.id, {
                result: {
                    protocolVersion: this.options.protocolVersion,
                    capabilities: {
                        tools: {},
                        resources: {},
                        prompts: {}
                    },
                    serverInfo: {
                        name: this.options.serverName,
                        version: this.options.serverVersion
                    }
                }
            });
        }

        if (!this.initialized) {
            if (isNotification) {
                return undefined;
            }

            return response(message.id, {
                error: makeError(-32002, "Server not initialized. Call initialize first.")
            });
        }

        if (message.method === "ping") {
            if (isNotification) {
                return undefined;
            }

            return response(message.id, {
                result: {
                    ok: true,
                    initialized: this.clientAcknowledged
                }
            });
        }

        if (message.method === "tools/list") {
            if (isNotification) {
                return undefined;
            }

            return response(message.id, {
                result: {
                    tools: this.options.tools
                }
            });
        }

        if (message.method === "resources/list") {
            if (isNotification) {
                return undefined;
            }

            return response(message.id, {
                result: {
                    resources: []
                }
            });
        }

        if (message.method === "prompts/list") {
            if (isNotification) {
                return undefined;
            }

            return response(message.id, {
                result: {
                    prompts: []
                }
            });
        }

        if (message.method === "tools/call") {
            if (isNotification) {
                return undefined;
            }

            const params = ensureParamsRecord(message.params);
            if (!params) {
                return response(message.id, {
                    error: makeError(-32602, "Invalid params: expected object")
                });
            }

            const name = typeof params.name === "string" ? params.name.trim() : "";
            const args = params.arguments;
            if (!name) {
                return response(message.id, {
                    error: makeError(-32602, "Invalid params: missing tool name")
                });
            }

            const toolExists = this.options.tools.some((tool) => tool.name === name);
            if (!toolExists) {
                return response(message.id, {
                    error: makeError(-32601, `Unknown tool: ${name}`)
                });
            }

            const result = await this.options.executeTool(name, args);
            return response(message.id, {
                result
            });
        }

        if (isNotification) {
            return undefined;
        }

        return response(message.id, {
            error: makeError(-32601, `Method not found: ${message.method}`)
        });
    }
}
