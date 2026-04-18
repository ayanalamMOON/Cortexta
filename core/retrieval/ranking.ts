import type { ScoredMemory } from "../mempalace/memory.types";
import { hybridScore } from "../scoring/hybrid.score";

export function rankMemories(rows: ScoredMemory[], now = Date.now()): ScoredMemory[] {
    const rescored = rows.map((row) => {
        const ageMs = Math.max(0, now - row.lastAccessedAt);
        return {
            ...row,
            score: hybridScore(row.similarity, row.importance, ageMs)
        };
    });

    return rescored.sort((a, b) => b.score - a.score);
}
