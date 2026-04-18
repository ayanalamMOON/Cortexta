export interface CriticResult {
    accepted: boolean;
    score: number;
    novelty: number;
    clarity: number;
    reason: string;
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

export function criticAgent(candidate: string, existingSnippets: string[] = []): CriticResult {
    const clean = candidate.trim();
    if (!clean) {
        return {
            accepted: false,
            score: 0,
            novelty: 0,
            clarity: 0,
            reason: "empty-candidate"
        };
    }

    const lengthScore = clamp01(clean.length / 350);
    const punctuationScore = clamp01((clean.match(/[.;:!?]/g)?.length ?? 0) / 6);

    const overlapCount = existingSnippets.filter((snippet) => clean.toLowerCase().includes(snippet.toLowerCase())).length;
    const novelty = clamp01(1 - overlapCount / Math.max(1, existingSnippets.length));
    const clarity = clamp01(lengthScore * 0.65 + punctuationScore * 0.35);
    const score = clamp01(novelty * 0.6 + clarity * 0.4);

    return {
        accepted: score >= 0.35,
        score,
        novelty,
        clarity,
        reason: score >= 0.35 ? "accepted-by-heuristic" : "low-signal"
    };
}
