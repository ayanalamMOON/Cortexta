import { normalizeMcpCtx, type McpCtxEnvelope } from "./schema";

export interface EncodeOptions {
    pretty?: boolean;
}

export function encodeMcpCtx(input: McpCtxEnvelope, options: EncodeOptions = {}): string {
    const normalized = normalizeMcpCtx(input);
    return JSON.stringify(normalized, null, options.pretty === false ? 0 : 2);
}
