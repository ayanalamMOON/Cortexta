import type { LLMClient } from "../../types/llm";
import type { MemoryAtom } from "../../types/memory";

export interface WriterOutput {
    candidates: Array<Pick<MemoryAtom, "kind" | "title" | "summary" | "content" | "tags" | "sourceRef">>;
}

export class WriterAgent {
    constructor(private readonly llm: LLMClient) { }

    async propose(input: { text: string; projectId: string; context?: string }): Promise<WriterOutput> {
        const fallback: WriterOutput = {
            candidates: [
                {
                    kind: "semantic",
                    title: "Generated Memory",
                    summary: input.text.slice(0, 120),
                    content: input.text,
                    tags: ["auto-generated"],
                    sourceRef: input.projectId
                }
            ]
        };

        try {
            return await this.llm.completeJson<WriterOutput>({
                system: "Generate candidate memory atoms.",
                user: JSON.stringify(input),
                schemaHint: "{ candidates: [{ kind, title, summary, content, tags, sourceRef }] }"
            });
        } catch {
            return fallback;
        }
    }
}
