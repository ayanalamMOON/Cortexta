export interface McpCtxEnvelope {
    version?: "1.0";
    createdAt?: number;
    intent: string;
    scope: string;
    concepts: string[];
    entities: string[];
    constraints: string[];
    metadata?: Record<string, unknown>;
}

export function normalizeMcpCtx(input: McpCtxEnvelope): McpCtxEnvelope {
    return {
        version: "1.0",
        createdAt: input.createdAt ?? Date.now(),
        intent: input.intent.trim(),
        scope: input.scope.trim(),
        concepts: [...new Set(input.concepts.map((v) => v.trim()).filter(Boolean))],
        entities: [...new Set(input.entities.map((v) => v.trim()).filter(Boolean))],
        constraints: [...new Set(input.constraints.map((v) => v.trim()).filter(Boolean))],
        metadata: input.metadata ?? {}
    };
}

export function isMcpCtxEnvelope(value: unknown): value is McpCtxEnvelope {
    if (!value || typeof value !== "object") return false;
    const data = value as McpCtxEnvelope;
    return (
        typeof data.intent === "string" &&
        typeof data.scope === "string" &&
        Array.isArray(data.concepts) &&
        Array.isArray(data.entities) &&
        Array.isArray(data.constraints)
    );
}
