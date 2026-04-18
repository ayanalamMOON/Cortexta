import type { LLMClient } from "../../types/llm";

export interface CriticOutput {
    accepted: boolean;
    score: number;
    novelty: number;
    redundancy: number;
    clarity: number;
    action: "store" | "merge" | "reject" | "compress";
    reason: string;
    mergeKey?: string;
}

export class CriticAgent {
    constructor(private readonly llm: LLMClient) { }

    async review(candidate: {
        title: string;
        summary: string;
        existingSnippets?: string[];
    }): Promise<CriticOutput> {
        try {
            return await this.llm.completeJson<CriticOutput>({
                system: "Evaluate memory candidate quality.",
                user: JSON.stringify(candidate),
                schemaHint: "{ accepted, score, novelty, redundancy, clarity, action, reason, mergeKey? }"
            });
        } catch {
            return {
                accepted: true,
                score: 0.7,
                novelty: 0.7,
                redundancy: 0.2,
                clarity: 0.8,
                action: "store",
                reason: "fallback-policy"
            };
        }
    }
}
