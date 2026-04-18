import type { LLMClient } from "../../types/llm";
import type { MemoryAtom } from "../../types/memory";

export interface ConsolidatedMemory {
    title: string;
    summary: string;
    content: string;
    tags: string[];
    confidence: number;
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
        } catch {
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
