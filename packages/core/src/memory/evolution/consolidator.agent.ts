import type { LLMClient } from "../../types/llm";
import type { MemoryAtom } from "../../types/memory";

export interface ConsolidatedMemory {
    title: string;
    summary: string;
    content: string;
    tags: string[];
    confidence: number;
}

function shouldRequireRealLlm(): boolean {
    const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CORTEXA_LLM_REQUIRE_REAL;
    const normalized = String(raw ?? "").trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(normalized);
}

export class ConsolidatorAgent {
    constructor(private readonly llm: LLMClient) { }

    async merge(input: { candidate: MemoryAtom; neighbors: MemoryAtom[] }): Promise<ConsolidatedMemory> {
        try {
            return await this.llm.completeJson<ConsolidatedMemory>({
                system: "Merge overlapping memory atoms.",
                user: JSON.stringify(input),
                schemaHint: "{ title, summary, content, tags, confidence }"
            });
        } catch (error) {
            if (shouldRequireRealLlm()) {
                throw error;
            }

            return {
                title: input.candidate.title,
                summary: input.candidate.summary,
                content: input.candidate.content,
                tags: [...input.candidate.tags],
                confidence: input.candidate.confidence
            };
        }
    }
}
