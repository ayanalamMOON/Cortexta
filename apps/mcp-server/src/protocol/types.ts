export type JsonRpcId = string | number | null;

export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}

export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: JsonRpcId;
    method: string;
    params?: unknown;
}

export interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result?: unknown;
    error?: JsonRpcError;
}

export interface McpToolDescriptor {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}
