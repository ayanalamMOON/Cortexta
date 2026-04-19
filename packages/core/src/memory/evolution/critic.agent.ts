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

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function computeFallbackReview(input: {
    title: string;
    summary: string;
    existingSnippets?: string[];
}): CriticOutput {
    const title = input.title.trim();
    const summary = input.summary.trim();
    const body = `${title}\n${summary}`.trim();

    if (!body) {
        return {
            accepted: false,
            score: 0,
            novelty: 0,
            redundancy: 1,
            clarity: 0,
            action: "reject",
            reason: "empty-candidate"
        };
    }

    const existing = (input.existingSnippets ?? []).map((snippet) => snippet.trim()).filter(Boolean);
    const loweredBody = body.toLowerCase();

    const overlap = existing.filter((snippet) => loweredBody.includes(snippet.toLowerCase())).length;
    const novelty = clamp01(1 - overlap / Math.max(1, existing.length));
    const redundancy = clamp01(1 - novelty);

    const punctuationScore = clamp01((body.match(/[.;:!?]/g)?.length ?? 0) / 5);
    const lengthScore = clamp01(body.length / 320);
    const clarity = clamp01(lengthScore * 0.7 + punctuationScore * 0.3);
    const score = clamp01(novelty * 0.62 + clarity * 0.38);

    const action: CriticOutput["action"] =
        score >= 0.8 ? "merge" : score >= 0.6 ? "store" : score >= 0.42 ? "compress" : "reject";

    return {
        accepted: action !== "reject",
        score,
        novelty,
        redundancy,
        clarity,
        action,
        reason: action === "reject" ? "low-signal" : "fallback-heuristic",
        mergeKey: action === "merge" ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-") : undefined
    };
}

function normalizeReview(output: Partial<CriticOutput>, fallback: CriticOutput): CriticOutput {
    const action: CriticOutput["action"] =
        output.action === "store" || output.action === "merge" || output.action === "reject" || output.action === "compress"
            ? output.action
            : fallback.action;

    const score = clamp01(Number(output.score ?? fallback.score));
    const novelty = clamp01(Number(output.novelty ?? fallback.novelty));
    const redundancy = clamp01(Number(output.redundancy ?? fallback.redundancy));
    const clarity = clamp01(Number(output.clarity ?? fallback.clarity));
    const accepted = typeof output.accepted === "boolean" ? output.accepted : action !== "reject";

    return {
        accepted,
        score,
        novelty,
        redundancy,
        clarity,
        action,
        reason: String(output.reason ?? fallback.reason),
        mergeKey: output.mergeKey ? String(output.mergeKey) : fallback.mergeKey
    };
}

export class CriticAgent {
    constructor(private readonly llm: LLMClient) { }

    async review(candidate: {
        title: string;
        summary: string;
        existingSnippets?: string[];
    }): Promise<CriticOutput> {
        const fallback = computeFallbackReview(candidate);

        try {
            const output = await this.llm.completeJson<CriticOutput>({
                system: "Evaluate memory candidate quality.",
                user: JSON.stringify(candidate),
                schemaHint: "{ accepted, score, novelty, redundancy, clarity, action, reason, mergeKey? }"
            });

            return normalizeReview(output, fallback);
        } catch {
            return fallback;
        }
    }
}
