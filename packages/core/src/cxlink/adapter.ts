import type { CompiledContext } from "../types/context";

export interface PromptEnvelopeOptions {
    systemGuidance?: string;
    includeTokenStats?: boolean;
}

export function buildPromptEnvelope(query: string, ctx: CompiledContext, options: PromptEnvelopeOptions = {}): string {
    const parts = [
        options.systemGuidance ? `[SYSTEM]\n${options.systemGuidance}` : "",
        ctx.rendered,
        options.includeTokenStats ? `\n[CONTEXT_STATS]\ntokens=${ctx.tokens} atoms=${ctx.atoms.length} dropped=${ctx.dropped.length}` : "",
        "\n[USER_QUERY]",
        query.trim()
    ];

    return parts.filter(Boolean).join("\n\n");
}
