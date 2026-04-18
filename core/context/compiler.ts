import type { ScoredMemory } from "../mempalace/memory.types";
import { retrieveTopK } from "../retrieval/retriever";
import { compressContextText, compressSummary } from "./compressor";
import { formatContext } from "./formatter";
import { estimateTokens, packContextParts } from "./packer";

export interface CompileContextOptions {
    projectId?: string;
    maxTokens?: number;
    topK?: number;
    constraints?: string[];
    scope?: string;
}

export interface CompiledContextResult {
    query: string;
    context: string;
    tokenEstimate: number;
    memoriesUsed: number;
    dropped: number;
    memories: ScoredMemory[];
}

export async function compileContext(
    query: string,
    options: CompileContextOptions = {}
): Promise<CompiledContextResult> {
    const maxTokens = options.maxTokens ?? 4000;
    const topK = options.topK ?? 12;

    const retrieved = await retrieveTopK(query, {
        projectId: options.projectId,
        topK,
        minScore: 0
    });

    const condensed = retrieved.map((memory) => ({
        ...memory,
        summary: compressSummary(memory.summary),
        content: compressSummary(memory.copilotContent ?? memory.content, 280)
    }));

    const parts = condensed.map(
        (memory) =>
            `[${memory.kind}] ${memory.title}\nsummary: ${memory.summary}\nimportance: ${memory.importance.toFixed(2)} confidence: ${memory.confidence.toFixed(2)}`
    );

    const packed = packContextParts(parts, Math.max(256, maxTokens - 300));
    const used = condensed.slice(0, packed.packed.length);

    const formatted = formatContext(query, used, {
        scope: options.scope,
        constraints: options.constraints,
        includeScores: true
    });

    const context = compressContextText(formatted);
    const tokenEstimate = estimateTokens(context);

    return {
        query,
        context,
        tokenEstimate,
        memoriesUsed: used.length,
        dropped: Math.max(0, condensed.length - used.length),
        memories: used
    };
}
