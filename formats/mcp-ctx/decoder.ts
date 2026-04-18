import { isMcpCtxEnvelope, normalizeMcpCtx, type McpCtxEnvelope } from "./schema";

export function decodeMcpCtx(raw: string): McpCtxEnvelope {
    const parsed = JSON.parse(raw) as unknown;
    if (!isMcpCtxEnvelope(parsed)) {
        throw new Error("Invalid MCP context payload shape.");
    }
    return normalizeMcpCtx(parsed);
}
